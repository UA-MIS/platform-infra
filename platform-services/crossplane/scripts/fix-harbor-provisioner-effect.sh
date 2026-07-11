#!/usr/bin/env bash
#
# fix-harbor-provisioner-effect.sh
# =================================
# ROOT-CAUSE FIX for: Crossplane provider-harbor cannot mint per-tenant Harbor
# RobotAccounts — every RobotAccount MR sits `Ready=False (Creating)` forever and
# Harbor returns:
#
#   403 DENIED "permission scope is invalid. It must be equal to or more
#   restrictive than the creator robot's permissions: robot$provisioner"
#
# WHY (confirmed live against Harbor v2.15.1):
#   Harbor's robot-creates-robot subset check (`isValidPermissionScope`,
#   src/server/v2.0/handler/robot.go) keys each access policy by
#   `Resource:Action:Effect`. The `globallogicuki/provider-harbor` provider wraps
#   `goharbor/terraform-provider-harbor`, whose robot `access.effect` field DEFAULTS
#   TO "allow" — so every child-robot access entry the provider sends is keyed
#   `repository:pull:allow`. But `robot$provisioner` was minted with NO effect, so its
#   own stored access is keyed `repository:pull:` (empty effect). The keys never match,
#   the subset check fails, and Harbor denies the create — even though the provisioner
#   genuinely holds a SUPERSET of the requested permissions.
#     (Harbor issue #21251; the wildcard-namespace half was fixed in PR #21310, already
#      present in v2.15.1 — the remaining trigger here is purely the empty-vs-"allow"
#      effect mismatch, proven by: same request WITH effect=allow -> 403, WITHOUT
#      effect -> 201.)
#
# THE FIX (this script): make `robot$provisioner`'s STORED access carry
# `effect: "allow"` so its keys match what the provider sends. Done as an IN-PLACE
# PUT (GET the robot -> add effect:allow to every access entry -> PUT it back). PUT
# updates permissions ONLY; it does NOT regenerate the robot secret — so the existing
# `harbor-provider-creds` SealedSecret stays valid and NO reseal / token rotation is
# needed. Idempotent: re-running is a no-op once every entry already has effect:allow.
#
# AUTH: uses the Harbor `admin` password read straight from the `harbor-admin` secret
# in-cluster (admin is a local user, so the subset check does not apply to admin's own
# PUT). Nothing leaves the cluster; the secret is never echoed.
#
# PREREQS: kubectl context on the target cluster; a running harbor-core pod; jq NOT
# required (uses python3, already used elsewhere in this repo's runbooks).
#
# USAGE:
#   ./fix-harbor-provisioner-effect.sh            # apply the fix (in-place PUT)
#   DRY_RUN=1 ./fix-harbor-provisioner-effect.sh  # show what WOULD change, PUT nothing
#
set -euo pipefail

ROBOT_NAME="${ROBOT_NAME:-robot\$provisioner}"   # the Crossplane provider robot
HARBOR_NS="${HARBOR_NS:-harbor}"
HARBOR_API="${HARBOR_API:-http://harbor-core.harbor.svc:80/api/v2.0}"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '%s\n' "$*" >&2; }

# --- locate a harbor-core pod to run curl from (in-cluster HTTP, port 80) ----------
CORE_POD="$(kubectl -n "$HARBOR_NS" get pod -l component=core -o jsonpath='{.items[0].metadata.name}')"
[ -n "$CORE_POD" ] || { log "ERROR: no harbor-core pod found in ns/$HARBOR_NS"; exit 1; }
log "using harbor-core pod: $CORE_POD"

# --- admin credential (never printed) ----------------------------------------------
HP="$(kubectl -n "$HARBOR_NS" get secret harbor-admin -o jsonpath='{.data.HARBOR_ADMIN_PASSWORD}' | base64 -d)"
[ -n "$HP" ] || { log "ERROR: could not read harbor-admin password"; exit 1; }

