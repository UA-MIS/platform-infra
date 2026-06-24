#!/usr/bin/env sh
# resolve-image.sh — map a GitHub event (ref/event-name) to the promotion.yaml
# environment, then emit the registry / app / image-tag / push-decision for that
# env (architecture §4.1, D-011/ADR-008; CI engine D-032).
#
# This is the SINGLE place that translates a git trigger into an image identity,
# reading promotion.yaml — the canonical source of truth — so a convention change
# (e.g. "staging tracks a release branch, not a tag") is a one-file edit there.
# The Kaniko build+push workflow (.github/workflows/build-and-push.yaml) consumes
# this script's KEY=VALUE output.
#
# PORTABLE: POSIX sh, runs unmodified inside the busybox-based Kaniko :debug image
# (the CI build container) — so the workflow uses the SAME tested resolver as the
# local loop, no drift. It reads the two promotion.yaml scalars it needs (registry,
# app) with `yq` when present, else a self-contained sed fallback (the fields are
# top-level scalars, safe to parse without yq).
#
# The tag IS the promotion mechanism (D-030 prod-gate): a `vX.Y.Z` git tag yields
# the IMMUTABLE `:X.Y.Z` image that the prod (and staging) overlays pin; a push to
# main yields a mutable `:<short-sha>` image for dev; a pull_request yields a
# build-only `pull-<short-sha>` (no push). Exactly ONE tag per build — the git tag
# names both the image and, via bump-image.sh, the manifest revision.
#
# Trigger -> env (matches promotion.yaml `environments.*.trigger`):
#   tag:v*        (refs/tags/vX.Y.Z) -> prod    (semver, immutable, gated)  PUSH
#   branch:main   (refs/heads/main)  -> dev     (git-describe, mutable)     PUSH
#   pull_request                     -> preview (pull-<sha>, build-only)    NO PUSH
#
# NOTE on staging vs prod: both are driven by `tag:v*`. One `vX.Y.Z` tag builds ONE
# immutable `:X.Y.Z` image that BOTH staging and prod overlays pin — staging
# auto-syncs, prod is the manual gate (§4). The tag build is env-agnostic; we
# resolve against `prod` only to read the (identical) registry/app/semver
# tagConvention. We do NOT invent a second tag.
#
# Output (stdout, KEY=VALUE — consume via `>> "$GITHUB_OUTPUT"` or `eval`):
#   ENV / REGISTRY / APP / TAG / IMAGE(=REGISTRY/APP:TAG) / PUSH(true|false)
#
# Inputs (env; GitHub Actions sets the first three automatically):
#   GITHUB_EVENT_NAME  push|pull_request   GITHUB_REF  refs/...   GITHUB_SHA  sha
#   PROMOTION  path to promotion.yaml (default: alongside this script's ../)
set -eu

# Locate promotion.yaml relative to this script (portable; no bash BASH_SOURCE).
SELF="$0"
SCRIPT_DIR="$(cd "$(dirname "${SELF}")" && pwd)"
DEVOPS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROMOTION="${PROMOTION:-${DEVOPS_DIR}/promotion.yaml}"
[ -f "${PROMOTION}" ] || { echo "promotion.yaml not found at ${PROMOTION}" >&2; exit 1; }

EVENT="${GITHUB_EVENT_NAME:-}"
REF="${GITHUB_REF:-}"
SHA_FULL="${SHA:-${GITHUB_SHA:-}}"

short_sha() {
  if [ -n "${SHA_FULL}" ]; then
    printf '%s' "${SHA_FULL}" | cut -c1-7
  else
    git -C "${DEVOPS_DIR}/.." rev-parse --short=7 HEAD 2>/dev/null || echo "local"
  fi
}

# git_describe — the Deploy-Model-A dev tag: a READABLE, monotonic image tag derived
# from the nearest git tag, e.g. `v1.0.0-5-gabc123` (5 commits past v1.0.0). Beats a
# bare SHA for legibility + ordering. Requires (a) a base tag — the scaffolder seeds
# `v0.0.0` on repo creation — and (b) the CI checkout to FETCH TAGS (fetch-depth: 0),
# else there are no tags to describe against. `--always` is the safety net: if the repo
# genuinely has zero tags (e.g. checkout still shallow), it degrades to a bare short sha
# rather than failing the build — but that defeats Model A's readable-tag goal, so the
# seed + fetch-depth:0 are the real contract; --always is belt-and-suspenders.
# `--dirty` is intentionally omitted (CI builds a clean checkout). Output is sanitized to
# a valid docker tag (git-describe output is already [A-Za-z0-9._-], all tag-safe).
git_describe() {
  REPO_ROOT="${DEVOPS_DIR}/.."
  if git -C "${REPO_ROOT}" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "${REPO_ROOT}" describe --tags --always 2>/dev/null || short_sha
  else
    # No .git available (shouldn't happen on the runner pod after checkout) — fall back
    # to the SHA the CI env provides so a tag is still emitted.
    short_sha
  fi
}

