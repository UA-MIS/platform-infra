#!/usr/bin/env bash
# Phase-1 image-bump seam (§4.1, D-005): write a new image tag into the target
# overlay's kustomize images[].newTag and commit it to git. That commit is the
# "new image" signal to GitOps — ArgoCD sees the changed overlay and syncs the
# new image into the env's namespace.
#
# Driven entirely by promotion.yaml (the env->overlay mapping lives there), so
# changing which overlay an env writes to is a one-file edit. Phase 2 keeps this
# exact seam; only the trigger (Actions) and registry change.
#
# Usage:
#   bump-image.sh <env> <tag>          # set overlay for <env> to <tag>
#   bump-image.sh dev abc1234
#   bump-image.sh staging 1.2.3
#   COMMIT=1 bump-image.sh dev abc1234 # also git-commit the change (the GitOps signal)
set -euo pipefail

ENV="${1:-}"
NEW_TAG="${2:-}"
if [ -z "${ENV}" ] || [ -z "${NEW_TAG}" ]; then
  echo "usage: $0 <preview|dev|staging|prod> <tag>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVOPS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${DEVOPS_DIR}/.." && pwd)"
PROMOTION="${DEVOPS_DIR}/promotion.yaml"

[ -f "${PROMOTION}" ] || { echo "promotion.yaml not found at ${PROMOTION}" >&2; exit 1; }

# Resolve env -> overlay and the expected image name from the promotion contract.
# In schema v1 `overlay` is a repo-relative path (e.g. .devops/chart/overlays/dev).
OVERLAY_PATH="$(yq -r ".environments.${ENV}.overlay" "${PROMOTION}")"
REGISTRY="$(yq -r '.registry' "${PROMOTION}")"
APP="$(yq -r '.app' "${PROMOTION}")"
if [ -z "${OVERLAY_PATH}" ] || [ "${OVERLAY_PATH}" = "null" ]; then
  echo "no overlay mapping for env '${ENV}' in promotion.yaml" >&2
  exit 1
fi

KUSTOMIZATION="${REPO_DIR}/${OVERLAY_PATH}/kustomization.yaml"
[ -f "${KUSTOMIZATION}" ] || { echo "overlay kustomization not found: ${KUSTOMIZATION}" >&2; exit 1; }

EXPECTED_NEWNAME="${REGISTRY}/${APP}"

echo "==> bumping ${ENV} overlay (${OVERLAY_PATH}) image tag -> ${NEW_TAG}"

# Rewrite the images[] entry whose .name is the app (from promotion.yaml `app`): keep
# newName aligned to the registry and set newTag. The selector MUST key on ${APP} — the
# overlay's image .name is the scaffolded app name (e.g. v1check), NOT a literal "sample"
# — or a non-sample app silently matches nothing and the tag is never rewritten.
NEW_TAG="${NEW_TAG}" EXPECTED_NEWNAME="${EXPECTED_NEWNAME}" APP="${APP}" yq -i '
  (.images[] | select(.name == strenv(APP)) | .newTag) = strenv(NEW_TAG)
  | (.images[] | select(.name == strenv(APP)) | .newName) = strenv(EXPECTED_NEWNAME)
' "${KUSTOMIZATION}"

echo "==> overlay now pins:"
yq '.images' "${KUSTOMIZATION}"

# The GitOps signal: commit the overlay change so ArgoCD reconciles it.
# NOTE the `[skip ci]` in the commit message: when the CI bump job (build-and-push.yaml,
# push-to-main) runs this with COMMIT=1, the resulting commit must NOT re-trigger
# build-and-push (which is `on: push: branches: [main]`) — otherwise every build bumps
# the overlay, which pushes a commit, which triggers another build = an infinite loop.
# GitHub Actions skips a workflow run when the head commit message contains `[skip ci]`.
# (Harmless for the local/manual path — it's just a commit-message tag.)
if [ "${COMMIT:-0}" = "1" ]; then
  echo "==> committing bump (GitOps signal)"
  # CI ownership guard: GitHub Actions checks out the repo as a different owner (uid)
  # than the user this job's git runs as, so git refuses to touch it ("fatal: detected
  # dubious ownership", exit 128) and the bump silently never commits. Mark the repo dir
  # safe. safe.directory MUST live in global/system config — git deliberately ignores it
  # from a repo-local config — so we set it --global (the CI container is ephemeral).
  # Scoped to GitHub Actions so a local COMMIT=1 run never appends to the developer's
  # own ~/.gitconfig (locally the owner already matches, so the guard isn't needed).
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    git config --global --add safe.directory "${REPO_DIR}"
  fi
  git -C "${REPO_DIR}" add "${KUSTOMIZATION}"
  git -C "${REPO_DIR}" commit -m "ci: bump ${ENV} image to ${NEW_TAG} [skip ci]" \
    && echo "committed. ArgoCD will sync ${ENV} on next reconcile." \
    || echo "nothing to commit (tag unchanged)."
else
  echo "==> not committing (set COMMIT=1 to emit the GitOps signal)."
fi
