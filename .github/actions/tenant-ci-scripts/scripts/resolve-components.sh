#!/usr/bin/env sh
# resolve-components.sh — emit the CI BUILD MATRIX for a multi-component app, reading
# .devops/components.yaml (the component-model contract, platform.capstone/v1). The
# reusable build workflow fans out over this: ONE build+push per component.
#
# CONSUMER CONTRACT (Track 1 reusable-ci owns the workflow that consumes this):
#   stdout = a COMPACT single-line JSON ARRAY, one object per component, with the keys
#   the matrix needs — name / context / dockerfile / image — where `image` is the Harbor
#   repo LEAF (NOT the full ref):
#     [{"name":"frontend","context":"frontend","dockerfile":"Dockerfile","image":"myapp-frontend"}, ...]
#   The workflow composes the full ref itself: IMAGE=<registry>/<image>:<tag>
#   (registry from promotion.yaml, tag = the ONE per-commit tag from resolve-image.sh),
#   and wraps the array as {"include":[...]} for `strategy.matrix`. So this script needs
#   NO tag/registry/push inputs — it is a pure "list the components" reader.
#   (`image` already carries the appName prefix, e.g. myapp-frontend, so two apps in the
#   same team Harbor project never collide — consume `.image` VERBATIM.)
#
# BACK-COMPAT: if components.yaml is ABSENT, this is a single-component app — the script
# synthesizes ONE component { name: app, context: app, dockerfile: Dockerfile, image:
# <promotion.app> } so the matrix-based workflow builds it exactly like the legacy
# single-component path. Single-component repos need no components.yaml and are unchanged.
#
# INPUTS (env, both optional):
#   COMPONENTS  path to components.yaml  (default: ../components.yaml beside this script)
#   PROMOTION   path to promotion.yaml   (default: ../promotion.yaml; only read for the
#               single-component fallback's `app` leaf)
#
# PORTABLE: POSIX sh. Prefers `yq` (mikefarah); falls back to a self-contained awk parser
# for the fixed components.yaml shape (so it runs on a bare runner with no yq, no PAT, no
# install). Unit-tested by resolve-components.test.sh.
set -eu

SELF="$0"
SCRIPT_DIR="$(cd "$(dirname "${SELF}")" && pwd)"
DEVOPS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROMOTION="${PROMOTION:-${DEVOPS_DIR}/promotion.yaml}"
COMPONENTS="${COMPONENTS:-${DEVOPS_DIR}/components.yaml}"

# Read a TOP-LEVEL scalar from a yaml file: prefer yq; sed fallback for the flat
# `key: value` form (registry/app are top-level scalars, schema v1).
yread() {
  file="$1"; key="$2"
  if command -v yq >/dev/null 2>&1; then
    yq -r ".${key}" "${file}"
  else
    sed -n "s/^${key}:[[:space:]]*//p" "${file}" | head -n1 \
      | sed 's/[[:space:]]*#.*$//; s/^["'\'']//; s/["'\'']$//'
  fi
}

# Emit one compact JSON object for a component. Args: name context dockerfile imageLeaf
emit_obj() {
  printf '{"name":"%s","context":"%s","dockerfile":"%s","image":"%s"}' "$1" "$2" "$3" "$4"
}

# ---- single-component fallback (no components.yaml) -------------------------
if [ ! -f "${COMPONENTS}" ]; then
  [ -f "${PROMOTION}" ] || { echo "no components.yaml and promotion.yaml not found at ${PROMOTION}" >&2; exit 1; }
  APP="$(yread "${PROMOTION}" app)"
  [ -n "${APP}" ] && [ "${APP}" != "null" ] || { echo "no components.yaml and promotion.yaml missing 'app'" >&2; exit 1; }
  printf '[%s]\n' "$(emit_obj app app Dockerfile "${APP}")"
  exit 0
fi

# ---- multi-component: parse components[] ------------------------------------
out="["
first=1
append() { # name context dockerfile imageLeaf
  [ "${first}" = "1" ] || out="${out},"
  out="${out}$(emit_obj "$1" "$2" "$3" "$4")"
  first=0
}

if command -v yq >/dev/null 2>&1; then
  while IFS="$(printf '\t')" read -r n c d i; do
    [ -n "${n}" ] || continue
    append "${n}" "${c}" "${d}" "${i}"
  done <<EOF
$(yq -r '.components[] | [.name, .context, .dockerfile, .image] | @tsv' "${COMPONENTS}")
EOF
else
  # awk fallback: parse the fixed components.yaml shape; strips trailing # comments.
  while IFS="$(printf '\t')" read -r n c d i; do
    [ -n "${n}" ] || continue
    append "${n}" "${c}" "${d}" "${i}"
  done <<EOF
$(awk '
  function val(line) { sub(/^[^:]*:[[:space:]]*/, "", line); sub(/[[:space:]]*#.*$/, "", line); gsub(/^[ \t]+|[ \t]+$/, "", line); return line }
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