# Read a TOP-LEVEL scalar from promotion.yaml: prefer yq; fall back to sed for the
# flat `key: value` form (registry/app are always top-level scalars, schema v1).
yread() {
  key="$1"
  if command -v yq >/dev/null 2>&1; then
    yq -r ".${key}" "${PROMOTION}"
  else
    sed -n "s/^${key}:[[:space:]]*//p" "${PROMOTION}" | head -n1 \
      | sed 's/[[:space:]]*#.*$//; s/^["'\'']//; s/["'\'']$//'
  fi
}

# ---- 1) trigger -> env (the promotion.yaml trigger mapping) -----------------
PUSH="true"; SEMVER=""
case "${EVENT}" in
  pull_request)
    ENV="preview"; PUSH="false"          # PR builds VALIDATE only — never push
    ;;
  push)
    case "${REF}" in
      refs/tags/v*)  ENV="prod"; SEMVER="${REF#refs/tags/v}" ;;   # immutable semver
      refs/heads/main) ENV="dev" ;;                               # mutable sha
      *) echo "no promotion mapping for push ref '${REF}' (only main + v* tags build)" >&2; exit 1 ;;
    esac
    ;;
  "") echo "GITHUB_EVENT_NAME is empty — set GITHUB_EVENT_NAME and GITHUB_REF" >&2; exit 2 ;;
  *)  echo "unsupported event '${EVENT}' (expected push | pull_request)" >&2; exit 1 ;;
esac

# ---- 2) the promotion contract for that env --------------------------------
REGISTRY="$(yread registry)"
APP="$(yread app)"
if command -v yq >/dev/null 2>&1; then
  TAG_CONV="$(yq -r ".environments.${ENV}.tagConvention" "${PROMOTION}")"
else
  # tagConvention is fixed per env in schema v1; map directly so the resolver
  # works with no yq inside the Kaniko image (kept in sync with promotion.yaml).
  case "${ENV}" in
    dev) TAG_CONV="git-describe" ;;
    prod) TAG_CONV="semver" ;;
    preview) TAG_CONV="pull-<sha>" ;;
    *) TAG_CONV="" ;;
  esac
fi

for pair in "REGISTRY=${REGISTRY}" "APP=${APP}" "TAG_CONV=${TAG_CONV}"; do
  name="${pair%%=*}"; val="${pair#*=}"
  if [ -z "${val}" ] || [ "${val}" = "null" ]; then
    echo "promotion.yaml missing '${name}' for env '${ENV}'" >&2; exit 1
  fi
done

# ---- 3) resolve the tagConvention into the concrete tag --------------------
case "${TAG_CONV}" in
  "git-describe") TAG="$(git_describe)" ;;
  "sha-<short>") TAG="$(short_sha)" ;;
  "pull-<sha>")  TAG="pull-$(short_sha)" ;;
  "semver")
    [ -n "${SEMVER}" ] || { echo "env '${ENV}' uses semver but no vX.Y.Z tag was pushed (ref='${REF}')" >&2; exit 1; }
    case "${SEMVER}" in
      [0-9]*.[0-9]*.[0-9]*) TAG="${SEMVER}" ;;
      *) echo "tag 'v${SEMVER}' is not semver vX.Y.Z" >&2; exit 1 ;;
    esac
    ;;
  *) echo "unknown tagConvention '${TAG_CONV}' for env '${ENV}'" >&2; exit 1 ;;
esac

IMAGE="${REGISTRY}/${APP}:${TAG}"

# ---- 4) emit ----------------------------------------------------------------
echo "ENV=${ENV}"
echo "REGISTRY=${REGISTRY}"
echo "APP=${APP}"
echo "TAG=${TAG}"
echo "IMAGE=${IMAGE}"
echo "PUSH=${PUSH}"
