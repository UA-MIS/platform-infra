#!/usr/bin/env bash
# Phase-1 local CI (MULTI-COMPONENT variant): build EACH component's image and push it
# to the registry. The tag is computed from promotion.yaml per the target environment's
# convention (promotion.yaml is the single source of truth). The component list comes
# from .devops/components.yaml — one image per component. Prints each IMAGE ref.
#
# Phase 2 (the real platform path) replaces this local docker loop with the GitHub
# Actions workflow (.github/workflows/build-and-push.yaml — a Kaniko build MATRIX over
# the same components.yaml). This script is the local inner-loop convenience; after the
# Harbor cutover it is Phase-1 legacy. It keeps the SAME seam: only `registry` (in
# promotion.yaml) and the trigger change.
#
# BACK-COMPAT: if components.yaml is absent this is a single-component app and the script
# builds the one `app/` context as image <registry>/<promotion.app>:<tag> (legacy shape).
#
# Usage:
#   build-and-push.sh <env>            # env in: preview|dev|staging|prod
#   build-and-push.sh dev              # dev tagConvention (git-describe)
#   SEMVER=1.2.3 build-and-push.sh staging
#   SHA=abc1234  build-and-push.sh preview
set -euo pipefail

ENV="${1:-}"
if [ -z "${ENV}" ]; then
  echo "usage: $0 <preview|dev|staging|prod>" >&2
  exit 2
fi

# Resolve repo paths relative to this script so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVOPS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${DEVOPS_DIR}/.." && pwd)"
PROMOTION="${DEVOPS_DIR}/promotion.yaml"
COMPONENTS="${DEVOPS_DIR}/components.yaml"

[ -f "${PROMOTION}" ] || { echo "promotion.yaml not found at ${PROMOTION}" >&2; exit 1; }

# Read the promotion contract (single source of truth, §4.1, schema v1).
REGISTRY="$(yq -r '.registry' "${PROMOTION}")"
TAG_CONV="$(yq -r ".environments.${ENV}.tagConvention" "${PROMOTION}")"
if [ -z "${TAG_CONV}" ] || [ "${TAG_CONV}" = "null" ]; then
  echo "no tagConvention for env '${ENV}' in promotion.yaml" >&2
  exit 1
fi

# Resolve a named tagConvention into the concrete image tag (mirrors resolve-image.sh).
git_short() { echo "${SHA:-$(git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null || echo local)}"; }
resolve_tag() {
  case "$1" in
    "git-describe") git -C "${REPO_DIR}" describe --tags --always 2>/dev/null || git_short ;;
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

# Build + push one component. Args: <context-dir> <image-repo>
build_one() {
  ctx="$1"; repo="$2"
  image="${REGISTRY}/${repo}:${TAG}"
  echo "==> building ${image}"
  echo "    context: ${REPO_DIR}/${ctx}  env: ${ENV}  tagConvention: ${TAG_CONV}"
  docker build -t "${image}" "${REPO_DIR}/${ctx}"
  echo "==> pushing ${image}"
  docker push "${image}"
  echo "IMAGE=${image}"
}

if [ -f "${COMPONENTS}" ]; then
  # Multi-component: one image per component (context + image repo from components.yaml).
  while IFS="$(printf '\t')" read -r ctx repo; do
    [ -n "${ctx}" ] || continue
    build_one "${ctx}" "${repo}"
  done < <(yq -r '.components[] | [.context, .image] | @tsv' "${COMPONENTS}")
else
  # Single-component fallback (legacy shape): build app/ as <registry>/<app>:<tag>.
  APP="$(yq -r '.app' "${PROMOTION}")"
  build_one app "${APP}"
fi

echo "TAG=${TAG}"
echo "ENV=${ENV}"
