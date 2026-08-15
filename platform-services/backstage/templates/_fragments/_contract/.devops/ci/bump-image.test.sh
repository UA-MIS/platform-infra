#!/usr/bin/env bash
# bump-image.test.sh — unit tests for the MULTI-COMPONENT bump-image.sh. Builds a temp
# repo (promotion.yaml + a dev overlay kustomization with N images[] entries), runs the
# bump, and asserts EVERY component's newTag is rewritten (the fix for the single-script
# `select(.name=="sample")` no-op). Exercises both the yq path and the no-yq sed fallback.
# Requires: bash, git (yq optional). Run: .devops/ci/bump-image.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUMP="${SCRIPT_DIR}/bump-image.sh"
PASS=0; FAIL=0

# Build a throwaway repo whose layout matches a rendered multi-component tenant.
make_repo() {
  local root; root="$(mktemp -d)"
  mkdir -p "${root}/.devops/ci" "${root}/.devops/chart/overlays/dev"
  cp "${BUMP}" "${root}/.devops/ci/bump-image.sh"
  # Block-style environments (matches the rendered promotion.yaml; the no-yq awk
  # fallback in bump-image.sh parses block style, as the scaffolder always renders it).
  cat > "${root}/.devops/promotion.yaml" <<'YAML'
apiVersion: platform.capstone/v1
registry: harbor.example.com/team-sample
app: myapp
environments:
  dev:
    trigger: "branch:main"
    tagConvention: "git-describe"
    overlay: ".devops/chart/overlays/dev"
    gate: auto
YAML
  cat > "${root}/.devops/chart/overlays/dev/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: team-sample-dev
resources:
  - ../../base
images:
  - name: myapp-frontend
    newName: harbor.example.com/team-sample/myapp-frontend
    newTag: v0.0.0
  - name: myapp-backend
    newName: harbor.example.com/team-sample/myapp-backend
    newTag: v0.0.0
YAML
  ( cd "${root}" && git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init )
  printf '%s' "${root}"
}

NOYQ_DIR="$(mktemp -d)"
for b in bash sh sed cut head dirname awk printf cat env grep git; do
  src="$(command -v "$b" 2>/dev/null)" && [ -n "$src" ] && ln -sf "$src" "${NOYQ_DIR}/$b"
done

# Quote-tolerant: the bump writes newTag as a YAML STRING, which is unquoted for a
# non-numeric tag (yq strenv) but MUST be quoted for an all-numeric git-sha (both the yq
# strenv path and the sed fallback), else kustomize parses it as a number and rejects it.
count_tag() { local n; n="$(grep -Ec "newTag: \"?$1\"?" "$2" 2>/dev/null)" || n=0; printf '%s' "${n}"; }
assert_eq() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [$1]: got '$2' want '$3'"; fi; }

echo "== bump-image.sh (multi-component) tests =="

# 1) yq path: bump dev -> both components' newTag rewritten, none left at v0.0.0.
R1="$(make_repo)"; K1="${R1}/.devops/chart/overlays/dev/kustomization.yaml"
bash "${R1}/.devops/ci/bump-image.sh" dev "v1.0.0-3-gabc123" >/tmp/bump.log 2>&1; RC=$?
assert_eq "yq rc"        "${RC}" "0"
assert_eq "yq new count" "$(count_tag 'v1.0.0-3-gabc123' "${K1}")" "2"
assert_eq "yq old count" "$(count_tag 'v0.0.0' "${K1}")" "0"

# 2) no-yq sed fallback: same result with yq hidden from PATH.
if PATH="${NOYQ_DIR}" command -v yq >/dev/null 2>&1; then
  echo "NOTE: yq present on restricted PATH — sed fallback not isolated; skipping"
else
  R2="$(make_repo)"; K2="${R2}/.devops/chart/overlays/dev/kustomization.yaml"
  PATH="${NOYQ_DIR}" bash "${R2}/.devops/ci/bump-image.sh" dev "7.7.7" >/tmp/bump.log 2>&1; RC=$?
  assert_eq "sed rc"        "${RC}" "0"
  assert_eq "sed new count" "$(count_tag '7.7.7' "${K2}")" "2"
  assert_eq "sed old count" "$(count_tag 'v0.0.0' "${K2}")" "0"
fi

# 4) all-numeric git-sha tag (e.g. 0640920 — a short sha with no a-f digit) MUST render
#    as a QUOTED YAML string. Unquoted, YAML parses it as an integer and kustomize aborts
#    the whole build ("cannot unmarshal number into ... Image.images.newTag of type
#    string") -> ArgoCD ComparisonError, app never deploys (bug: meow-dev, #341). Both the
#    yq (strenv) and the sed fallback must quote it. Progressive-delivery/Rollout tenants
#    are NOT special here — any tenant whose sha is all digits hits this; meow was both.
R4="$(make_repo)"; K4="${R4}/.devops/chart/overlays/dev/kustomization.yaml"
bash "${R4}/.devops/ci/bump-image.sh" dev "0640920" >/tmp/bump.log 2>&1
assert_eq "numeric yq quoted"  "$(grep -c 'newTag: "0640920"' "${K4}")" "2"
if PATH="${NOYQ_DIR}" command -v yq >/dev/null 2>&1; then
  echo "NOTE: yq present on restricted PATH — sed fallback not isolated; skipping numeric-sed"
else
  R5="$(make_repo)"; K5="${R5}/.devops/chart/overlays/dev/kustomization.yaml"
  PATH="${NOYQ_DIR}" bash "${R5}/.devops/ci/bump-image.sh" dev "0640920" >/tmp/bump.log 2>&1
  assert_eq "numeric sed quoted" "$(grep -c 'newTag: "0640920"' "${K5}")" "2"
  # Idempotency: a second bump (file already has "0640920") must not double the quotes.
  PATH="${NOYQ_DIR}" bash "${R5}/.devops/ci/bump-image.sh" dev "0640920" >/tmp/bump.log 2>&1
  assert_eq "numeric sed idempotent" "$(grep -c 'newTag: "0640920"' "${K5}")" "2"
  assert_eq "numeric sed no double-quote" "$(grep -c 'newTag: ""' "${K5}")" "0"
fi

# 3) COMMIT=1 makes the GitOps-signal commit -- and FIX-18/D-030: it must NOT carry
# `[skip ci]` (GitHub's skip-ci detection is COMMIT-level, not ref-level -- it would
# permanently suppress any FUTURE tag push referencing this same commit too, which is
# exactly what broke vX.Y.Z re-promotion; loop-prevention now lives in build-and-push
# .yaml's `resolve` job `if:` guard instead, keyed on the commit author identity).
R3="$(make_repo)"
COMMIT=1 bash "${R3}/.devops/ci/bump-image.sh" dev "9.9.9" >/tmp/bump.log 2>&1
LAST="$(git -C "${R3}" log -1 --pretty=%s 2>/dev/null)"
case "${LAST}" in
  *"[skip ci]"*) FAIL=$((FAIL+1)); echo "FAIL [commit]: commit subject must NOT carry [skip ci] (FIX-18): '${LAST}'" ;;
  "ci: bump dev images to 9.9.9") PASS=$((PASS+1)) ;;
  *) FAIL=$((FAIL+1)); echo "FAIL [commit]: unexpected commit subject: '${LAST}'" ;;
esac

echo "== FINAL: $PASS passed, $FAIL failed =="
[ "${FAIL}" -eq 0 ]
