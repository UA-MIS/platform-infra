#!/usr/bin/env sh
# seed-initial-envs.sh — FIRST-DEPLOY seed (Deploy Model A initial condition).
#
# THE PROBLEM IT SOLVES: a freshly-scaffolded tenant's staging + prod overlays ship a
# PLACEHOLDER image tag — the sentinel v0.0.0 — that NO build has produced yet. Left
# untouched they sit in ImagePullBackOff until the team cuts a release. dev, by contrast,
# is bumped to a REAL image by CI's bump-dev on the first push to main. This script closes
# that gap: on the FIRST successful main build ONLY, it points staging + prod at the SAME
# just-built image dev got, so ALL THREE environments come up GREEN out of the box.
#
# WHY IT IS A ONE-TIME INITIAL CONDITION (the promotion gate is preserved): it seeds an env
# ONLY while that env's overlay still carries the sentinel — i.e. it has never been bumped
# or promoted. After the first seed, staging/prod hold a REAL tag (!= sentinel), so every
# subsequent push is a NO-OP here and bumps ONLY dev. staging/prod then advance solely via
# the promote-to-prod gate (promote.sh reads an env's live tag and writes it to the next).
# This is NOT auto-prod-on-every-push: the "all envs green" is a first-deploy INITIAL
# CONDITION, not ongoing auto-promotion.
#
# It reuses bump-image.sh for the actual write (+ optional commit) so there is ONE write
# path for every env — identical to how promote.sh re-points an env at an existing tag.
# COMMIT is inherited by the child bump-image.sh (COMMIT=1 -> each SEEDED env gets its own
# commit -- NOT `[skip ci]`, see bump-image.sh's header comment, FIX-18/D-030; the
# bump-dev workflow does the single push).
#
# Reads the env->overlay mapping from promotion.yaml (the single source of truth), same as
# bump-image.sh/promote.sh, so a convention change stays a one-file edit.
#
# Usage:
#   seed-initial-envs.sh <tag>              # seed staging/prod IFF at sentinel (no commit)
#   COMMIT=1 seed-initial-envs.sh <tag>     # seed + commit each seeded env (the CI path)
# Env overrides (rarely needed):
#   SENTINEL   the placeholder tag to match (default: v0.0.0 — what the fresh overlays ship)
#   SEED_ENVS  space-separated envs to consider (default: "staging prod"; dev is always
#              bumped by bump-dev directly, never seeded here)
set -eu

TAG="${1:-}"
if [ -z "${TAG}" ]; then
  echo "usage: $0 <tag>" >&2
  exit 2
fi

SENTINEL="${SENTINEL:-v0.0.0}"
SEED_ENVS="${SEED_ENVS:-staging prod}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVOPS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${DEVOPS_DIR}/.." && pwd)"
PROMOTION="${DEVOPS_DIR}/promotion.yaml"
[ -f "${PROMOTION}" ] || { echo "promotion.yaml not found at ${PROMOTION}" >&2; exit 1; }

# env -> overlay path (schema v1: `overlay` is a repo-relative path). Same read as
# bump-image.sh/promote.sh: yq-preferred, awk fallback for a bare runner with no yq.
read_overlay() {
  env="$1"
  if command -v yq >/dev/null 2>&1; then
    yq -r ".environments.${env}.overlay" "${PROMOTION}"
  else
    awk -v env="${env}" '
      $0 ~ "^[[:space:]]+" env ":[[:space:]]*$" { inblk=1; next }
      inblk && /^[[:space:]]+[a-z]+:[[:space:]]*$/ && $0 !~ "^[[:space:]]{6,}" { inblk=0 }
      inblk && /overlay:/ { sub(/^[^:]*:[[:space:]]*/, ""); sub(/[[:space:]]*#.*$/, ""); gsub(/^[ \t]+|[ \t]+$|"/, ""); print; exit }
    ' "${PROMOTION}"
  fi
}

# The env's currently-pinned tag = the FIRST images[].newTag. bump-image.sh's invariant is
# that every component shares one tag, so the first entry represents the env (mirrors
# promote.sh's own live-tag read).
first_newtag() {
  # Strip the newTag: prefix, trailing comment/whitespace, then any ONE layer of
  # matching surrounding quotes -- same fix as promote.sh's LIVE_TAG read (FIX-23):
  # this function shares the identical bare-extraction pattern, so a quoted overlay
  # value (e.g. an already-promoted env re-checked here) would otherwise come back
  # with its quotes still attached. Not currently reachable for corruption via THIS
  # call site (the SENTINEL comparison below only matches the unquoted v0.0.0 seed
  # value, and a mismatch here just skips rather than writes) -- fixed anyway since
  # it's the same extraction defect FIX-23 was filed for.
  grep -m1 -E '^[[:space:]]*newTag:' "$1" 2>/dev/null \
    | sed -E 's/^[[:space:]]*newTag:[[:space:]]*//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

seeded_any=0
for env in ${SEED_ENVS}; do
  overlay="$(read_overlay "${env}")"
  if [ -z "${overlay}" ] || [ "${overlay}" = "null" ]; then
    echo "==> ${env}: no overlay mapping in promotion.yaml — skipping" >&2
    continue
  fi
  kustomization="${REPO_DIR}/${overlay}/kustomization.yaml"
  if [ ! -f "${kustomization}" ]; then
    echo "==> ${env}: overlay kustomization not found (${kustomization}) — skipping" >&2
    continue
  fi

  current="$(first_newtag "${kustomization}")"
  if [ -z "${current}" ]; then
    # No images[] entry (e.g. a mobile-artifact-only project) — nothing to deploy, nothing
    # to seed.
    echo "==> ${env}: no images[].newTag (no buildable component) — nothing to seed"
    continue
  fi
  if [ "${current}" != "${SENTINEL}" ]; then
    echo "==> ${env}: already at '${current}' (past the ${SENTINEL} sentinel) — promotion-gated, leaving unchanged"
    continue
  fi

  echo "==> ${env}: first-deploy seed — still at sentinel ${SENTINEL}, pointing at ${TAG}"
  # Reuse the single write path. Invoked via `sh` (not a direct exec) so it works even
  # when the shipped script lacks the execute bit — the compose action writes .devops/ci
  # verbatim at mode 644, and the workflow/RUNBOOK invoke every script as `sh …` too.
  # COMMIT (if set) is inherited by the child process's environment.
  # `bash`, NOT `sh`. bump-image.sh declares `#!/usr/bin/env bash` and uses
  # `set -euo pipefail`; /bin/sh on Debian is dash, which rejects `-o pipefail`
  # and exits 2 before doing any work ("set: Illegal option -o pipefail"). This
  # is not theoretical -- it is why promote.test.sh and seed-initial-envs.test.sh
  # fail 11 cases each the moment they are actually run. Still no +x bit is
  # required, which is all the `sh` form was ever working around.
  bash "${SCRIPT_DIR}/bump-image.sh" "${env}" "${TAG}"
  seeded_any=1
done

if [ "${seeded_any}" = "0" ]; then
  echo "==> nothing seeded (all target envs already past the ${SENTINEL} sentinel or empty)."
fi
