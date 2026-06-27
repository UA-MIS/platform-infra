#!/usr/bin/env sh
# resolve-components.sh — emit the CI BUILD MATRIX for a multi-component app, reading
# .devops/components.yaml (the component-model contract, platform.capstone/v1). The
# multi-component build workflow fans out over this matrix: ONE Kaniko build+push per
# component (one image each).
#
# This is the consumer contract Track 6 (multi-component) hands to Track 1 (reusable-ci):
# the reusable workflow resolves the TAG + PUSH decision ONCE via resolve-image.sh, then
# calls THIS script to get the per-component build list. The tag is the SAME for every
# component (one repo, one git event); only the image REPO differs per component.
#
# BACK-COMPAT: if components.yaml is ABSENT, this is a single-component app — the script
# synthesizes ONE component { name: app, context: app, dockerfile: Dockerfile, image:
# <promotion.app> } so the matrix-based workflow builds it exactly like the legacy
# single-component path (image = <registry>/<app>:<tag>). Single-component repos need no
# components.yaml and are unchanged.
#
# OUTPUT (stdout): a COMPACT single-line JSON array, ready for GitHub Actions
#   `strategy.matrix.include: ${{ fromJSON(<this output>) }}`:
#     [{"name":"frontend","context":"frontend","dockerfile":"Dockerfile",
#       "image":"harbor.../<team>/<app>-frontend:<tag>","push":"true"}, ...]
#   Each element: name, context, dockerfile, image (FULL ref incl registry+tag), push.
#
# INPUTS (env):
#   TAG   the resolved image tag (REQUIRED; from resolve-image.sh's TAG= output).
#   PUSH  true|false (default "false"; from resolve-image.sh's PUSH= output).
#   PROMOTION   path to promotion.yaml   (default: ../promotion.yaml beside this script)
#   COMPONENTS  path to components.yaml   (default: ../components.yaml beside this script)
#
# PORTABLE: POSIX sh. Prefers `yq` (mikefarah) when present; falls back to a self-
# contained awk parser for the fixed components.yaml shape (so it works on a bare runner
# with no yq, mirroring resolve-image.sh). Unit-tested by resolve-components.test.sh.
set -eu

SELF="$0"
SCRIPT_DIR="$(cd "$(dirname "${SELF}")" && pwd)"
DEVOPS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROMOTION="${PROMOTION:-${DEVOPS_DIR}/promotion.yaml}"
COMPONENTS="${COMPONENTS:-${DEVOPS_DIR}/components.yaml}"

[ -f "${PROMOTION}" ] || { echo "promotion.yaml not found at ${PROMOTION}" >&2; exit 1; }

TAG="${TAG:-}"
PUSH="${PUSH:-false}"
[ -n "${TAG}" ] || { echo "TAG is required (set TAG=<resolve-image.sh TAG output>)" >&2; exit 2; }

# Read a TOP-LEVEL scalar from a yaml file: prefer yq; sed fallback for the flat
# `key: value` form (registry/app are top-level scalars, schema v1) — same reader as
# resolve-image.sh so behaviour is identical with or without yq.
yread() {
  file="$1"; key="$2"
  if command -v yq >/dev/null 2>&1; then
    yq -r ".${key}" "${file}"
  else
    sed -n "s/^${key}:[[:space:]]*//p" "${file}" | head -n1 \
      | sed 's/[[:space:]]*#.*$//; s/^["'\'']//; s/["'\'']$//'
  fi
}

REGISTRY="$(yread "${PROMOTION}" registry)"
[ -n "${REGISTRY}" ] && [ "${REGISTRY}" != "null" ] || { echo "promotion.yaml missing 'registry'" >&2; exit 1; }

# Emit one compact JSON object for a component. Args: name context dockerfile imageRepo
emit_obj() {
  _name="$1"; _ctx="$2"; _df="$3"; _repo="$4"
  printf '{"name":"%s","context":"%s","dockerfile":"%s","image":"%s/%s:%s","push":"%s"}' \
    "${_name}" "${_ctx}" "${_df}" "${REGISTRY}" "${_repo}" "${TAG}" "${PUSH}"
}

# ---- single-component fallback (no components.yaml) -------------------------
if [ ! -f "${COMPONENTS}" ]; then
  APP="$(yread "${PROMOTION}" app)"
  [ -n "${APP}" ] && [ "${APP}" != "null" ] || { echo "no components.yaml and promotion.yaml missing 'app'" >&2; exit 1; }
  printf '[%s]\n' "$(emit_obj app app Dockerfile "${APP}")"
  exit 0
fi

# ---- multi-component: parse components[] ------------------------------------
out="["
first=1
append() { # name context dockerfile imageRepo
  [ "${first}" = "1" ] || out="${out},"
  out="${out}$(emit_obj "$1" "$2" "$3" "$4")"
  first=0
}

if command -v yq >/dev/null 2>&1; then
  # One line per component: name<TAB>context<TAB>dockerfile<TAB>image
  while IFS="$(printf '\t')" read -r n c d i; do
    [ -n "${n}" ] || continue
    append "${n}" "${c}" "${d}" "${i}"
  done <<EOF
$(yq -r '.components[] | [.name, .context, .dockerfile, .image] | @tsv' "${COMPONENTS}")
EOF
else
  # awk fallback: parse the fixed components.yaml shape. Strips trailing # comments.
  # A new record starts at a "- name:" item; keys are 4-space-indented under it.
  while IFS="$(printf '\t')" read -r n c d i; do
    [ -n "${n}" ] || continue
    append "${n}" "${c}" "${d}" "${i}"
  done <<EOF
$(awk '
  function val(line,   v) { sub(/^[^:]*:[[:space:]]*/, "", line); sub(/[[:space:]]*#.*$/, "", line); gsub(/^[ \t]+|[ \t]+$/, "", line); return line }
  /^[[:space:]]*-[[:space:]]+name:/ { if (have) print n "\t" c "\t" d "\t" i; have=1; n=""; c=""; d=""; i="";
                                       line=$0; sub(/^[[:space:]]*-[[:space:]]+name:[[:space:]]*/, "", line); sub(/[[:space:]]*#.*$/, "", line); gsub(/^[ \t]+|[ \t]+$/, "", line); n=line; next }
  have && /^[[:space:]]+context:/    { c=val($0); next }
  have && /^[[:space:]]+dockerfile:/ { d=val($0); next }
  have && /^[[:space:]]+image:/      { i=val($0); next }
  END { if (have) print n "\t" c "\t" d "\t" i }
' "${COMPONENTS}")
EOF
fi

[ "${first}" = "0" ] || { echo "components.yaml has no components[]" >&2; exit 1; }
out="${out}]"
printf '%s\n' "${out}"
