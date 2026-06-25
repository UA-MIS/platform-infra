#!/usr/bin/env bash
# resolve-image.test.sh — unit tests for resolve-image.sh (the trigger->image map).
# Self-contained: builds a temp promotion.yaml fixture, drives resolve-image.sh
# with synthetic GitHub event env vars, asserts the emitted KEY=VALUE lines.
# Requires: bash, yq. Run: .devops/ci/resolve-image.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLVER="${SCRIPT_DIR}/resolve-image.sh"
PASS=0; FAIL=0

# A promotion.yaml fixture in the Harbor (Phase-2) shape: registry carries the
# per-team project (harbor.../<name>), app is the image name. resolve-image.sh
# composes IMAGE = <registry>/<app>:<tag> = harbor.../<name>/<app>:<tag> (D-026).
FIX="$(mktemp -d)/promotion.yaml"
cat > "${FIX}" <<'YAML'
apiVersion: platform.capstone/v1
registry: harbor.127-0-0-1.sslip.io/sample
app: sample
environments:
  dev:     { trigger: "branch:main",   tagConvention: "git-describe", overlay: ".devops/chart/overlays/dev",     gate: auto }
  staging: { trigger: "tag:v*",        tagConvention: "semver",       overlay: ".devops/chart/overlays/staging", gate: auto }
  prod:    { trigger: "tag:v*",        tagConvention: "semver",       overlay: ".devops/chart/overlays/prod",    gate: manual }
  preview: { trigger: "pull_request",  tagConvention: "pull-<sha>",   overlay: ".devops/chart/overlays/preview", gate: auto }
YAML

# run <name> <event> <ref> <sha> -> captures stdout into $OUT, rc into $RC
run() {
  OUT="$(PROMOTION="${FIX}" GITHUB_EVENT_NAME="$2" GITHUB_REF="$3" GITHUB_SHA="$4" \
         bash "${RESOLVER}" 2>/tmp/resolve.err)"
  RC=$?
}
# assert_kv <case> <KEY> <expected-value>
assert_kv() {
  local got; got="$(printf '%s\n' "${OUT}" | sed -n "s/^$2=//p")"
  if [ "${got}" = "$3" ]; then PASS=$((PASS+1));
  else FAIL=$((FAIL+1)); echo "FAIL [$1] $2: got '${got}' want '$3'"; fi
}
assert_rc() {
  if [ "${RC}" = "$2" ]; then PASS=$((PASS+1));
  else FAIL=$((FAIL+1)); echo "FAIL [$1] rc: got ${RC} want $2 (stderr: $(cat /tmp/resolve.err))"; fi
}
# assert_match <case> <KEY> <ERE> — for non-deterministic values (git-describe output
# depends on the live repo's tags), assert the emitted value MATCHES a pattern.
assert_match() {
  local got; got="$(printf '%s\n' "${OUT}" | sed -n "s/^$2=//p")"
  if printf '%s' "${got}" | grep -Eq "$3"; then PASS=$((PASS+1));
  else FAIL=$((FAIL+1)); echo "FAIL [$1] $2: got '${got}' does not match /$3/"; fi
}

echo "== resolve-image.sh tests =="

# 1) push to main -> dev, git-describe tag, PUSH (D-030 non-prod mutable tag, Model A).
# The dev TAG comes from `git describe --tags --always` against the resolver's own repo
# root, so its exact value depends on the live repo's tags — assert ENV/PUSH exactly and
# the TAG/IMAGE by SHAPE (a git-describe tag: vX.Y.Z[-N-g<sha>], or a bare short-sha
# fallback). The exact-value cases live in the isolated-repo block below.
run "main->dev" push "refs/heads/main" "9b08056abcdef1234567890"
assert_rc "main->dev" 0
assert_kv "main->dev" ENV dev
assert_kv "main->dev" PUSH true
# git-describe tag (v1.2.3 or v1.2.3-5-gabc1234) OR bare 7+ hex sha (--always fallback).
assert_match "main->dev" TAG '^(v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+-g[0-9a-f]+)?|[0-9a-f]{7,})$'
assert_match "main->dev" IMAGE '^harbor\.127-0-0-1\.sslip\.io/sample/sample:.+$'

# 2) push tag vX.Y.Z -> prod, IMMUTABLE semver, PUSH (the prod-gate promotion tag)
run "tag->prod" push "refs/tags/v1.4.0" "deadbeefcafef00d"
assert_rc "tag->prod" 0
assert_kv "tag->prod" ENV prod
assert_kv "tag->prod" TAG 1.4.0
assert_kv "tag->prod" PUSH true
assert_kv "tag->prod" IMAGE "harbor.127-0-0-1.sslip.io/sample/sample:1.4.0"

# 3) pull_request -> preview, build-only (NO push) — untrusted-code guard
run "pr->preview" pull_request "refs/pull/7/merge" "abc1234def"
assert_rc "pr->preview" 0
assert_kv "pr->preview" ENV preview
assert_kv "pr->preview" TAG pull-abc1234
assert_kv "pr->preview" PUSH false

# 4) push to a non-main branch -> rejected (only main + v* tags build)
run "feature-branch" push "refs/heads/feature-x" "abc1234"
assert_rc "feature-branch" 1

# 5) a non-semver tag -> rejected (never build an unlabelled prod image)
run "bad-tag" push "refs/tags/vlatest" "abc1234"
assert_rc "bad-tag" 1

