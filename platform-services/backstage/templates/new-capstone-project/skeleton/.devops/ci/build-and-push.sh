#!/usr/bin/env bash
# Phase-1 local CI: build the app image and push it to the k3d built-in registry
# (D-005, ADR-005, §4.1). The tag is computed from promotion.yaml per the target
# environment's convention — promotion.yaml is the single source of truth, so the
# tag scheme changes in one place. Prints the resulting IMAGE ref for the bump step.
#
# Phase 2 swaps this local docker build+push for GitHub Actions + Harbor but keeps
# the SAME seam: only `registry` (in promotion.yaml) and the trigger change.
#
# Usage:
#   build-and-push.sh <env>            # env in: preview|dev|staging|prod
#   build-and-push.sh dev              # tag from promotion.yaml dev tagConvention (sha-<short>)
#   SEMVER=1.2.3 build-and-push.sh staging
#   SHA=abc1234  build-and-push.sh preview
#
# tagConvention values resolved from promotion.yaml (schema apiVersion platform.capstone/v1):
#   sha-<short> -> the short git sha            (override with SHA=)
#   pull-<sha>  -> "pull-" + short git sha      (override with SHA=)
#   semver      -> the provided semver          (required for staging/prod; set SEMVER=)
set -euo pipefail

ENV="${1:-}"
if [ -z "${ENV}" ]; then
  echo "usage: $0 <preview|dev|staging|prod>" >&2
  exit 2
fi

# Resolve repo paths relative to this script so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVOPS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"        # team-sample-app/.devops
REPO_DIR="$(cd "${DEVOPS_DIR}/.." && pwd)"          # team-sample-app
PROMOTION="${DEVOPS_DIR}/promotion.yaml"
BUILD_CONTEXT="${BUILD_CONTEXT:-${REPO_DIR}/app}"

[ -f "${PROMOTION}" ] || { echo "promotion.yaml not found at ${PROMOTION}" >&2; exit 1; }

# Read the promotion contract (single source of truth, §4.1, schema v1).
REGISTRY="$(yq -r '.registry' "${PROMOTION}")"
APP="$(yq -r '.app' "${PROMOTION}")"
TAG_CONV="$(yq -r ".environments.${ENV}.tagConvention" "${PROMOTION}")"
if [ -z "${TAG_CONV}" ] || [ "${TAG_CONV}" = "null" ]; then
  echo "no tagConvention for env '${ENV}' in promotion.yaml" >&2
  exit 1
fi

# Resolve a named tagConvention into the concrete image tag.
git_short() { echo "${SHA:-$(git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null || echo local)}"; }
resolve_tag() {
  case "$1" in
    "sha-<short>") git_short ;;
    "pull-<sha>")  echo "pull-$(git_short)" ;;
    "semver")
      [ -n "${SEMVER:-}" ] || { echo "env '${ENV}' tagConvention 'semver' needs SEMVER=X.Y.Z" >&2; exit 1; }
      echo "${SEMVER}"
      ;;
    *) echo "unknown tagConvention '$1' for env '${ENV}'" >&2; exit 1 ;;
  esac
}

TAG="$(resolve_tag "${TAG_CONV}")"
IMAGE="${REGISTRY}/${APP}:${TAG}"

echo "==> building ${IMAGE}"
echo "    context: ${BUILD_CONTEXT}  env: ${ENV}  tagConvention: ${TAG_CONV}"
docker build -t "${IMAGE}" "${BUILD_CONTEXT}"

echo "==> pushing ${IMAGE}"
# Note: requires 'k3d-registry.localhost' to resolve to 127.0.0.1 on the host
# (make cluster-up adds the /etc/hosts entry). Don't hard-fail on a missing
# entry beyond docker's own error — surface push failures verbatim.
docker push "${IMAGE}"

# The seam output: the bump step consumes IMAGE=/TAG= to rewrite the overlay.
echo "IMAGE=${IMAGE}"
echo "TAG=${TAG}"
echo "ENV=${ENV}"
