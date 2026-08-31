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

# ⚠ MATCH BOTH THE QUOTED AND UNQUOTED FORMS.
# This helper used to grep for a bare `newTag: 1.2.3`, but bump-image.sh (and so
# promote.sh, which delegates the write to it) ALWAYS emits the double-quoted
# form `newTag: "1.2.3"` -- deliberately, because kustomize refuses a bare
# numeric tag ("cannot unmarshal number into ... Image.images.newTag"). So two
# assertions reported FAIL on a promotion that had in fact worked perfectly.
# A suite that always shows 2 red is a suite people stop reading, which is worse
# than no suite. Ported from the ida-llm copy, where this was already fixed.
count_tag() {
  local n
  n="$(grep -cE "newTag: \"?$1\"?" "$2" 2>/dev/null)" || n=0
  printf '%s' "${n}"
}
assert_eq() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [$1]: got '$2' want '$3'"; fi; }

# Isolate the no-yq sed-fallback path (same pattern as bump-image.test.sh).
NOYQ_DIR="$(mktemp -d)"
for b in bash sh sed cut head dirname awk printf cat env grep git mktemp; do
  src="$(command -v "$b" 2>/dev/null)" && [ -n "$src" ] && ln -sf "$src" "${NOYQ_DIR}/$b"
done

# Build a repo whose staging overlay is QUOTED, i.e. what staging's kustomization.yaml
# ACTUALLY looks like after a real bump-image.sh write (which always double-quotes) --
# unlike make_repo()'s hand-written bare `newTag: 1.2.3` fixtures above, which never
# exercised the real-world shape and so never caught FIX-23.
make_quoted_repo() {
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
    newTag: "1.0.0"
  - name: myapp-backend
    newName: harbor.example.com/team-sample/myapp-backend
    newTag: "1.0.0"
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
    newTag: v0.9.0
  - name: myapp-backend
    newName: harbor.example.com/team-sample/myapp-backend
    newTag: v0.9.0
YAML
  ( cd "${root}" && git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init )
  printf '%s' "${root}"
}

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

# 4b) an env with NO overlay mapping in promotion.yaml is refused, and refused
# LOUDLY. Added because a mutation run (#187) showed this guard had zero coverage:
# deleting `if [ -z "${FROM_OVERLAY}" ] ...` from promote.sh left the suite 16/16
# green. Without the guard, FROM_OVERLAY is empty, FROM_KUSTOMIZATION collapses to
# "<repo>//kustomization.yaml", and promote.sh fails one line later with a path
# error instead of naming the env -- so assert on the MESSAGE, not just the code,
# or the next person to delete the guard passes this test anyway.
R3b="$(make_repo)"
bash "${R3b}/.devops/ci/promote.sh" nosuchenv prod >/tmp/promote.log 2>&1; RC=$?
assert_eq "unmapped-env rc" "${RC}" "1"
assert_eq "unmapped-env names the env" \
  "$(grep -c "no overlay mapping for env 'nosuchenv'" /tmp/promote.log)" "1"

# 5) a mismatched "from" overlay (partial hand-edit) is refused, not silently promoted.
R4="$(make_repo)"
SK4="${R4}/.devops/chart/overlays/staging/kustomization.yaml"
sed -i '0,/newTag: 1.2.3/s//newTag: 9.9.9/' "${SK4}"   # only ONE of the two entries changes
bash "${R4}/.devops/ci/promote.sh" staging prod >/tmp/promote.log 2>&1; RC=$?
assert_eq "mismatched rc" "${RC}" "1"

# 6) FIX-23 regression: staging is quoted (newTag: "1.0.0", the real post-bump-image.sh
# shape) -- promoting it must NOT double-quote prod. yq path (default PATH). yq's
# strenv only quotes when the bare value would otherwise parse as a non-string YAML
# type; "1.0.0" (two dots) is never ambiguous with a YAML number, so yq correctly
# writes it BARE here -- both `newTag: 1.0.0` and `newTag: "1.0.0"` are valid,
# equivalent YAML, so the assertion is quote-tolerant (same pattern bump-image.test.sh
# uses), unlike case 7 below where the sed fallback always quotes by design.
R5="$(make_quoted_repo)"; PK5="${R5}/.devops/chart/overlays/prod/kustomization.yaml"
bash "${R5}/.devops/ci/promote.sh" staging prod >/tmp/promote.log 2>&1; RC=$?
assert_eq "quoted/yq promote rc"       "${RC}" "0"
assert_eq "quoted/yq no double-quote"  "$(grep -c 'newTag: ""' "${PK5}")" "0"
assert_eq "quoted/yq bare-or-quoted tag" "$(grep -Ec 'newTag: "?1\.0\.0"?$' "${PK5}")" "2"

# 7) same regression, no-yq sed fallback (the actual reported failure mode -- prod
# ships this way because node:24-trixie, the real CI runner image, has no yq).
if PATH="${NOYQ_DIR}" command -v yq >/dev/null 2>&1; then
  echo "NOTE: yq present on restricted PATH — sed fallback not isolated; skipping FIX-23 sed regression"
else
  R6="$(make_quoted_repo)"; PK6="${R6}/.devops/chart/overlays/prod/kustomization.yaml"
  PATH="${NOYQ_DIR}" bash "${R6}/.devops/ci/promote.sh" staging prod >/tmp/promote.log 2>&1; RC=$?
  assert_eq "quoted/sed promote rc"        "${RC}" "0"
  assert_eq "quoted/sed no double-quote"   "$(grep -c 'newTag: ""' "${PK6}")" "0"
  assert_eq "quoted/sed single-quoted tag" "$(grep -c 'newTag: "1.0.0"' "${PK6}")" "2"
  # The regression as originally reported: LIVE_TAG carrying literal quote characters
  # (7 chars for "1.0.0" instead of 5) is exactly what produced `newTag: ""1.0.0""`.
  assert_eq "quoted/sed no stray quote pairs" "$(grep -c 'newTag: """' "${PK6}")" "0"
fi

echo "== FINAL: $PASS passed, $FAIL failed =="
[ "${FAIL}" -eq 0 ]