# 6) missing event -> rejected with usage rc 2
run "no-event" "" "" ""
assert_rc "no-event" 2

echo "== $PASS passed, $FAIL failed =="
[ "${FAIL}" -eq 0 ]

# ---- no-yq fallback path (the resolver runs inside the busybox Kaniko image) --
# Re-run the core cases with yq hidden from PATH to exercise the sed/static
# fallback reader; results must be identical.
echo "== no-yq fallback (sed reader) =="
# Build an isolated bin dir with symlinks to ONLY the coreutils the resolver needs
# (no yq), and point PATH at it exclusively — so `command -v yq` genuinely fails
# and the sed fallback runs (mirrors the busybox Kaniko image where yq is absent).
NOYQ_DIR="$(mktemp -d)"
for b in sh sed cut head dirname git cat env printf; do
  src="$(command -v "$b" 2>/dev/null)" && [ -n "$src" ] && ln -sf "$src" "${NOYQ_DIR}/$b"
done
run_noyq() {
  OUT="$(PROMOTION="${FIX}" GITHUB_EVENT_NAME="$2" GITHUB_REF="$3" GITHUB_SHA="$4" \
         PATH="${NOYQ_DIR}" \
         sh "${RESOLVER}" 2>/tmp/resolve.err)"
  RC=$?
}
# Confirm yq is genuinely absent on the restricted PATH (else this test is moot).
if PATH="${NOYQ_DIR}" command -v yq >/dev/null 2>&1; then
  echo "NOTE: yq present on /usr/bin|/bin — fallback path not isolated; skipping no-yq asserts"
else
  run_noyq "noyq-main" push "refs/heads/main" "9b08056abcdef"
  assert_rc "noyq-main" 0
  # dev = git-describe (no-yq static map still picks git-describe for dev) — shape-assert.
  assert_match "noyq-main" IMAGE '^harbor\.127-0-0-1\.sslip\.io/sample/sample:.+$'
  run_noyq "noyq-tag" push "refs/tags/v2.0.1" "deadbeef"
  assert_rc "noyq-tag" 0
  assert_kv "noyq-tag" IMAGE "harbor.127-0-0-1.sslip.io/sample/sample:2.0.1"
  run_noyq "noyq-pr" pull_request "refs/pull/3/merge" "cafef00dbabe"
  assert_rc "noyq-pr" 0
  assert_kv "noyq-pr" PUSH false
  assert_kv "noyq-pr" TAG pull-cafef00
fi

# ---- git-describe exact-value path (isolated temp repo) ---------------------
# resolve-image.sh describes against its OWN repo root (${DEVOPS_DIR}/..), so to test
# exact git-describe output we copy the resolver into a throwaway repo with known tags
# and run it FROM there. Proves Model A's readable dev tag end to end:
#   - at the seeded base tag v0.0.0           -> TAG = v0.0.0
#   - one commit past it                       -> TAG = v0.0.0-1-g<sha>
#   - a repo with NO tags (--always fallback)  -> TAG = bare short sha
echo "== git-describe (isolated repo) =="
if command -v git >/dev/null 2>&1; then
  GD_ROOT="$(mktemp -d)"
  mkdir -p "${GD_ROOT}/.devops/ci"
  cp "${RESOLVER}" "${GD_ROOT}/.devops/ci/resolve-image.sh"
  cp "${FIX}" "${GD_ROOT}/.devops/promotion.yaml"   # promotion.yaml beside the resolver's ..
  (
    cd "${GD_ROOT}"
    git init -q && git config user.email t@t && git config user.name t
    git commit -q --allow-empty -m init
    git tag -a v0.0.0 -m v0.0.0   # annotated: robust if git config demands a tag message
  )
  # GITHUB_SHA empty so git_describe() uses the repo (not the env sha); PROMOTION default
  # resolves to ../promotion.yaml beside the copied resolver.
  gd_run() { OUT="$(GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main GITHUB_SHA="" \
                    bash "${GD_ROOT}/.devops/ci/resolve-image.sh" 2>/tmp/resolve.err)"; RC=$?; }

  gd_run
  assert_rc "gd-at-tag" 0
  assert_kv "gd-at-tag" TAG "v0.0.0"

  ( cd "${GD_ROOT}" && git commit -q --allow-empty -m next )
  gd_run
  assert_rc "gd-past-tag" 0
  assert_match "gd-past-tag" TAG '^v0\.0\.0-1-g[0-9a-f]+$'

  # No-tag repo -> --always degrades to a bare short sha (does not fail the build).
  NT_ROOT="$(mktemp -d)"; mkdir -p "${NT_ROOT}/.devops/ci"
  cp "${RESOLVER}" "${NT_ROOT}/.devops/ci/resolve-image.sh"
  cp "${FIX}" "${NT_ROOT}/.devops/promotion.yaml"
  ( cd "${NT_ROOT}" && git init -q && git config user.email t@t && git config user.name t \
      && git commit -q --allow-empty -m init )
  OUT="$(GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main GITHUB_SHA="" \
         bash "${NT_ROOT}/.devops/ci/resolve-image.sh" 2>/tmp/resolve.err)"; RC=$?
  assert_rc "gd-no-tag" 0
  assert_match "gd-no-tag" TAG '^[0-9a-f]{7,}$'
else
  echo "NOTE: git not available — skipping git-describe isolated-repo asserts"
fi

echo "== FINAL: $PASS passed, $FAIL failed =="
[ "${FAIL}" -eq 0 ]
