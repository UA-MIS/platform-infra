#!/usr/bin/env bash
# Tests for hack/tenant-onboarding-reconcile.py.
#
# ── WHY THIS EXISTS, AND WHY IT STUBS `gh` ──────────────────────────────────────
# The check's whole value is that it FAILS when a tenant is invisible to the portal.
# A check is not "working" because it passes against today's fleet — it is working when
# it has been PROVEN to fail on a known-bad input. So every case below feeds it a
# synthetic fleet and asserts the exit code and the finding it must produce.
#
# `gh` is stubbed from a fixture directory, which makes this hermetic: no network, no
# credentials, and runnable on a PR branch that cannot be trusted with the org-wide
# read token. It also lets us inject the responses a live fleet will not produce on
# demand — a 403, a 500, a malformed body — which is where the interesting failures are.
#
# ── THE CASE THAT MATTERS MOST ──────────────────────────────────────────────────
# `topic_403_is_not_absent`. A check that concludes "the topic is missing" from a 403
# would report a finding it cannot support; worse, the mirror-image bug (concluding
# "present" from an error) would report a BROKEN tenant as clean. An empty result from a
# probe that cannot see is indistinguishable from a true negative unless the probe is
# built to tell them apart, and this platform has lost real time to exactly that. So the
# script must exit 2 on any non-404, and this asserts it does.
#
# RUN: hack/tenant-onboarding-reconcile.test.sh    (also run by `make validate`)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/tenant-onboarding-reconcile.py"
PASS=0
FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A stub `gh` that answers from $GH_FIXTURE. A fixture file named after the sanitized
# API path is a 200; its absence is a 404 (which the script must treat as "the thing is
# not there"); a sibling `.rc`/`.err` pair injects any other failure.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
# argv: api -X GET <path>
path="${!#}"
key="$(printf '%s' "$path" | tr '/?=&' '____')"
f="$GH_FIXTURE/$key"
if [ -f "$f.err" ]; then
  cat "$f.err" >&2
  exit "$(cat "$f.rc" 2>/dev/null || echo 1)"
fi
if [ -f "$f.json" ]; then
  cat "$f.json"
  exit 0
fi
echo "gh: HTTP 404: Not Found (https://api.github.com/$path)" >&2
exit 1
STUB
chmod +x "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH"

# ── fixture helpers ─────────────────────────────────────────────────────────────
new_case() {                      # new_case <name> -> sets ROOT and GH_FIXTURE
  CASE="$1"
  ROOT="$WORK/$CASE/root"; GH_FIXTURE="$WORK/$CASE/fx"
  # BOTH claim sources must exist: a missing one is Fatal by design, so every case
  # starts from the real directory layout.
  mkdir -p "$ROOT/tenants/_claims" "$ROOT/tenants/_vm-claims" "$GH_FIXTURE"
  export GH_FIXTURE
}

claim() {                         # claim <team> <app>   (container: team/appName under spec)
  cat > "$ROOT/tenants/_claims/$1-$2.yaml" <<YAML
apiVersion: platform.capstone.uamishub.com/v1alpha1
kind: CapstoneTenant
metadata:
  name: $1-$2
spec:
  team: "$1"
  appName: "$2"
  semester: "2026-fall"
YAML
}

vm_claim() {                      # vm_claim <team> <app>   (VM: team/appName at top level)
  cat > "$ROOT/tenants/_vm-claims/$1-$2.yaml" <<YAML
apiVersion: platform.capstone/v1
kind: VmTenantLedger
metadata:
  name: $1-$2
team: $1
appName: $2
semester: 2026-fall
layout: vm
YAML
}

fx() { printf '%s' "$2" > "$GH_FIXTURE/$(printf '%s' "$1" | tr '/?=&' '____').json"; }
fx_err() {                        # fx_err <path> <rc> <stderr>
  local k; k="$(printf '%s' "$1" | tr '/?=&' '____')"
  printf '%s' "$2" > "$GH_FIXTURE/$k.rc"; printf '%s' "$3" > "$GH_FIXTURE/$k.err"
}

catalog_info_b64() {              # catalog_info_b64 <owner-ref>
  printf 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: x\nspec:\n  owner: %s\n' "$1" | base64 -w0
}

# The GitHub side of a fully healthy tenant: repo exists, topic set, catalog-info
# present with an owner matching the team.
repo_ok() {                       # repo_ok <team> <app>
  fx "repos/UA-MIS/$2" '{"archived":false,"default_branch":"main"}'
  fx "repos/UA-MIS/$2/topics" '{"names":["capstone-tenant"]}'
  fx "repos/UA-MIS/$2/contents/catalog-info.yaml" \
     "{\"content\":\"$(catalog_info_b64 "group:default/$1")\"}"
}