hcurl() { kubectl -n "$HARBOR_NS" exec -i "$CORE_POD" -- curl -sS -u "admin:${HP}" "$@"; }

# --- find the provisioner robot id -------------------------------------------------
log "looking up ${ROBOT_NAME} ..."
ROBOT_ID="$(hcurl "${HARBOR_API}/robots?page_size=100" | python3 -c "
import json,sys
name=sys.argv[1]
robots=json.load(sys.stdin)
print(next((str(r['id']) for r in robots if r.get('name')==name), ''))
" "$ROBOT_NAME")"
[ -n "$ROBOT_ID" ] || { log "ERROR: robot ${ROBOT_NAME} not found in Harbor"; exit 1; }
log "found ${ROBOT_NAME} -> id=${ROBOT_ID}"

# --- GET current object, add effect:allow to every access entry --------------------
hcurl "${HARBOR_API}/robots/${ROBOT_ID}" > /tmp/harbor-provisioner.json
python3 - "$ROBOT_NAME" <<'PY'
import json,sys
d=json.load(open('/tmp/harbor-provisioner.json'))
total=changed=0
for p in d.get('permissions') or []:
    for a in p.get('access') or []:
        total+=1
        if a.get('effect')!='allow':
            a['effect']='allow'; changed+=1
# PUT body = the Robot object with the mutated permissions.
body={k:d[k] for k in ('id','name','description','duration','level','disable','permissions') if k in d}
json.dump(body, open('/tmp/harbor-provisioner-put.json','w'))
sys.stderr.write(f"access entries: {total} total, {changed} needed effect:allow\n")
open('/tmp/harbor-provisioner-changed','w').write(str(changed))
PY
CHANGED="$(cat /tmp/harbor-provisioner-changed)"

if [ "$CHANGED" = "0" ]; then
  log "OK: every access entry already has effect:allow — nothing to do (idempotent)."
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN=1 — would PUT ${ROBOT_NAME} (id=${ROBOT_ID}) with ${CHANGED} entries set to effect:allow. No change made."
  exit 0
fi

# --- PUT the updated permissions (secret is NOT regenerated by PUT) -----------------
kubectl -n "$HARBOR_NS" cp /tmp/harbor-provisioner-put.json "${HARBOR_NS}/${CORE_POD}:/tmp/harbor-provisioner-put.json"
CODE="$(kubectl -n "$HARBOR_NS" exec -i "$CORE_POD" -- \
  curl -sS -o /dev/null -w '%{http_code}' -u "admin:${HP}" \
  -H 'Content-Type: application/json' -X PUT "${HARBOR_API}/robots/${ROBOT_ID}" \
  --data @/tmp/harbor-provisioner-put.json)"
if [ "$CODE" != "200" ]; then
  log "ERROR: PUT ${HARBOR_API}/robots/${ROBOT_ID} returned HTTP ${CODE} (expected 200)"; exit 1
fi
log "PUT ok (HTTP 200)."

# --- verify: re-read and assert every entry now has effect:allow -------------------
hcurl "${HARBOR_API}/robots/${ROBOT_ID}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
bad=[a for p in d.get('permissions',[]) for a in p.get('access',[]) if a.get('effect')!='allow']
if bad:
    sys.stderr.write(f'ERROR: {len(bad)} access entries still lack effect:allow\n'); sys.exit(1)
sys.stderr.write('VERIFIED: all access entries now carry effect:allow.\n')
"

log ""
log "DONE. robot\$provisioner permissions now match what provider-harbor sends."
log "Next: the stuck RobotAccount MRs will retry on their next reconcile. To nudge them"
log "immediately (or if they were left in a stale async-create state), run e.g.:"
log "  kubectl annotate robotaccount.robotaccount.harbor.crossplane.io -l crossplane.io/claim-name=swami-swamiapp \\"
log "    fix.capstone/kick=\"\$(date +%s)\" --overwrite"
log "or delete the two RobotAccount MRs and let the CapstoneTenant XR recompose them."
