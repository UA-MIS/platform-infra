# Fix — Crossplane `provider-harbor` cannot mint tenant RobotAccounts (403 `effect` scope)

**Audience:** platform operator (keyboard/cluster access). Agents cannot mint/PUT Harbor
robots or apply cluster changes — those are behind the classifier gate.

**What this unblocks:** ALL new-tenant CI image push. The Track-5 / ADR-031 `CapstoneTenant`
XR → Composition fans out per-team Harbor `RobotAccount` managed resources (push + pull). Every
one is stuck `Ready=False (Creating)`, no robots exist in Harbor, and the
`<team>-harbor-push` / `<team>-harbor-pull` connection secrets have an **empty password** — so
tenant builds fail with `UNAUTHORIZED: ... action: push`.

---

## Root cause (confirmed live, not the async race we first suspected)

The RobotAccount MRs report `Synced=True` but `Ready=False (Creating)`, and the provider's
Harbor create fails with:

```
403 DENIED  "permission scope is invalid. It must be equal to or more restrictive
             than the creator robot's permissions: robot$provisioner"
```

This is **not** a missing permission and **not** the `the object has been modified`
optimistic-concurrency race (that was a *secondary symptom* — the async external-create
callback churning status writes while the create kept failing). Serializing reconciles
(`--max-reconcile-rate=1`) would NOT fix it; the 403 would persist.

The real cause is an **`effect`-field key mismatch** in Harbor's robot-creates-robot subset check:

- Harbor v2.15.1 `isValidPermissionScope` (`src/server/v2.0/handler/robot.go`) keys each access
  policy by **`Resource:Action:Effect`**.
- `globallogicuki/provider-harbor` wraps `goharbor/terraform-provider-harbor`, whose robot
  `access.effect` field **defaults to `"allow"`**. So every child-robot access entry the provider
  sends is keyed `repository:pull:allow`, `repository:push:allow`, …
