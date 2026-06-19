#!/usr/bin/env bash
#
# M2 acceptance — backend-boundary check (plan §5 step 5, the security-meaningful test).
#
# Proves per-team catalog visibility is ENFORCED SERVER-SIDE by the permission policy, not
# merely hidden in the UI. It hits the catalog API directly with a real signed-in user's
# Backstage token and confirms the response is already filtered to that user's owned
# entities. A silent ALLOW-all regression (permission.enabled unset, policy not registered,
# or empty ownershipEntityRefs misread as allow) would show OTHER teams' entities here.
#
# This is a POST-DEPLOY manual check (it needs the live portal + real GitHub-org ingestion).
# The in-monorepo unit tests (packages/backend/src/modules/permissionPolicy.test.ts) cover
# the policy's decision logic offline; this script is the live boundary proof.
#
# Usage:
#   1. Sign in to https://process.capstone.uamishub.com as a member of exactly one team.
#   2. Grab the Backstage token: DevTools > Application > Local Storage, or
#      `curl`-copy from a Network request's `Authorization: Bearer <token>` header.
#   3. BACKSTAGE_TOKEN=<token> EXPECT_TEAM=<your-team-slug> \
#        ./m2-acceptance-backend-filter.sh
#
# Exit 0 = every returned entity is owned by one of the caller's groups (boundary holds).
# Exit 1 = an entity owned by a team the caller is NOT on came back (boundary BROKEN).
set -euo pipefail

BASE_URL="${BASE_URL:-https://process.capstone.uamishub.com}"
TOKEN="${BACKSTAGE_TOKEN:?set BACKSTAGE_TOKEN to a signed-in users Backstage token}"
EXPECT_TEAM="${EXPECT_TEAM:-}"

echo "==> GET ${BASE_URL}/api/catalog/entities?filter=kind=component (as the signed-in user)"
RESP="$(curl -fsS -H "Authorization: Bearer ${TOKEN}" \
  "${BASE_URL}/api/catalog/entities?filter=kind=component")"

COUNT="$(echo "${RESP}" | jq 'length')"
echo "==> server returned ${COUNT} component(s) for this user"

# List the owners the user can see. With the policy enforcing, EVERY owner here must be a
# group the user belongs to (or the user themselves). If the user is on one team, every
# component owner should be that one team — NOT every team's components.
echo "==> distinct spec.owner values visible to this user:"
echo "${RESP}" | jq -r '[.[].spec.owner] | unique | .[]'

if [[ -n "${EXPECT_TEAM}" ]]; then
  STRAY="$(echo "${RESP}" | jq -r --arg t "group:default/${EXPECT_TEAM}" \
    '[.[] | select(.spec.owner != $t)] | length')"
  if [[ "${STRAY}" -ne 0 ]]; then
    echo "FAIL: ${STRAY} component(s) owned by a team other than '${EXPECT_TEAM}' are"
    echo "      visible — the server-side ownership filter is NOT enforcing (silent"
    echo "      ALLOW-all? check permission.enabled + the registered policy)."
    exit 1
  fi
  echo "PASS: every visible component is owned by 'group:default/${EXPECT_TEAM}' —"
  echo "      the backend boundary is enforced server-side."
fi
