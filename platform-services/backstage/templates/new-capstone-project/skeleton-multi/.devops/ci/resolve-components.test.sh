#!/usr/bin/env bash
# resolve-components.test.sh — unit tests for resolve-components.sh (the multi-component
# build matrix). Self-contained: builds temp promotion.yaml + components.yaml fixtures and
# asserts the emitted JSON. The consumer contract: a COMPACT JSON ARRAY of
# {name,context,dockerfile,image(=LEAF, e.g. myapp-frontend)} — NO tag/registry/push (the
# workflow composes <registry>/<image>:<tag>). Exercises the yq path, the no-yq awk
# fallback, and the single-component fallback.
# Requires: bash (yq optional). Run: .devops/ci/resolve-components.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLVER="${SCRIPT_DIR}/resolve-components.sh"
PASS=0; FAIL=0

FIXDIR="$(mktemp -d)"
PROM="${FIXDIR}/promotion.yaml"
COMP="${FIXDIR}/components.yaml"
cat > "${PROM}" <<'YAML'
apiVersion: platform.capstone/v1
registry: harbor.example.com/team-sample
app: myapp
environments:
  dev: { trigger: "branch:main", tagConvention: "git-describe", overlay: ".devops/chart/overlays/dev", gate: auto }
YAML
# components.yaml carries trailing # comments on purpose — the awk fallback must strip them.
cat > "${COMP}" <<'YAML'
apiVersion: platform.capstone/v1
components:
  - name: frontend          # selector + image suffix
    kind: frontend          # frontend | backend
    context: frontend       # build-context dir
    dockerfile: Dockerfile  # relative to context
    image: myapp-frontend   # repo LEAF within the team project (appName-prefixed)
    port: 8080
    path: /
  - name: backend
    kind: backend
    context: backend
    dockerfile: Dockerfile
    image: myapp-backend
    port: 8080
    path: /api
YAML

# A no-yq PATH with only the coreutils the resolver needs (proves the awk fallback).
NOYQ_DIR="$(mktemp -d)"
for b in sh sed cut head dirname awk printf cat env; do
  src="$(command -v "$b" 2>/dev/null)" && [ -n "$src" ] && ln -sf "$src" "${NOYQ_DIR}/$b"
done

# run <name> <PROMOTION> <COMPONENTS> [noyq]   ($1 = case name, ignored in env)
run() {
  if [ "${4:-}" = "noyq" ]; then
    OUT="$(PROMOTION="$2" COMPONENTS="$3" PATH="${NOYQ_DIR}" sh "${RESOLVER}" 2>/tmp/rc.err)"; RC=$?
  else
    OUT="$(PROMOTION="$2" COMPONENTS="$3" sh "${RESOLVER}" 2>/tmp/rc.err)"; RC=$?
  fi
}
assert_rc()       { if [ "${RC}" = "$2" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [$1] rc: got ${RC} want $2 (err: $(cat /tmp/rc.err))"; fi; }
assert_contains() { if printf '%s' "${OUT}" | grep -qF -- "$2"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [$1] expected substring not found: $2"; echo "       in: ${OUT}"; fi; }
refute_contains() { if printf '%s' "${OUT}" | grep -qF -- "$2"; then FAIL=$((FAIL+1)); echo "FAIL [$1] unexpected substring present: $2"; echo "       in: ${OUT}"; else PASS=$((PASS+1)); fi; }
assert_count()    { local n; n="$(printf '%s' "${OUT}" | grep -oF -- "$2" | wc -l | tr -d ' ')"; if [ "${n}" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [$1] count of '$2': got ${n} want $3"; fi; }

echo "== resolve-components.sh tests =="

# 1) multi (yq path): 2 components, image = LEAF (appName-prefixed), no tag/registry/push.
run "multi-yq" "${PROM}" "${COMP}"
assert_rc       "multi-yq" 0
assert_contains "multi-yq" '"name":"frontend"'
assert_contains "multi-yq" '"name":"backend"'
assert_contains "multi-yq" '"context":"backend"'
assert_contains "multi-yq" '"dockerfile":"Dockerfile"'
assert_contains "multi-yq" '"image":"myapp-frontend"'
assert_contains "multi-yq" '"image":"myapp-backend"'
# image is the LEAF only — must NOT carry the registry or a tag, and no push key.
refute_contains "multi-yq" 'harbor.example.com'
refute_contains "multi-yq" '"push"'
refute_contains "multi-yq" ':v'
assert_count    "multi-yq" '"name":' 2

# 2) multi (no-yq awk fallback): MUST equal the yq output for the same inputs.
A="${OUT}"
run "multi-noyq" "${PROM}" "${COMP}" noyq
assert_rc "multi-noyq" 0
if [ "${OUT}" = "${A}" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [multi-noyq] differs from yq path"; echo " yq : ${A}"; echo " awk: ${OUT}"; fi

# 3) single-component fallback: no components.yaml -> ONE element {name:app,context:app,image:<promotion.app>}.
run "single" "${PROM}" "${FIXDIR}/does-not-exist.yaml"
assert_rc       "single" 0
assert_contains "single" '"name":"app"'
assert_contains "single" '"context":"app"'
assert_contains "single" '"dockerfile":"Dockerfile"'
assert_contains "single" '"image":"myapp"'
assert_count    "single" '"name":' 1

# 4) the emitted matrix is a valid, compact JSON ARRAY (not wrapped) — checked with node.
if command -v node >/dev/null 2>&1; then
  run "json" "${PROM}" "${COMP}"
  if printf '%s' "${OUT}" | node -e 'const a=JSON.parse(require("fs").readFileSync(0));if(!Array.isArray(a))process.exit(3)' 2>/tmp/rc.err; then
    PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [json] output is not a valid JSON array: $(cat /tmp/rc.err)"; fi
else
  echo "NOTE: node absent — skipping JSON-parse assertion"
fi

echo "== FINAL: $PASS passed, $FAIL failed =="
[ "${FAIL}" -eq 0 ]