healthy()    { claim "$1" "$2";    repo_ok "$1" "$2"; }   # healthy container tenant
vm_healthy() { vm_claim "$1" "$2"; repo_ok "$1" "$2"; }   # healthy VM tenant

# Every case needs at least one claim in EACH source, or the empty source is itself a
# finding (by design). This is the minimum healthy platform the cases build on.
baseline() { healthy curb curb-web; vm_healthy paper-papas paper-papas; }

expect() {                        # expect <wanted-rc> <substring|-> ; reads $OUT
  local want="$1" needle="$2"
  if [ "$RC" != "$want" ]; then
    echo "  FAIL $CASE: expected exit $want, got $RC"
    echo "$OUT" | sed 's/^/        /' | head -12
    FAIL=$((FAIL+1)); return
  fi
  if [ "$needle" != "-" ] && ! grep -qF -- "$needle" <<<"$OUT"; then
    echo "  FAIL $CASE: exit $RC correct but output lacks '$needle'"
    echo "$OUT" | sed 's/^/        /' | head -12
    FAIL=$((FAIL+1)); return
  fi
  echo "  ok   $CASE (exit $RC)"
  PASS=$((PASS+1))
}

run() { OUT="$(python3 "$CHECK" --repo-root "$ROOT" 2>&1)"; RC=$?; }

echo "tenant-onboarding-reconcile: behaviour tests"

# ── 0 — the happy path must actually pass, or every failure below is meaningless ──
new_case clean_fleet_passes
baseline
healthy nextup next-up
run; expect 0 "OK: every claimed tenant"

# ── 1 — THE surfers regression: provisioned, healthy-looking, no topic ───────────
new_case missing_topic_is_a_finding
baseline
claim surfers surfer
fx "repos/UA-MIS/surfer" '{"archived":false,"default_branch":"main"}'
fx "repos/UA-MIS/surfer/topics" '{"names":[]}'
fx "repos/UA-MIS/surfer/contents/catalog-info.yaml" \
   "{\"content\":\"$(catalog_info_b64 group:default/surfers)\"}"
run; expect 1 "[catalog-topic] surfers"

# ── 2 — an owner that disagrees with the claim's team (the subtle Vault-path bug) ─
new_case owner_mismatch_is_a_finding
baseline
claim surfers surfer
fx "repos/UA-MIS/surfer" '{"archived":false,"default_branch":"main"}'
fx "repos/UA-MIS/surfer/topics" '{"names":["capstone-tenant"]}'
fx "repos/UA-MIS/surfer/contents/catalog-info.yaml" \
   "{\"content\":\"$(catalog_info_b64 group:default/surfer)\"}"
run; expect 1 "[owner-matches-team] surfers"

# ── 3 — topic set but nothing for the provider to read (the real springais state) ─
new_case missing_catalog_info_is_a_finding
baseline
claim springais springais
fx "repos/UA-MIS/springais" '{"archived":false,"default_branch":"main"}'
fx "repos/UA-MIS/springais/topics" '{"names":["capstone-tenant"]}'
run; expect 1 "[catalog-info-present] springais"

# ── 4 — a claim naming a repo that is not there ─────────────────────────────────
new_case missing_repo_is_a_finding
baseline
claim ghost ghost-app
run; expect 1 "[repo-exists] ghost"

# ── 5 — archived repo still carrying a live claim (half-finished teardown) ──────
new_case archived_with_live_claim_is_a_finding
baseline
claim retired retired-app
fx "repos/UA-MIS/retired-app" '{"archived":true,"default_branch":"main"}'
fx "repos/UA-MIS/retired-app/topics" '{"names":["capstone-tenant"]}'
fx "repos/UA-MIS/retired-app/contents/catalog-info.yaml" \
   "{\"content\":\"$(catalog_info_b64 group:default/retired)\"}"
run; expect 1 "[repo-archived] retired"

# ── 6 — THE discrimination test: a 403 is NOT "the topic is absent" ─────────────
# Must exit 2 (untrustworthy), NOT 1 (a finding it cannot support) and NOT 0.
new_case topic_403_is_not_absent
baseline
claim surfers surfer
fx "repos/UA-MIS/surfer" '{"archived":false,"default_branch":"main"}'
fx_err "repos/UA-MIS/surfer/topics" 1 "gh: HTTP 403: Resource not accessible by integration"
run; expect 2 "COULD NOT BE TRUSTED"

