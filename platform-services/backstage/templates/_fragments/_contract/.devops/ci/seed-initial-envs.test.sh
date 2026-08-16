#!/usr/bin/env bash
# seed-initial-envs.test.sh — unit tests for the FIRST-DEPLOY seed (seed-initial-envs.sh).
# Builds a temp repo (promotion.yaml + dev/staging/prod overlays with N images[] entries),
# runs the seed, and asserts:
#   1) FIRST build: staging+prod (both at the v0.0.0 sentinel) get seeded to the built tag,
#      every component rewritten; dev is NOT touched by the seed (bump-dev owns dev).
#   2) SUBSEQUENT build: staging/prod already at a real tag are LEFT UNCHANGED (promotion
#      gate preserved) — the seed is a one-time initial condition, not auto-prod.
#   3) COMMIT=1 makes a commit per seeded env (the GitOps signal; no `[skip ci]` -- see
#      bump-image.sh's header comment, FIX-18/D-030).
#   4) A mobile-artifact-only overlay (no images[]) is a safe no-op.
# Exercises both the yq path and the no-yq awk/sed fallback. Requires: bash, git (yq optional).
# Run: .devops/ci/seed-initial-envs.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED="${SCRIPT_DIR}/seed-initial-envs.sh"
BUMP="${SCRIPT_DIR}/bump-image.sh"
PASS=0; FAIL=0

# A throwaway repo matching a rendered multi-component tenant: dev/staging/prod overlays,
# every images[].newTag at the v0.0.0 sentinel (the fresh-scaffold initial condition).
make_repo() {
  local root; root="$(mktemp -d)"
  mkdir -p "${root}/.devops/ci" \
           "${root}/.devops/chart/overlays/dev" \
           "${root}/.devops/chart/overlays/staging" \
           "${root}/.devops/chart/overlays/prod"
  cp "${SEED}" "${root}/.devops/ci/seed-initial-envs.sh"
  cp "${BUMP}" "${root}/.devops/ci/bump-image.sh"
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
  for env in dev staging prod; do
    cat > "${root}/.devops/chart/overlays/${env}/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
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
  done
  ( cd "${root}" && git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init )
  printf '%s' "${root}"
}

# A repo whose staging/prod have NO images[] (mobile-artifact-only shape).
make_repo_noimages() {
  local root; root="$(make_repo)"
  for env in staging prod; do
    cat > "${root}/.devops/chart/overlays/${env}/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
YAML
  done
  ( cd "${root}" && git add -A && git commit -qm noimages )
  printf '%s' "${root}"
}

NOYQ_DIR="$(mktemp -d)"
for b in bash sh sed cut head dirname awk printf cat env grep git; do
  src="$(command -v "$b" 2>/dev/null)" && [ -n "$src" ] && ln -sf "$src" "${NOYQ_DIR}/$b"
done

# Quote-tolerant (same fix as bump-image.test.sh's own count_tag, FIX-24): bump-image.sh
# ALWAYS quotes on the sed fallback (unconditionally -- it can't do YAML-aware
# conditional quoting the way yq's strenv can) but only conditionally on the yq path
# (strenv leaves an unambiguous non-numeric-looking string like "abc1234" or "7.7.7"
# bare). A bare `newTag: $1` grep silently never matched the sed-fallback cases (4) here
# -- a pre-existing test bug, not a script bug: seed-initial-envs.sh + bump-image.sh
# wrote the correct value with exit 0 every time, confirmed by hand-tracing this exact
# scenario with `bash -x`; only this assertion helper was stale.
count_tag() { local n; n="$(grep -Ec "newTag: \"?$1\"?" "$2" 2>/dev/null)" || n=0; printf '%s' "${n}"; }
assert_eq() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL [$1]: got '$2' want '$3'"; fi; }

echo "== seed-initial-envs.sh tests =="

