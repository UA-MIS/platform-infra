#!/usr/bin/env bash
# resolve-components.test.sh — unit tests for resolve-components.sh (the multi-component
# build matrix). Self-contained: builds temp promotion.yaml + components.yaml fixtures,
# drives the resolver with TAG/PUSH env, asserts the emitted JSON. Exercises BOTH the
# yq path and the no-yq awk fallback, plus the single-component fallback.
# Requires: bash (yq optional — the fallback path is tested when yq is hidden).
# Run: .devops/ci/resolve-components.test.sh
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
  dev:     { trigger: "branch:main", tagConvention: "git-describe", overlay: ".devops/chart/overlays/dev", gate: auto }
YAML
# components.yaml carries trailing # comments on purpose — the awk fallback must strip them.
cat > "${COMP}" <<'YAML'
apiVersion: platform.capstone/v1
components:
  - name: frontend          # selector + image suffix
    kind: frontend          # frontend | backend
    context: frontend       # build-context dir
    dockerfile: Dockerfile  # relative to context
    image: myapp-frontend   # repo within the team project
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

# run <name> <PROMOTION> <COMPONENTS> <TAG> <PUSH> [noyq]   ($1 = case name, ignored in env)
run() {
  if [ "${6:-}" = "noyq" ]; then
    OUT="$(PROMOTION="$2" COMPONENTS="$3" TAG="$4" PUSH="$5" PATH="${NOYQ_DIR}" sh "${RESOLVER}" 2>/tmp/rc.err)"; RC=$?
  else
    OUT="$(PROMOTION="$2" COMPONENTS="$3" TAG="$4" PUSH="$5" sh "${RESOLVER}" 2>/tmp/rc.err)"; RC=$?
  fi
}
assert_rc()       { if [ "${RC}" = "$2" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [$1] rc: got ${RC} want $2 (err: $(cat /tmp/rc.err))"; fi; }
assert_contains() { if printf '%s' "${OUT}" | grep -qF -- "$2"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [$1] expected substring not found: $2"; echo "       in: ${OUT}"; fi; }
assert_count()    { local n; n="$(printf '%s' "${OUT}" | grep -oF -- "$2" | wc -l | tr -d ' ')"; if [ "${n}" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [$1] count of '$2': got ${n} want $3"; fi; }

echo "== resolve-components.sh tests =="

# 1) multi (yq path): 2 components, each full image ref carries registry + tag + push.
run "multi-yq" "${PROM}" "${COMP}" "v1.2.3" "true"
assert_rc       "multi-yq" 0
assert_contains "multi-yq" '"name":"frontend"'
assert_contains "multi-yq" '"name":"backend"'
assert_contains "multi-yq" '"image":"harbor.example.com/team-sample/myapp-frontend:v1.2.3"'
assert_contains "multi-yq" '"image":"harbor.example.com/team-sample/myapp-backend:v1.2.3"'
assert_contains "multi-yq" '"context":"backend"'
assert_count    "multi-yq" '"push":"true"' 2

# 2) multi (no-yq awk fallback): MUST equal the yq output for the same inputs.
A="${OUT}"
run "multi-noyq" "${PROM}" "${COMP}" "v1.2.3" "true" noyq
assert_rc "multi-noyq" 0
if [ "${OUT}" = "${A}" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [multi-noyq] differs from yq path"; echo " yq : ${A}"; echo " awk: ${OUT}"; fi

# 3) single-component fallback: no components.yaml -> ONE element from promotion.app.
run "single" "${PROM}" "${FIXDIR}/does-not-exist.yaml" "abc1234" "false"
assert_rc       "single" 0
assert_contains "single" '"name":"app"'
assert_contains "single" '"context":"app"'
assert_contains "single" '"image":"harbor.example.com/team-sample/myapp:abc1234"'
assert_contains "single" '"push":"false"'
assert_count    "single" '"name":' 1

# 4) missing TAG -> usage rc 2.
run "no-tag" "${PROM}" "${COMP}" "" "true"
assert_rc "no-tag" 2

# 5) the emitted matrix is valid JSON (checked with node when available).
if command -v node >/dev/null 2>&1; then
  run "json" "${PROM}" "${COMP}" "v1.2.3" "true"
  if printf '%s' "${OUT}" | node -e 'JSON.parse(require("fs").readFileSync(0))' 2>/tmp/rc.err; then
    PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [json] output is not valid JSON: $(cat /tmp/rc.err)"; fi
else
  echo "NOTE: node absent — skipping JSON-parse assertion"
fi

echo "== FINAL: $PASS passed, $FAIL failed =="
[ "${FAIL}" -eq 0 ]
