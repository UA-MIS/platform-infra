#!/usr/bin/env bash
# Image-bump seam (§4.1, D-005) — MULTI-COMPONENT variant. Write a new image tag into
# the target overlay's kustomize images[].newTag and commit it to git. That commit is
# the "new image" signal to GitOps — ArgoCD sees the changed overlay and syncs the new
# image(s) into the env's namespace.
#
# DIFFERENCE FROM THE SINGLE-COMPONENT bump-image.sh:
#   - A multi-component overlay has ONE images[] entry PER COMPONENT (myapp-frontend,
#     myapp-backend, …). All components share the SAME tag (one repo, one git event),
#     so this sets newTag on EVERY images[] entry — no per-component recomputation.
#   - It does NOT select by a hardcoded name. (The single-component script selected
#     `.name == "sample"`, which silently matched NOTHING in a real tenant whose entry
#     is named `<appName>` — a no-op dev bump. Setting every entry fixes that for the
#     single case too, and is the only correct behaviour for N components.)
#
# Driven entirely by promotion.yaml (the env->overlay mapping lives there), so changing
# which overlay an env writes to is a one-file edit.
#
# Usage:
#   bump-image.sh <env> <tag>            # set every images[].newTag for <env> to <tag>
#   bump-image.sh dev v1.0.0-3-gabc123
#   bump-image.sh staging 1.2.3
#   COMMIT=1 bump-image.sh dev <tag>     # also git-commit the change (the GitOps signal)
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

# Resolve env -> overlay from the promotion contract (schema v1: `overlay` is a
# repo-relative path, e.g. .devops/chart/overlays/dev). Prefer yq; sed fallback for the
# nested scalar so this works on a bare runner with no yq.
read_overlay() {
  if command -v yq >/dev/null 2>&1; then
    yq -r ".environments.${ENV}.overlay" "${PROMOTION}"
  else
    # Find the env block, then its first `overlay:` line. Flat 2/4-space schema v1.
    awk -v env="${ENV}" '
      $0 ~ "^[[:space:]]+" env ":[[:space:]]*$" { inblk=1; next }
      inblk && /^[[:space:]]+[a-z]+:[[:space:]]*$/ && $0 !~ "^[[:space:]]{6,}" { inblk=0 }
      inblk && /overlay:/ { sub(/^[^:]*:[[:space:]]*/, ""); sub(/[[:space:]]*#.*$/, ""); gsub(/^[ \t]+|[ \t]+$|"/, ""); print; exit }
    ' "${PROMOTION}"
  fi
}
OVERLAY_PATH="$(read_overlay)"
if [ -z "${OVERLAY_PATH}" ] || [ "${OVERLAY_PATH}" = "null" ]; then
  echo "no overlay mapping for env '${ENV}' in promotion.yaml" >&2
  exit 1
fi

KUSTOMIZATION="${REPO_DIR}/${OVERLAY_PATH}/kustomization.yaml"
[ -f "${KUSTOMIZATION}" ] || { echo "overlay kustomization not found: ${KUSTOMIZATION}" >&2; exit 1; }

echo "==> bumping ${ENV} overlay (${OVERLAY_PATH}) — every images[].newTag -> ${NEW_TAG}"

# Set newTag on EVERY images[] entry (all components share the tag). yq-preferred;
# sed fallback rewrites each `newTag:` line (the overlay's only newTag lines are under
# images[], and image tags are [A-Za-z0-9._-] with no '|', so the sed is safe).
if command -v yq >/dev/null 2>&1; then
  NEW_TAG="${NEW_TAG}" yq -i '(.images[].newTag) = strenv(NEW_TAG)' "${KUSTOMIZATION}"
else
  sed -i "s|^\([[:space:]]*newTag:[[:space:]]*\).*\$|\1${NEW_TAG}|" "${KUSTOMIZATION}"
fi

echo "==> overlay now pins:"
if command -v yq >/dev/null 2>&1; then yq '.images' "${KUSTOMIZATION}"; else grep -E 'newName:|newTag:' "${KUSTOMIZATION}"; fi

# The GitOps signal: commit the overlay change so ArgoCD reconciles it.
# NOTE the `[skip ci]` in the commit message: when the CI bump job (build-and-push.yaml,
# push-to-main) runs this with COMMIT=1, the resulting commit must NOT re-trigger
# build-and-push (which is `on: push: branches: [main]`) — otherwise every build bumps
# the overlay, which pushes a commit, which triggers another build = an infinite loop.
# GitHub Actions skips a workflow run when the head commit message contains `[skip ci]`.
# (Harmless for the local/manual path — it's just a commit-message tag.)
if [ "${COMMIT:-0}" = "1" ]; then
  echo "==> committing bump (GitOps signal)"
  git -C "${REPO_DIR}" add "${KUSTOMIZATION}"
  git -C "${REPO_DIR}" commit -m "ci: bump ${ENV} images to ${NEW_TAG} [skip ci]" \
    && echo "committed. ArgoCD will sync ${ENV} on next reconcile." \
    || echo "nothing to commit (tag unchanged)."
else
  echo "==> not committing (set COMMIT=1 to emit the GitOps signal)."
fi