# 1) yq path — FIRST build: staging+prod seeded to the built tag; dev untouched by seed.
R1="$(make_repo)"
DEV1="${R1}/.devops/chart/overlays/dev/kustomization.yaml"
STG1="${R1}/.devops/chart/overlays/staging/kustomization.yaml"
PRD1="${R1}/.devops/chart/overlays/prod/kustomization.yaml"
sh "${R1}/.devops/ci/seed-initial-envs.sh" "abc1234" >/tmp/seed.log 2>&1; RC=$?
assert_eq "yq rc"            "${RC}" "0"
assert_eq "yq staging seeded" "$(count_tag 'abc1234' "${STG1}")" "2"
assert_eq "yq prod seeded"    "$(count_tag 'abc1234' "${PRD1}")" "2"
assert_eq "yq staging no-sentinel" "$(count_tag 'v0.0.0' "${STG1}")" "0"
assert_eq "yq dev untouched"  "$(count_tag 'v0.0.0' "${DEV1}")" "2"

# 2) SUBSEQUENT build — staging/prod already at a real tag are LEFT UNCHANGED.
R2="$(make_repo)"
STG2="${R2}/.devops/chart/overlays/staging/kustomization.yaml"
PRD2="${R2}/.devops/chart/overlays/prod/kustomization.yaml"
sh "${R2}/.devops/ci/seed-initial-envs.sh" "first99" >/tmp/seed.log 2>&1   # first deploy
sh "${R2}/.devops/ci/seed-initial-envs.sh" "second88" >/tmp/seed.log 2>&1  # a later push
assert_eq "gate staging kept" "$(count_tag 'first99' "${STG2}")" "2"
assert_eq "gate prod kept"    "$(count_tag 'first99' "${PRD2}")" "2"
assert_eq "gate staging not-bumped" "$(count_tag 'second88' "${STG2}")" "0"
assert_eq "gate prod not-bumped"    "$(count_tag 'second88' "${PRD2}")" "0"

# 3) COMMIT=1 makes a commit for a seeded env -- FIX-18/D-030: must NOT carry `[skip ci]`
# (permanently suppresses any future tag push on this commit too; see bump-image.sh's
# header comment).
R3="$(make_repo)"
COMMIT=1 sh "${R3}/.devops/ci/seed-initial-envs.sh" "9.9.9" >/tmp/seed.log 2>&1
LAST="$(git -C "${R3}" log -1 --pretty=%s 2>/dev/null)"
case "${LAST}" in
  *"[skip ci]"*) FAIL=$((FAIL+1)); echo "FAIL [commit]: commit subject must NOT carry [skip ci] (FIX-18): '${LAST}'" ;;
  "ci: bump prod images to 9.9.9") PASS=$((PASS+1)) ;;
  *) FAIL=$((FAIL+1)); echo "FAIL [commit]: unexpected commit subject: '${LAST}'" ;;
esac
# both staging + prod seeds committed -> 2 commits on top of the 1 init.
NCOMMITS="$(git -C "${R3}" rev-list --count HEAD 2>/dev/null)"
assert_eq "commit count" "${NCOMMITS}" "3"

# 4) no-yq awk/sed fallback — same FIRST-build seed with yq hidden from PATH.
if PATH="${NOYQ_DIR}" command -v yq >/dev/null 2>&1; then
  echo "NOTE: yq present on restricted PATH — awk/sed fallback not isolated; skipping"
else
  R4="$(make_repo)"
  STG4="${R4}/.devops/chart/overlays/staging/kustomization.yaml"
  PRD4="${R4}/.devops/chart/overlays/prod/kustomization.yaml"
  PATH="${NOYQ_DIR}" sh "${R4}/.devops/ci/seed-initial-envs.sh" "7.7.7" >/tmp/seed.log 2>&1; RC=$?
  assert_eq "noyq rc"            "${RC}" "0"
  assert_eq "noyq staging seeded" "$(count_tag '7.7.7' "${STG4}")" "2"
  assert_eq "noyq prod seeded"    "$(count_tag '7.7.7' "${PRD4}")" "2"
fi

# 5) mobile-artifact-only (no images[]) — safe no-op, rc 0.
R5="$(make_repo_noimages)"
sh "${R5}/.devops/ci/seed-initial-envs.sh" "xyz" >/tmp/seed.log 2>&1; RC=$?
assert_eq "noimages rc" "${RC}" "0"

echo "== FINAL: $PASS passed, $FAIL failed =="
[ "${FAIL}" -eq 0 ]
