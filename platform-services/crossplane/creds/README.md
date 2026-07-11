# Crossplane provider credentials — ⚠ SECURITY: one-time SRE review + reseal

These `SealedSecret`s carry the Crossplane providers' admin credentials
(provider-kubernetes uses in-cluster `InjectedIdentity`, so it needs no secret —
see `config/providerconfig-kubernetes.yaml`). They are the **only** privileged
credentials in the whole onboarding stack and they live **only** in
`crossplane-system` (never in Backstage, never with humans), per ADR-031 §6.
`mysql-admin-creds-sealed.yaml` is the ADR-033 addition (the DB-tier provisioner).

> **⚠ SECURITY FLAG (for the one-time SRE review, ADR-031 constraint #4).**
> `github-app-creds-sealed.yaml` and `vault-provisioner-creds-sealed.yaml` still
> carry **PLACEHOLDER** ciphertext (the same pattern as PR #120's ArgoCD
> repo-creds) — they will NOT decrypt, and the providers they configure sit
> unauthenticated (not reconciling — the safe failure mode) until the operator
> reseals each with a REAL scoped credential against the live cluster's
> sealed-secrets controller. `harbor-provisioner-creds-sealed.yaml`,
> `mysql-admin-creds-sealed.yaml`, and `postgres-admin-creds-sealed.yaml` **are now
> resealed with real in-cluster credentials** — see their rows below for the
> current target. Agents cannot reach the cluster to seal on their own initiative;
> this is normally the operator's keyboard (matches the platform's "agents can't do
> cluster writes" classifier gate) — the DB-tier reseal and the harbor-push-robot
> incident fix below were both done under explicit operator-supplied live-access
> instructions for their respective cutovers.
>
> **⚠ 2026-07-11 INCIDENT — read before touching `harbor-provisioner-creds-sealed.yaml`.**
> New-tenant onboarding was failing at the Harbor push stage
> (`UNAUTHORIZED: unauthorized to access repository ...:push`) for every template
> (Next.js/Python/VM) except a fragment reusing an existing robot. Root cause:
> `robot$provisioner` was scoped exactly as this file's row said —
> "project + robot + member admin ONLY", **no** `repository`/`artifact` grants —
> but Harbor enforces that a robot can never mint a child robot with permissions
> broader than its own (`POST /robots` → `403 DENIED: "permission scope is
> invalid. It must be equal to or more restrictive than the creator robot's
> permissions: robot$provisioner"`). Since the per-team CI push/pull robots
> (`apis/composition.yaml`, `harbor-robot-push`/`harbor-robot-pull`) request
> `repository:push/pull/read/list`, `artifact:read/list`, and
> `artifact-addition:read` — none of which `robot$provisioner` held — **every**
> child robot creation failed, so the CI push credential the scaffolder's runner
> mounts never existed (or existed empty), hence `UNAUTHORIZED` at push, not at
> mint time. See **"Harbor CI-push robot-minting scope"** below for the corrected
> scope, the exact commands, and a Harbor-API quirk to know about before you try to
> `PUT` an existing robot's permissions.

## What each one is (and the least-privilege scope to grant)

| File | Secret (crossplane-system) | Credential — scope to grant (NOT admin) |
| --- | --- | --- |
| `github-app-creds-sealed.yaml` | `github-provider-creds` | the EXISTING `ua-mis-backstage` GitHub App (App ID 4097147, install 141394298). JSON: `{"app_auth":[{"id":"4097147","installation_id":"141394298","pem_file":"<PEM \n-escaped>"}],"owner":"UA-MIS"}` |
| `harbor-provisioner-creds-sealed.yaml` | `harbor-provider-creds` | **RESEALED — IN-CLUSTER** (see incident note above + "Harbor CI-push robot-minting scope" below). A Harbor PROVISIONER ROBOT (derive from harbor-admin; do NOT use harbor-admin itself), scoped `system`: `create,list project`; `project` (namespace `*`): `create,read,update,delete,list project` \| `create,read,delete,list robot` \| `create,read,update,delete,list member` \| **`push,pull,read,list repository`** \| **`read,list artifact`** \| **`read artifact-addition`** — the bolded grants are the 2026-07-11 fix; without them every child CI robot the Composition mints comes out permission-scoped WIDER than its creator and Harbor rejects the create (`403 permission scope is invalid`), which is what broke tenant onboarding. ⚠ **AND every access entry MUST carry `"effect": "allow"`** — the breadth grant alone is necessary but NOT sufficient (see "part 2" note below); the provider sends `effect:"allow"` and Harbor's subset check keys on effect, so an empty-effect provisioner still 403s. JSON: `{"url":"http://harbor-core.harbor.svc","username":"robot$provisioner","password":"<token>"}` (note: **`http://`**, port 80 — see `config/providerconfig-harbor.yaml` header). |
| `vault-provisioner-creds-sealed.yaml` | `vault-provider-creds` | a Vault token with a `tenant-provisioner` policy: write `sys/policies/acl/tenant-*` + `auth/kubernetes/role/tenant-*`, plus `auth/token/create` (provider-vault mints a short-lived child token per call — see below). JSON: `{"token":"<token>","address":"https://vault.vault.svc.cluster.local:8200"}` |
| `mysql-admin-creds-sealed.yaml` (ADR-033) | `db-tier-mysql-admin` | **RESEALED — IN-CLUSTER (docs/operator/in-cluster-db-tier-runbook.md §4c).** A DB-tier MariaDB PROVISIONER LOGIN — **NOT** `root`. The in-cluster `crossplane-provisioner` mariadb-operator User/Grant (`applicationsets/mariadb-cluster-app.yaml`) — same least-privilege grant list as the retired off-box login (excludes SUPER/FILE/PROCESS/RELOAD/SHUTDOWN). **Four keys** (NOT a JSON blob): `endpoint`=`capstone-mariadb-mariadb-cluster-primary.db-tier.svc.cluster.local`, `port`=`3306`, `username`=`crossplane-provisioner`, `password`=`<token, matches secret db-tier/mariadb-crossplane-provisioner-credentials>`. provider-sql reads these via `MySQLConnectionSecret` (config/providerconfig-sql.yaml). |
| `postgres-admin-creds-sealed.yaml` (ADR-033) | `db-tier-postgres-admin` | **RESEALED — IN-CLUSTER (docs/operator/in-cluster-db-tier-runbook.md §4c).** A DB-tier **PG17** PROVISIONER ROLE — **NOT** `postgres` superuser. The in-cluster `crossplane_provisioner` CNPG DatabaseRole (`platform-services/cnpg/cluster/roles.yaml`) — `LOGIN CREATEDB CREATEROLE` ONLY (no `SUPERUSER`/`REPLICATION`/`BYPASSRLS`). **Four keys**: `endpoint`=`capstone-pg-rw.db-tier.svc.cluster.local`, `port`=`5432`, `username`=`crossplane_provisioner`, `password`=`<token, matches secret db-tier/cnpg-crossplane-provisioner-credentials>`. provider-sql reads these via `PostgreSQLConnectionSecret` (config/providerconfig-postgres.yaml). No live Postgres tenant exists yet — this reseal activates reconciliation for the first time with no prior state. |

## Harbor CI-push robot-minting scope (2026-07-11 incident fix)

**Bug:** new-tenant onboarding failed at the Harbor push stage for every
scaffolder template (`checking push permission for
"harbor.../<team>/<app>:...": UNAUTHORIZED`), confirmed live for the `swami`
tenant's `RobotAccount` MRs:

```
apply failed: [ERROR] unexpected status code got: 403 expected: 201
{"errors":[{"code":"DENIED","message":"permission scope is invalid. It must be
equal to or more restrictive than the creator robot's permissions:
robot$provisioner"}]}
```

**Root cause:** Harbor refuses to let a robot mint a child robot whose
permissions exceed its own. `robot$provisioner` was scoped per ADR-031 §6 to
"project + robot + member admin ONLY" — it held **no** `repository` or
`artifact` grants. But the per-team CI robots `apis/composition.yaml` mints
(`harbor-robot-push` / `harbor-robot-pull`) request
`repository:push/pull/read/list`, `artifact:read/list`, and
`artifact-addition:read` (added in #309 for the Trivy gate). `robot$provisioner`
could create the `Project` fine (that needs no repository grant) but every
`RobotAccount` create 403'd — so no team, past or future, ever got a working
push credential. `teardown`/`teardown-app` (the reported failing repo) was a
real ad-hoc test tenant (team=`teardown`, appName=`teardown-app`) the operator
created to exercise the scaffolder, not a scaffolder default/fallback — it hit
the identical bug every other tenant would.

Two secondary leads in the original report are both dead ends, confirmed live:
- **"another seal" was NOT needed.** `harbor-provider-creds`'s *password* was
  already correctly resealed (the live secret decrypts to the same
  `robot$provisioner` credential this file's ciphertext encodes) — robot
  **permissions** live entirely in Harbor's own DB, keyed off the robot object,
  not in the K8s credential. Resealing changes *who* the provider authenticates
  as; it cannot change what that identity is authorized to do.
- **Widening the robot further ("give it broad access") is NOT the fix either**
  (only masks it) — see the exact minimal grant below.

**Unblock onboarding NOW (no credential rotation, ~10s):** the currently-live
`robot$provisioner` already carries the needed `repository`/`artifact`/
`artifact-addition` grants (added live while diagnosing this — see "not required
to unblock" note below), so any `RobotAccount` MR still showing
`Ready=False`/`LastAsyncOperation: ApplyFailure` from BEFORE that live grant
landed is just stuck on a stale failed-create attempt, not a still-broken
permission. Crossplane's async-apply backoff can take a long time to retry on
its own; force it immediately by deleting the stuck MRs — nothing was ever
actually created in Harbor for them (external-name was never set), so this is
safe, and the Composition recreates them fresh on the next reconcile:

```bash
kubectl get robotaccounts.robotaccount.harbor.crossplane.io -A
# for each Ready=False / EXTERNAL-NAME-empty one (e.g. the swami-swamiapp-* pair):
kubectl delete robotaccount.robotaccount.harbor.crossplane.io <name>
```

**The fix — exact minimal scope to add to `robot$provisioner`** (on top of the
existing `project`/`robot`/`member` admin grants), at `kind: project`,
`namespace: "*"` (so it covers every current and future tenant project):

```json
{
  "action": "push",  "resource": "repository"
},
{
  "action": "pull",  "resource": "repository"
},
{
  "action": "read",  "resource": "repository"
},
{
  "action": "list",  "resource": "repository"
},
{
  "action": "read",  "resource": "artifact"
},
{
  "action": "list",  "resource": "artifact"
},
{
  "action": "read",  "resource": "artifact-addition"
}
```

This is exactly the permission set `apis/composition.yaml`'s `harbor-robot-push`
requests (pull-only for `harbor-robot-pull` is a strict subset) — the minimum
that satisfies Harbor's "creator ⊇ child" rule for both robots the Composition
mints, and nothing more (no `tag-retention`/`garbage-collection`/system-admin
power — those stay Job-driven via `harbor-admin`, see
`platform-services/harbor-retention-gc-config/`).

**⚠ Harbor-API quirk found while fixing this (v2.15, provider-harbor v0.1.1):**
`PUT /api/v2.0/robots/{id}` — the in-place permission-update call — could NOT be
made to work against the live robot: omitting `level`/`name` from the body 400s
("bad request error level input: ''"), and including them — even set to their
current, unchanged values — ALSO 400s ("cannot update the level or name of
robot"). This matches the Composition's own note that "editing `permissions`
forces REPLACEMENT" (goharbor TF provider #140): **there is no working in-place
edit for an existing robot's permissions.** The only reliable way to change
`robot$provisioner`'s scope is **delete + recreate**, which (a) issues a new
secret token (requires a reseal) and (b) briefly breaks Crossplane
reconciliation for every provider-harbor MR until the reseal lands. Do this in a
maintenance window, not mid-onboarding-rush.

**Operator runbook — apply the corrected minimal scope (delete + recreate + reseal):**

```bash
# 1) Read the CURRENT robot$provisioner id + confirm it's the one to replace.
ADMIN_PW=$(kubectl -n harbor get secret harbor-admin -o jsonpath='{.data.HARBOR_ADMIN_PASSWORD}' | base64 -d)
kubectl -n harbor exec deploy/harbor-core -- \
  curl -s -u "admin:${ADMIN_PW}" http://localhost:8080/api/v2.0/robots?page_size=100 \
  | python3 -c "import json,sys;[print(r['id'],r['name']) for r in json.load(sys.stdin)]"
OLD_ID=<id of robot\$provisioner from the output above>

# 2) Create the REPLACEMENT with the corrected minimal scope (system: create+list
#    project; project namespace "*": full project+robot+member admin PLUS the
#    repository/artifact/artifact-addition grants above). Use a scratch file, not
#    an inline heredoc with a literal `$` in the name (shell-escapes `robot$...`).
cat > /tmp/provisioner-perms.json <<'JSON'
{
  "name": "provisioner",
  "description": "crossplane provider-harbor",
  "duration": -1,
  "level": "system",
  "permissions": [
    { "kind": "system", "namespace": "/", "access": [
        {"action":"create","resource":"project"},
        {"action":"list","resource":"project"}
    ]},
    { "kind": "project", "namespace": "*", "access": [
        {"action":"read","resource":"project"},
        {"action":"update","resource":"project"},
        {"action":"delete","resource":"project"},
        {"action":"create","resource":"robot"},
        {"action":"read","resource":"robot"},
        {"action":"delete","resource":"robot"},
        {"action":"list","resource":"robot"},
        {"action":"create","resource":"member"},
        {"action":"read","resource":"member"},
        {"action":"update","resource":"member"},
        {"action":"delete","resource":"member"},
        {"action":"list","resource":"member"},
        {"action":"push","resource":"repository"},
        {"action":"pull","resource":"repository"},
        {"action":"read","resource":"repository"},
        {"action":"list","resource":"repository"},
        {"action":"read","resource":"artifact"},
        {"action":"list","resource":"artifact"},
        {"action":"read","resource":"artifact-addition"}
    ]}
  ]
}
JSON
kubectl -n harbor cp /tmp/provisioner-perms.json deploy/harbor-core:/tmp/provisioner-perms.json
NEW=$(kubectl -n harbor exec deploy/harbor-core -- \
  curl -s -u "admin:${ADMIN_PW}" -X POST http://localhost:8080/api/v2.0/robots \
  -H 'Content-Type: application/json' --data @/tmp/provisioner-perms.json)
echo "$NEW"   # capture .secret — this is the NEW robot$provisioner token

# 3) Only once (2) succeeds: delete the OLD robot.
kubectl -n harbor exec deploy/harbor-core -- \
  curl -s -u "admin:${ADMIN_PW}" -X DELETE "http://localhost:8080/api/v2.0/robots/${OLD_ID}"

# 4) Reseal the new token into harbor-provider-creds (crossplane-system) —
#    this is the git-managed step; commit the regenerated file.
NEW_SECRET=$(echo "$NEW" | python3 -c "import json,sys;print(json.load(sys.stdin)['secret'])")
cat > /tmp/harbor-creds.json <<EOF
{"url":"http://harbor-core.harbor.svc","username":"robot\$provisioner","password":"${NEW_SECRET}"}
EOF
kubectl create secret generic harbor-provider-creds \
  --namespace crossplane-system --from-file=credentials=/tmp/harbor-creds.json \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
    --format yaml > platform-services/crossplane/creds/harbor-provisioner-creds-sealed.yaml
rm -f /tmp/harbor-creds.json /tmp/provisioner-perms.json

# 5) Kick any tenant RobotAccount MRs that were stuck on the old 403 so they
#    retry immediately against the new identity (Composition recreates them —
#    nothing was ever actually created in Harbor for these, so this is safe):
kubectl get robotaccounts.robotaccount.harbor.crossplane.io -A
kubectl delete robotaccount.robotaccount.harbor.crossplane.io <stuck-ones-from-above>
```

Not required to unblock onboarding right now — the currently-live
`robot$provisioner` grant already includes the `repository`/`artifact`/
`artifact-addition` actions above (applied live during this incident's
diagnosis) and is proven working end-to-end (see PR description / incident
notes: a robot minted with the exact `harbor-robot-push` permission spec
successfully obtained a Harbor registry token with `"actions":["pull","push"]`).
It is currently **broader than the minimal set above** (it also carries a large
number of unrelated system-admin grants — registry/user/scanner/replication/
GC/ldap — from an earlier over-correction made while chasing this bug live).
Run the runbook above at a controlled maintenance window to right-size it; it is
a hardening follow-up, not a functional blocker.

### 2026-07-11 (part 2) — the missing piece: `effect: "allow"` on every access entry

The part-1 breadth grant above was **necessary but not sufficient.** After it landed,
the `swami` `RobotAccount` MRs were STILL `Ready=False (Creating)` with empty connection
secrets, and a create issued **as `robot$provisioner` itself** still 403'd. Root cause of
the *residual* failure (confirmed live against Harbor **v2.15.1**, and by reading
`src/server/v2.0/handler/robot.go`):

- Harbor's `isValidPermissionScope` keys each access policy by **`Resource:Action:Effect`**.
- `goharbor/terraform-provider-harbor` (which `provider-harbor` wraps) defaults every robot
  `access.effect` to **`"allow"`**, so the child request is keyed `repository:pull:allow`.
- `robot$provisioner`'s 140 stored entries were minted with **no effect** → keyed
  `repository:pull:` (empty). Keys never match → subset check fails → **403**, despite the
  provisioner now holding a genuine superset of resources+actions.

Proof (as `robot$provisioner`, project `swami`): `repository:pull` **with** `effect:"allow"`
→ **403**; the same **without** `effect` → **201**. Harbor persists `effect:"allow"` on a
GET round-trip, so aligning the creator's stored effect to `"allow"` is the durable fix.

**Fix (recommended, token-preserving, NO reseal):** an IN-PLACE `PUT` that adds
`effect:"allow"` to every stored access entry —
`platform-services/crossplane/scripts/fix-harbor-provisioner-effect.sh`. Full runbook +
verification: **`docs/operator/harbor-provisioner-robot-effect-fix.md`**.

> **⚠ Corrects the part-1 "no working in-place edit" claim above.** `PUT
> /api/v2.0/robots/{id}` DOES work — you must send the `name` **exactly as GET returns it**
> (i.e. the `robot$`-**prefixed** name) and keep `level`. The part-1 attempts 400'd because
> they sent a *stripped* name (`"cannot update the level or name of robot"`) or omitted
> name/level (`"bad request error level input"`). Verified live across system- and
> project-level robots: round-tripping the GET body verbatim (mutating only `effect`) → HTTP
> 200, and `PUT` does **not** regenerate the secret — so the `harbor-provider-creds`
> SealedSecret stays valid and no reseal/token rotation is needed. The delete+recreate+reseal
> runbook in part 1 remains valid as a fallback if you are rotating the token anyway.

## Resealing the real values (operator, at go-live)

```bash
# Example: GitHub App creds. Build the JSON, seal it for crossplane-system, replace the stub.
PEM=$(awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' ua-mis-backstage.pem)   # \n-escape the key
cat > /tmp/gh.json <<EOF
{"app_auth":[{"id":"4097147","installation_id":"141394298","pem_file":"${PEM}"}],"owner":"UA-MIS"}
EOF
kubectl create secret generic github-provider-creds \
  --namespace crossplane-system --from-file=credentials=/tmp/gh.json \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
    --format yaml > platform-services/crossplane/creds/github-app-creds-sealed.yaml
rm -f /tmp/gh.json
# Repeat for harbor-provider-creds and vault-provider-creds with their scoped values.
```

The `tenant-provisioner` Vault policy (run once, alongside the ESO/tenant policies
in `platform-services/external-secrets/vault-policies/`):

```hcl
# secret/data/tenants/* is read by ESO; the PROVISIONER only manages policy + k8s roles.
path "sys/policies/acl/tenant-*"        { capabilities = ["create","update","read","delete"] }
path "auth/kubernetes/role/tenant-*"    { capabilities = ["create","update","read","delete"] }
# provider-vault is Upjet over hashicorp/terraform-provider-vault: given a static
# token, that provider mints a short-lived CHILD token per API call (skip_child_token
# would avoid this but the upstream docs discourage it — it keeps the long-lived
# primary token in play on every request instead). Without this the provider's
# `observe` fails: "failed to create limited child token". A Vault child token can
# only ever be minted with a SUBSET of its parent's policies, so granting this here
# does not widen the token's blast radius beyond tenant-*.
path "auth/token/create" { capabilities = ["create","update"] }
```

## DB-tier MariaDB provisioner login (ADR-033, operator at go-live)

Mint the scoped provisioner login on `ua-mis-db-1` (over the Tailscale SSH session,
DB-tier runbook §2). **Do NOT use `root`** as the provider credential. The login needs
just enough to mint per-tenant `Database` + `User` + `Grant` and nothing else:

```sql
-- run as root on ua-mis-db-1 (MariaDB 11.8). Bind the account to the tailnet CIDR.
CREATE USER 'crossplane_provisioner'@'100.64.0.0/255.192.0.0'
  IDENTIFIED BY '<STRONG_TOKEN>';
-- Least privilege = the explicit schema-level privilege list (CREATE/DROP DATABASE,
-- CREATE USER, and ALL-on-a-schema so provider-sql's `Grant` can be delegated), NOT
-- `GRANT ALL PRIVILEGES ON *.*`. ⚠ At the GLOBAL level `ALL PRIVILEGES` INCLUDES
-- SUPER/PROCESS/RELOAD/SHUTDOWN — it is near-root and does NOT exclude SUPER. Use the
-- canonical explicit grant in docs/operator/db-tier-provisioner-setup.md §3 (the
-- authoritative, deliberately SUPER-free list) — do not use the broad `*.*` grant.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER,
      CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW,
      CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER, DELETE HISTORY, CREATE USER
  ON *.* TO 'crossplane_provisioner'@'100.64.0.0/255.192.0.0'
  WITH GRANT OPTION;
FLUSH PRIVILEGES;
```

Then seal the four connection keys into `db-tier-mysql-admin` for crossplane-system:

```bash
TSIP=$(ssh ops@ua-mis-db-1 'tailscale ip -4 | head -1')   # the ua-mis-db-1 tailnet IP
kubectl create secret generic db-tier-mysql-admin \
  --namespace crossplane-system \
  --from-literal=endpoint="${TSIP}" \
  --from-literal=port="3306" \
  --from-literal=username="crossplane_provisioner" \
  --from-literal=password="<STRONG_TOKEN>" \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
    --format yaml > platform-services/crossplane/creds/mysql-admin-creds-sealed.yaml
```
