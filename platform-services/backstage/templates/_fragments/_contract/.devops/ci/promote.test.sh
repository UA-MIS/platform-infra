#!/usr/bin/env bash
# promote.test.sh — unit tests for promote.sh (the click-to-promote seam).
# Builds a temp repo (promotion.yaml + staging/prod overlays), runs a
# promotion, and asserts the live staging tag lands in prod, mismatched
# components are refused, and COMMIT=1 produces the GitOps signal commit.
# Requires: bash, git (yq optional). Run: .devops/ci/promote.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMOTE="${SCRIPT_DIR}/promote.sh"
BUMP="${SCRIPT_DIR}/bump-image.sh"
PASS=0; FAIL=0

# Build a throwaway repo whose layout matches a rendered multi-component tenant
# with staging + prod overlays, staging already "live" at 1.2.3.
make_repo() {
  local root; root="$(mktemp -d)"
  mkdir -p "${root}/.devops/ci" "${root}/.devops/chart/overlays/staging" "${root}/.devops/chart/overlays/prod"
  cp "${BUMP}" "${root}/.devops/ci/bump-image.sh"
  cp "${PROMOTE}" "${root}/.devops/ci/promote.sh"
  cat > "${root}/.devops/promotion.yaml" <<'YAML'
apiVersion: platform.capstone/v1
registry: harbor.example.com/team-sample
app: myapp
environments:
  staging:
    trigger: "tag:v*"
    tagConvention: "semver"
    overlay: ".devops/chart/overlays/staging"
    gate: auto
  prod:
    trigger: "manual:promote-to-prod"
    tagConvention: "semver"
    overlay: ".devops/chart/overlays/prod"
    gate: auto
YAML
  cat > "${root}/.devops/chart/overlays/staging/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: team-sample-staging
resources:
  - ../../base
images:
  - name: myapp-frontend
    newName: harbor.example.com/team-sample/myapp-frontend
    newTag: 1.2.3
  - name: myapp-backend
    newName: harbor.example.com/team-sample/myapp-backend
    newTag: 1.2.3
YAML
  cat > "${root}/.devops/chart/overlays/prod/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: team-sample-prod
resources:
  - ../../base
images:
  - name: myapp-frontend
    newName: harbor.example.com/team-sample/myapp-frontend
    newTag: 1.1.0
  - name: myapp-backend
    newName: harbor.example.com/team-sample/myapp-backend
    newTag: 1.1.0
YAML
  ( cd "${root}" && git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init )
  printf '%s' "${root}"
}

count_tag() { local n; n="$(grep -c "newTag: $1" "$2" 2>/dev/null)" || n=0; printf '%s' "${n}"; }
assert_eq() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [$1]: got '$2' want '$3'"; fi; }

echo "== promote.sh tests =="

# 1) staging's live tag (1.2.3) lands in prod's overlay, unwritten.
R1="$(make_repo)"; PK1="${R1}/.devops/chart/overlays/prod/kustomization.yaml"
bash "${R1}/.devops/ci/promote.sh" staging prod >/tmp/promote.log 2>&1; RC=$?
assert_eq "promote rc"          "${RC}" "0"
assert_eq "prod new count"      "$(count_tag '1.2.3' "${PK1}")" "2"
assert_eq "prod old count"      "$(count_tag '1.1.0' "${PK1}")" "0"

# 2) no COMMIT=1 -> the write happens but nothing is committed (dry-write, matches bump-image.sh).
DIRTY="$(git -C "${R1}" status --porcelain)"
case "${DIRTY}" in
  *"overlays/prod/kustomization.yaml"*) PASS=$((PASS+1)) ;;
  *) FAIL=$((FAIL+1)); echo "FAIL [uncommitted]: expected a dirty prod overlay, got: '${DIRTY}'" ;;
esac

# 3) COMMIT=1 promotes AND commits (the GitOps signal) -- FIX-18/D-030: must NOT carry
# `[skip ci]` (permanently suppresses any future tag push on this commit too; see
# bump-image.sh's header comment).
R2="$(make_repo)"
COMMIT=1 bash "${R2}/.devops/ci/promote.sh" staging prod >/tmp/promote.log 2>&1; RC=$?
assert_eq "commit rc" "${RC}" "0"
LAST="$(git -C "${R2}" log -1 --pretty=%s 2>/dev/null)"
case "${LAST}" in
  *"[skip ci]"*) FAIL=$((FAIL+1)); echo "FAIL [commit]: commit subject must NOT carry [skip ci] (FIX-18): '${LAST}'" ;;
  "ci: bump prod images to 1.2.3") PASS=$((PASS+1)) ;;
  *) FAIL=$((FAIL+1)); echo "FAIL [commit]: unexpected commit subject: '${LAST}'" ;;
esac
PK2="${R2}/.devops/chart/overlays/prod/kustomization.yaml"
assert_eq "committed prod tag count" "$(count_tag '1.2.3' "${PK2}")" "2"

# 4) from == to is refused (guard against a no-op / self-promote mistake).
R3="$(make_repo)"
bash "${R3}/.devops/ci/promote.sh" prod prod >/tmp/promote.log 2>&1; RC=$?
assert_eq "same-env rc" "${RC}" "2"

# 5) a mismatched "from" overlay (partial hand-edit) is refused, not silently promoted.
R4="$(make_repo)"
SK4="${R4}/.devops/chart/overlays/staging/kustomization.yaml"
sed -i '0,/newTag: 1.2.3/s//newTag: 9.9.9/' "${SK4}"   # only ONE of the two entries changes
bash "${R4}/.devops/ci/promote.sh" staging prod >/tmp/promote.log 2>&1; RC=$?
assert_eq "mismatched rc" "${RC}" "1"

echo "== FINAL: $PASS passed, $FAIL failed =="
[ "${FAIL}" -eq 0 ]