# ── 7 — a 500 on the repo read is likewise never "the repo does not exist" ─────
new_case repo_500_is_not_absent
baseline
claim surfers surfer
fx_err "repos/UA-MIS/surfer" 1 "gh: HTTP 500: Internal Server Error"
run; expect 2 "failed non-404"

# ── 8 — a malformed topics body must not become "topic absent" ─────────────────
new_case malformed_topics_body_is_fatal
baseline
claim surfers surfer
fx "repos/UA-MIS/surfer" '{"archived":false,"default_branch":"main"}'
fx "repos/UA-MIS/surfer/topics" '{"unexpected":"shape"}'
run; expect 2 "no 'names' key"

# ── 9 — an empty platform is an outage of the check, not a clean result ────────
new_case zero_claims_is_fatal
run; expect 2 "ZERO tenant claims"

# ── 10 — a claim we cannot reconcile must stop the run, not be skipped ────────
new_case claim_missing_team_is_fatal
baseline
cat > "$ROOT/tenants/_claims/broken.yaml" <<'YAML'
apiVersion: platform.capstone.uamishub.com/v1alpha1
kind: CapstoneTenant
metadata:
  name: broken
spec:
  appName: "orphan"
YAML
run; expect 2 "both are required to reconcile"

# ── 11 — unparseable YAML is fatal, never ignored ─────────────────────────────
new_case bad_yaml_is_fatal
baseline
printf 'kind: CapstoneTenant\nspec: [this: is, not: valid\n' \
  > "$ROOT/tenants/_claims/bad.yaml"
run; expect 2 "unparseable YAML"

# ── 12 — `_`-prefixed docs are templates, and must not count as tenants ──────
new_case underscore_files_are_not_claims
baseline
cp "$ROOT/tenants/_claims/curb-curb-web.yaml" "$ROOT/tenants/_claims/_example.yaml"
sed -i 's/"curb-web"/"does-not-exist"/' "$ROOT/tenants/_claims/_example.yaml"
run; expect 0 "tenants/_claims=1"

# ── 13 — --json carries the findings and never implies ingestion was proven ──
new_case json_output_is_honest
baseline
claim surfers surfer
fx "repos/UA-MIS/surfer" '{"archived":false,"default_branch":"main"}'
fx "repos/UA-MIS/surfer/topics" '{"names":[]}'
fx "repos/UA-MIS/surfer/contents/catalog-info.yaml" \
   "{\"content\":\"$(catalog_info_b64 group:default/surfers)\"}"
OUT="$(python3 "$CHECK" --repo-root "$ROOT" --json 2>&1)"; RC=$?
expect 1 '"proves_ingestion": false'

# ── 14 — VM tenants are COVERED, not silently skipped. The first draft of the ──
# check read only tenants/_claims and printed a clean result over all three VM
# tenants; this is the regression test for that.
new_case vm_tenant_is_checked
healthy curb curb-web
vm_claim paper-papas paper-papas
fx "repos/UA-MIS/paper-papas" '{"archived":false,"default_branch":"main"}'
fx "repos/UA-MIS/paper-papas/topics" '{"names":[]}'
fx "repos/UA-MIS/paper-papas/contents/catalog-info.yaml" \
   "{\"content\":\"$(catalog_info_b64 group:default/paper-papas)\"}"
run; expect 1 "[catalog-topic] paper-papas"

# ── 15 — the VM schema keeps team/appName at the TOP level, not under spec: ───
# Reading the wrong level would yield None for every VM tenant, which must be Fatal
# rather than a skip. A healthy VM claim parsing correctly proves the right level.
new_case vm_schema_top_level_fields
baseline
run; expect 0 "tenants/_vm-claims=1"

# ── 16 — an empty claim source is reported, never passed over in silence ──────
new_case empty_claim_source_is_a_finding
healthy curb curb-web
run; expect 1 "[claim-source-empty]"

# ── 17 — a missing claim DIRECTORY is an outage of the check's coverage ───────
new_case missing_claim_source_dir_is_fatal
baseline
rm -rf "$ROOT/tenants/_vm-claims"
run; expect 2 "blind to a whole tenant class"

# ── 18 — an unrecognised tenant kind must stop the run, not be filtered out ───
# This is how a NEW tenant class would arrive: a third kind nobody added to
# CLAIM_SOURCES. Skipping it would reproduce the VM blind spot all over again.
new_case unknown_kind_is_fatal
baseline
cat > "$ROOT/tenants/_claims/future.yaml" <<'YAML'
apiVersion: platform.capstone/v1
kind: SomeFutureTenantKind
metadata:
  name: future
spec:
  team: "future"
  appName: "future-app"
YAML
run; expect 2 "needs adding to CLAIM_SOURCES"

echo
echo "tenant-onboarding-reconcile tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
