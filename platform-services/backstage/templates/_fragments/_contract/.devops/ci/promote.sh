#!/usr/bin/env bash
# promote.sh — the click-to-promote seam (promotion-model redesign, see
# artifacts/design/promotion-model.md in platform-infra). Reads the image tag
# CURRENTLY LIVE in <from>'s overlay and writes that SAME tag into <to>'s
# overlay — no fresh build, no code edit, no new git tag. This is what
# .github/workflows/promote-to-prod.yaml runs on workflow_dispatch: the human
# clicking "Run workflow" IS the gate; this script does the bump.
#
# Reuses bump-image.sh for the actual write (+ optional commit) so there is
# ONE write path for every env, whether driven by a fresh build (bump-image.sh
# directly) or by re-pointing at an already-live version (this script).
#
# Usage:
#   promote.sh <from-env> <to-env>          # dry run: print the live tag, don't write
#   COMMIT=1 promote.sh staging prod        # write + commit (the GitOps signal)
set -euo pipefail

FROM="${1:-}"
TO="${2:-}"
if [ -z "${FROM}" ] || [ -z "${TO}" ]; then
  echo "usage: $0 <from-env> <to-env>" >&2
  exit 2
fi
if [ "${FROM}" = "${TO}" ]; then
  echo "from and to must differ (got '${FROM}' twice)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVOPS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${DEVOPS_DIR}/.." && pwd)"
PROMOTION="${DEVOPS_DIR}/promotion.yaml"

[ -f "${PROMOTION}" ] || { echo "promotion.yaml not found at ${PROMOTION}" >&2; exit 1; }

# Resolve env -> overlay from the promotion contract. Same read as
# bump-image.sh's read_overlay (yq-preferred; sed/awk fallback for a bare runner).
read_overlay() {
  local env="$1"
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

FROM_OVERLAY="$(read_overlay "${FROM}")"
if [ -z "${FROM_OVERLAY}" ] || [ "${FROM_OVERLAY}" = "null" ]; then
  echo "no overlay mapping for env '${FROM}' in promotion.yaml" >&2
  exit 1
fi
FROM_KUSTOMIZATION="${REPO_DIR}/${FROM_OVERLAY}/kustomization.yaml"
[ -f "${FROM_KUSTOMIZATION}" ] || { echo "overlay kustomization not found: ${FROM_KUSTOMIZATION}" >&2; exit 1; }

# Read the LIVE tag out of <from>'s overlay. bump-image.sh's invariant is that
# every component's images[].newTag is set to the SAME tag in one write, so
# read the first entry and refuse if any entry disagrees — that means <from>
# is in a hand-edited / partially-bumped state and promoting it would ship an
# inconsistent set of component versions.
if command -v yq >/dev/null 2>&1; then
  LIVE_TAG="$(yq -r '.images[0].newTag' "${FROM_KUSTOMIZATION}")"
  MISMATCHED="$(LIVE_TAG="${LIVE_TAG}" yq -r '[.images[].newTag] | map(select(. != strenv(LIVE_TAG))) | length' "${FROM_KUSTOMIZATION}")"
else
  # Strip the newTag: prefix, any trailing comment, then any ONE layer of matching
  # surrounding quotes (bump-image.sh's sed fallback always double-quotes its writes;
  # single-quote handling is defensive). Without this, a quoted staging value like
  # `newTag: "1.0.0"` extracts LIVE_TAG=`"1.0.0"` (quotes included) -- bump-image.sh's
  # sed fallback then re-quotes that verbatim into prod as `newTag: ""1.0.0""`, invalid
  # YAML that leaves prod's Application ComparisonError/unsyncable (FIX-23, source-
  # confirmed against a live promote run). MATCHING_COUNT below must compare against
  # the SAME bare value kustomization.yaml actually stores (quoted), so it re-wraps
  # LIVE_TAG in double quotes for the grep -- see the comment there.
  LIVE_TAG="$(grep -m1 -E '^[[:space:]]*newTag:' "${FROM_KUSTOMIZATION}" | sed -E 's/^[[:space:]]*newTag:[[:space:]]*//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
  TOTAL_COUNT="$(grep -cE '^[[:space:]]*newTag:' "${FROM_KUSTOMIZATION}")"
  # LIVE_TAG is now bare (quotes stripped above); match it against the overlay's stored
  # form, which may be bare (e.g. `v1.2.3`) or double-quoted (e.g. an all-numeric sha,
  # meow-dev #341) -- so check for either rendering, not just the bare one.
  MATCHING_COUNT="$(grep -cE "^[[:space:]]*newTag:[[:space:]]*\"?${LIVE_TAG}\"?\$" "${FROM_KUSTOMIZATION}")"
  MISMATCHED=$(( TOTAL_COUNT - MATCHING_COUNT ))
fi

if [ -z "${LIVE_TAG}" ] || [ "${LIVE_TAG}" = "null" ]; then
  echo "could not read a live tag from ${FROM_KUSTOMIZATION}" >&2
  exit 1
fi
if [ "${MISMATCHED}" != "0" ]; then
  echo "${FROM}'s components do not all share one tag — refusing to promote an inconsistent state (check ${FROM_KUSTOMIZATION})" >&2
  exit 1
fi

echo "==> ${FROM} is live at ${LIVE_TAG} — promoting to ${TO}"

# Hand off to bump-image.sh for the write (+ COMMIT=1 commit). COMMIT, if set
# in this process's environment, is inherited by the child automatically.
# Invoke via `sh` (not a direct exec) so it works even when the shipped script lacks the
# execute bit: the compose action ships .devops/ci VERBATIM via fs.outputFile at mode 644,
# so a direct `"${SCRIPT_DIR}/bump-image.sh"` fails "Permission denied" in a real tenant
# repo. The workflow + RUNBOOK invoke every script as `sh …` for the same reason.
# `bash`, NOT `sh`. bump-image.sh declares `#!/usr/bin/env bash` and uses
# `set -euo pipefail`; /bin/sh on Debian is dash, which rejects `-o pipefail`
# and exits 2 before doing any work ("set: Illegal option -o pipefail"). This
# is not theoretical -- it is why promote.test.sh and seed-initial-envs.test.sh
# fail 11 cases each the moment they are actually run. Still no +x bit is
# required, which is all the `sh` form was ever working around.
bash "${SCRIPT_DIR}/bump-image.sh" "${TO}" "${LIVE_TAG}"