- But `robot$provisioner` (the provider's own credential, Harbor robot id=29) was minted with
  **no effect**, so its 140 stored access entries are keyed `repository:pull:` (empty effect).
- The keys never match → the child's permissions look like they are *not* a subset of the
  creator's → **403 DENIED**, even though `robot$provisioner` genuinely holds a superset.

### Proof (run live as `robot$provisioner`)

| Request (as `robot$provisioner`, project `swami`) | Result |
| --- | --- |
| `repository:pull` **with** `effect:"allow"` (the provider's actual shape) | **403 DENIED** |
| `repository:push`+`repository:pull` **with** `effect:"allow"` | **403 DENIED** |
| `repository:pull` **without** `effect` | **201 Created** |

Harbor **persists** `effect:"allow"` when supplied (a GET round-trips
`{"action":"pull","effect":"allow","resource":"repository"}`), so aligning the creator's stored
effect to `"allow"` is a valid, durable fix.

Upstream references:
- goharbor/harbor #21251 — robot-creates-robot subset check rejects valid children.
- goharbor/harbor PR #21310 — fixed the `namespace:"*"` wildcard half (already in v2.15.1); the
  remaining `effect` mismatch is what bites here.
- goharbor/terraform-provider-harbor — `harbor_robot_account` `access.effect` defaults to `"allow"`.

---

## The fix — align `robot$provisioner`'s stored effect to `"allow"`

**Recommended: in-place PUT (token-preserving, no reseal).** Updating a robot's permissions via
`PUT /api/v2.0/robots/{id}` changes permissions ONLY — it does **not** regenerate the robot
secret. So the existing `harbor-provider-creds` `SealedSecret` stays valid, the provider keeps
authenticating, and there is no token rotation and no reseal.

A script does it idempotently (GET → add `effect:"allow"` to every access entry → PUT):

```bash
export KUBECONFIG=clusters/real-talos/talos-kubeconfig   # your live-cluster kubeconfig
cd platform-services/crossplane/scripts

DRY_RUN=1 ./fix-harbor-provisioner-effect.sh   # preview: how many entries would change
./fix-harbor-provisioner-effect.sh             # apply the in-place PUT
```

Expected tail:

```
access entries: 140 total, 140 needed effect:allow
PUT ok (HTTP 200).
VERIFIED: all access entries now carry effect:allow.
```

Re-running is a no-op (`OK: every access entry already has effect:allow`).

### Nudge the stuck MRs (they retry on their own, but this is faster)

```bash
# option A — force an immediate reconcile of the composed RobotAccounts:
kubectl annotate robotaccount.robotaccount.harbor.crossplane.io \
  swami-swamiapp-156e6f921712 swami-swamiapp-5270ddeecf34 \
  fix.capstone/kick="$(date +%s)" --overwrite

# option B — if they were left in a stale async-create state, delete them and let the
# CapstoneTenant XR recompose fresh MRs:
kubectl delete robotaccount.robotaccount.harbor.crossplane.io \
  swami-swamiapp-156e6f921712 swami-swamiapp-5270ddeecf34
```

---

## Verify success

```bash
# 1) the RobotAccount MRs flip Ready=True:
kubectl get robotaccount.robotaccount.harbor.crossplane.io -A
#   NAME                          READY   SYNCED
#   swami-swamiapp-156e6f921712   True    True
#   swami-swamiapp-5270ddeecf34   True    True

# 2) the two swami robots now exist in Harbor with the right project scope:
HP=$(kubectl -n harbor get secret harbor-admin -o jsonpath='{.data.HARBOR_ADMIN_PASSWORD}' | base64 -d)
POD=$(kubectl -n harbor get pod -l component=core -o jsonpath='{.items[0].metadata.name}')
kubectl -n harbor exec "$POD" -- curl -sS -u "admin:${HP}" \
  'http://harbor-core.harbor.svc:80/api/v2.0/robots?page_size=100' \
  | python3 -c 'import json,sys; [print(r["name"], r["level"]) for r in json.load(sys.stdin) if "swami" in r["name"]]'
#   robot$swami+swami-push  project
#   robot$swami+swami-pull  project

# 3) the connection secrets now carry a NON-empty password (attribute.secret):
for s in swami-harbor-push swami-harbor-pull; do
  echo -n "$s: "; kubectl -n crossplane-system get secret "$s" \
    -o jsonpath='{.data.attribute\.secret}' | wc -c   # -> > 0
done

# 4) the ESO PushSecrets bridge into Vault, then arc-runners gets harbor-push-<team>:
kubectl -n crossplane-system get pushsecret
kubectl -n arc-runners get externalsecret,secret | grep swami
```

Once the connection secrets are populated, the `PushSecret`s write the token to Vault
(`tenants/swami/ci/harbor-push`, `tenants/swami/<env>/harbor-pull`), ESO materializes
`harbor-push-swami` in `arc-runners`, and the tenant's next CI build pushes successfully.

---

## Fallback — re-mint (only if the token must be rotated anyway)

If you would rather re-mint (e.g. rotating the provisioner token): delete robot id=29, POST a new
`robot$provisioner` with the **same permission set but `effect:"allow"` on every access entry**,
capture the one-time secret, and reseal it into
`platform-services/crossplane/creds/harbor-provisioner-creds-sealed.yaml`
(`harbor-provider-creds`, per `creds/README.md`). This changes the token, so the SealedSecret
MUST be resealed and re-synced before the provider can authenticate again. Prefer the in-place PUT
above unless rotation is a goal.

---

## Prevent regression

Any future re-mint of `robot$provisioner` MUST include `"effect": "allow"` on every access entry,
or this 403 returns. The requirement is now documented in `creds/README.md` and the header of
`config/providerconfig-harbor.yaml`. (The Backstage `robot$backstage-provisioner` in
`vm-path-harbor-provisioner.md` is unaffected — it only creates projects/members, never robots, so
the robot-creates-robot subset check never runs for it.)
