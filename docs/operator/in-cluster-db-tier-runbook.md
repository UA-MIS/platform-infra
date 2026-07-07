# In-cluster DB tier (CNPG + MariaDB) — setup, Vault wiring, cutover runbook

**Status: SETUP ONLY.** This PR stands up the in-cluster database tier (operators +
clusters + backups + prepared ESO/Vault wiring). It does **not** cut any live
workload over, and it does **not** touch `ua-mis-db-1`'s live data
(docs/db-tier-runbook.md — the off-cluster box stays the system of record for
every tenant database until a deliberate, separately-approved cutover).

**Audience:** operator, at a keyboard with `kubectl`/`vault` against the `capstone`
cluster (`KUBE_CONTEXT=admin@capstone`) and `vault exec` access to `vault-0`.

---

## 0. What this PR deployed

| Piece | Where | What |
|---|---|---|
| CloudNativePG operator | `applicationsets/cnpg-operator-app.yaml` (ns `cnpg-system`) | Postgres 17 operator — `Cluster`/`Database`/`DatabaseRole`/`Backup`/`ScheduledBackup` CRDs |
| Barman Cloud plugin | `applicationsets/cnpg-barman-plugin-app.yaml` (ns `cnpg-system`) | The current (non-deprecated) backup/WAL-archive sidecar for CNPG; `ObjectStore` CRD |
| CNPG Cluster | `applicationsets/cnpg-cluster-app.yaml` → `platform-services/cnpg/cluster/` (ns `db-tier`) | `capstone-pg`: 3-instance HA Postgres 17, `ceph-block` storage, nightly + continuous-WAL backups to MinIO |
| mariadb-operator (+ CRDs) | `applicationsets/mariadb-operator-{crds,}-app.yaml` (ns `mariadb-system`) | MariaDB CRD controller |
| MariaDB cluster | `applicationsets/mariadb-cluster-app.yaml` (ns `db-tier`) | `capstone-mariadb`: 11.8, Galera 3-node multi-master HA, `ceph-block` storage, nightly `PhysicalBackup` to MinIO |
| MinIO | `applicationsets/minio-backups-app.yaml` (ns `db-tier`) | Single-node, Ceph-RBD-backed S3-compatible backup target — buckets `postgres-backups` / `mariadb-backups` |
| ExternalSecrets | `platform-services/db-tier/externalsecrets.yaml` | ESO/Vault wiring for every credential the tier consumes (§2) — **inert until §2 is run** |

All of it is **GitOps** (ArgoCD `platform` project) — nothing here was `kubectl
apply`'d directly.

**New AppProject sourceRepos** (`bootstrap/platform-appproject.yaml`):
`https://cloudnative-pg.github.io/charts`, `https://mariadb-operator.github.io/mariadb-operator`,
`https://charts.min.io`. **Run `make bootstrap-reapply KUBE_CONTEXT=admin@capstone`
after merge** (same as every other Helm-source add — the AppProject is
bootstrap-owned, not GitOps-reconciled) or every `platform-cnpg-*` /
`platform-mariadb-*` / `platform-minio-backups` Application InvalidSpecErrors
"repo not permitted".

Until §2 below is run, `platform-svc-db-tier`'s ExternalSecrets sit
`SecretSyncError` and the CNPG/MariaDB/MinIO Applications sit degraded waiting on
their Secrets — this is the same safe failure mode every other ESO consumer in
this fleet has pre-Vault-write (e.g. `db-tier-mysql-admin`,
docs/operator/db-tier-provisioner-setup.md).

---

## 1. Why CloudNativePG + mariadb-operator (not something else)

- **CloudNativePG**: the CNCF-sandbox, most actively maintained Postgres operator;
  declarative `Cluster`/`Database`/`DatabaseRole` CRDs give per-app databases and
  least-privilege roles on ONE shared cluster without touching the Cluster object
  per app. Backups go through the **Barman Cloud plugin**
  (`platform-services/cnpg/barman-plugin/`), not the in-tree
  `Cluster.spec.backup.barmanObjectStore` path — that path has been **deprecated
  since CNPG v1.26** in favor of the plugin, and since this is a greenfield
  install there's no reason to start deprecated.
- **mariadb-operator**: the most actively maintained MariaDB/MySQL operator with a
  first-class Galera (multi-master synchronous) HA mode and a `mariadb-cluster`
  wrapper chart that mirrors the CNPG `Database`/role split (`Database`/`User`/
  `Grant`/`PhysicalBackup` CRDs).
- **MinIO** (not Ceph RGW/CephObjectStore): the task asked for backups "to MinIO"
  specifically; Rook already ships a CephObjectStore option
  (`rook-ceph-cluster-app.yaml`'s `cephObjectStores: []`) if a future review
  prefers consolidating onto Ceph RGW instead of a dedicated MinIO pod — that's a
  reasonable follow-up, not done here to keep this PR's scope to what was asked.

---

## 2. Vault path contract — **the orchestrator runs this section**

Agents are classifier-gated from writing production secret values (same rule as
every other credential mint in this fleet — see
docs/operator/db-tier-provisioner-setup.md). All of the following are **KV v2**
under `secret/data/platform/...`; the ESO controller's `external-secrets-ro` Vault
policy already grants read on `secret/data/platform/*`
(`platform-services/external-secrets/vault-policies/eso-role.sh`) — **no Vault
policy change is needed**, only the values below.

Generate a strong token per line (32+ random bytes, e.g. `openssl rand -base64
32`), then, from a shell with `vault exec` access to `vault-0`:

```bash
kubectl --context admin@capstone -n vault exec -it vault-0 -- vault kv put secret/platform/db/cnpg/backstage \
  username=backstage password='<STRONG_TOKEN_1>'

kubectl --context admin@capstone -n vault exec -it vault-0 -- vault kv put secret/platform/db/cnpg/harbor \
  username=harbor password='<STRONG_TOKEN_2>'

kubectl --context admin@capstone -n vault exec -it vault-0 -- vault kv put secret/platform/db/cnpg/crossplane-provisioner \
  username=crossplane_provisioner password='<STRONG_TOKEN_3>'

kubectl --context admin@capstone -n vault exec -it vault-0 -- vault kv put secret/platform/db/mariadb/root \
  password='<STRONG_TOKEN_4>'

kubectl --context admin@capstone -n vault exec -it vault-0 -- vault kv put secret/platform/db/mariadb/crossplane-provisioner \
  password='<STRONG_TOKEN_5>'

kubectl --context admin@capstone -n vault exec -it vault-0 -- vault kv put secret/platform/db/minio \
  root-user=capstone-db-backups-admin root-password='<STRONG_TOKEN_6>' \
  cnpg-access-key='<STRONG_TOKEN_7>' cnpg-secret-key='<STRONG_TOKEN_8>' \
  mariadb-access-key='<STRONG_TOKEN_9>' mariadb-secret-key='<STRONG_TOKEN_10>'
```

> `cnpg-access-key` / `mariadb-access-key` don't need to be secret-strength (they're
> the MinIO **usernames**, not passwords — `cnpg-backup` / `mariadb-backup` are
> already fixed as literals in `applicationsets/minio-backups-app.yaml`'s `users:`
> list `accessKey` fields). Simplest to just reuse those same literal strings for
> `cnpg-access-key`/`mariadb-access-key` here rather than mint separate random
> tokens — keep `*-secret-key` random.

### 2a. Verify (after ArgoCD syncs)

```bash
kubectl --context admin@capstone -n db-tier get externalsecret
#   All 8 should show STATUS SecretSynced (not SecretSyncError).
kubectl --context admin@capstone -n db-tier get cluster.postgresql.cnpg.io capstone-pg
#   PHASE should progress to "Cluster in healthy state" (a few minutes after the
#   secrets land — 3 instances need to initialize + stream).
kubectl --context admin@capstone -n db-tier get mariadb capstone-mariadb-mariadb-cluster
#   STATUS Ready, 3/3 replicas.
kubectl --context admin@capstone -n db-tier get pods -l app=minio,release=minio-backups
kubectl --context admin@capstone -n db-tier get objectstore.barmancloud.cnpg.io capstone-pg-backup-store
kubectl --context admin@capstone -n db-tier get scheduledbackup.postgresql.cnpg.io capstone-pg-nightly
kubectl --context admin@capstone -n db-tier get physicalbackup   # from the mariadb-cluster chart
```

A good end-to-end proof: force one backup of each engine on demand and confirm an
object lands in MinIO —

```bash
kubectl --context admin@capstone -n db-tier cnpg backup capstone-pg --method=plugin --plugin-name=barman-cloud.cloudnative-pg.io
kubectl --context admin@capstone -n db-tier exec -it deploy/minio-backups -- mc ls local/postgres-backups --recursive 2>/dev/null || \
  kubectl --context admin@capstone -n db-tier run mc-check --rm -it --restart=Never --image=minio/mc -- \
    sh -c 'mc alias set local http://minio-backups.db-tier.svc.cluster.local:9000 <accesskey> <secretkey> && mc ls --recursive local/postgres-backups'
```

---

## 3. What this tier does NOT do yet (by design)

- **Backstage / Harbor are still on their bundled per-app Postgres subcharts**
  (`applicationsets/backstage-process-app.yaml`'s `postgresql:` block,
  `applicationsets/harbor-app.yaml`'s bundled database). The `backstage`/`harbor`
  `Database`/`DatabaseRole` CRs on `capstone-pg` (`platform-services/cnpg/cluster/
  {databases,roles}.yaml`) exist **ahead of** that cutover so the tier is ready —
  see §4.
- **Crossplane's `provider-sql` still points at `ua-mis-db-1`**
  (`platform-services/crossplane/config/providerconfig-{postgres,sql}.yaml`,
  secrets `db-tier-postgres-admin` / `db-tier-mysql-admin`). The
  `crossplane_provisioner` role/user on `capstone-pg`/`capstone-mariadb` mirror the
  off-box provisioner's exact privilege shape (LOGIN CREATEDB CREATEROLE for
  Postgres; the same least-privilege grant list, minus SUPER/FILE/PROCESS/
  RELOAD/SHUTDOWN, for MariaDB) so the ProviderConfig secrets **can** be repointed
  here later without a privilege-model change — see §4.
- **`db-tier` has default-deny + scoped-allow NetworkPolicy**
  (`platform-services/db-tier/netpol.yaml`, auto-synced with the rest of this flat
  dir — safe on day one since the namespace has no prior live traffic to sever):
  ingress is scoped to the `cnpg-system`/`mariadb-system` operator namespaces on
  their exact reconcile ports, intra-namespace (replication/SST/backup-to-MinIO),
  and kubelet probes; egress is DNS + intra-cluster + apiserver only. `cnpg-system`
  and `mariadb-system` themselves (the operator/controller pods) have **no**
  NetworkPolicy yet — only their egress-side interaction with `db-tier` is fenced
  from that side. Revisit before the Crossplane repoint in §4: the
  `crossplane_provisioner` accounts are host-scoped `%`/any-source in-cluster (see
  the comments in `applicationsets/mariadb-cluster-app.yaml` and
  `platform-services/cnpg/cluster/roles.yaml`), so `db-tier`'s ingress allow-list
  needs a companion edit (mirroring
  `hardening/netpol-controlplane/crossplane-db-cnp.yaml`'s pattern) to admit
  Backstage/Harbor/`crossplane-system` by namespace at that point — it is
  deliberately NOT pre-opened here since none of those are live DB clients yet.
- **MinIO has no TLS.** ClusterIP-only, never Ingress-exposed. Fine for a
  same-cluster-trust backup path; revisit if a review wants in-cluster mTLS
  everywhere (cert-manager is already available — same self-signed-issuer pattern
  the Barman Cloud plugin itself uses would apply cleanly).

---

## 4. Cutover procedure (NOT executed by this PR — run when the operator decides to proceed)

Each of the three cutovers below is **independent** — do them one at a time, verify,
then move to the next. All follow the same shape: dump from the current source,
restore into the new in-cluster role/database that's already provisioned (§0),
flip the consuming app's connection config, verify, then decommission the old path.

### 4a. Backstage → `capstone-pg` / role `backstage` / db `backstage`

```bash
# 1. Dump from the CURRENT bundled Backstage postgres pod:
kubectl --context admin@capstone -n backstage exec -it backstage-postgresql-0 -- \
  pg_dump -U bn_backstage -d backstage -Fc -f /tmp/backstage.dump
kubectl --context admin@capstone -n backstage cp backstage-postgresql-0:/tmp/backstage.dump ./backstage.dump

# 2. Restore into capstone-pg's `backstage` database (owner role already exists —
#    platform-services/cnpg/cluster/{databases,roles}.yaml):
kubectl --context admin@capstone -n db-tier cp ./backstage.dump capstone-pg-1:/tmp/backstage.dump
kubectl --context admin@capstone -n db-tier exec -it capstone-pg-1 -- \
  pg_restore -U backstage -d backstage --no-owner --role=backstage -Fc /tmp/backstage.dump

# 3. Point Backstage at the new cluster — edit
#    applicationsets/backstage-process-app.yaml's `postgresql:` block:
#      postgresql.enabled: false
#      (add, in the Backstage app-config / Helm values) an external DB block:
#        host: capstone-pg-rw.db-tier.svc.cluster.local
#        port: 5432
#        user: backstage
#        database: backstage
#        password from an ExternalSecret reading platform/db/cnpg/backstage
#          (materialize it INTO the `backstage` namespace this time, e.g.
#          `backstage-cnpg-db-credentials` — a NEW ExternalSecret in
#          platform-services/backstage/, same Vault path as
#          platform-services/db-tier/externalsecrets.yaml's
#          cnpg-backstage-app-credentials, just a second consumer of the same
#          Vault value)
#    (`capstone-pg-rw` is the CNPG-generated read/write Service — verify the exact
#    name with `kubectl -n db-tier get svc -l cnpg.io/cluster=capstone-pg`.)
# 4. PR the Helm-values change, merge, ArgoCD syncs, verify Backstage logs in +
#    the catalog is intact, THEN scale down/remove the old bundled postgresql
#    subchart release (drop `postgresql.enabled` entirely) in a follow-up PR once
#    confident — don't delete the old data in the same change as the cutover.
```

### 4b. Harbor → `capstone-pg` / role `harbor` / db `harbor`

Same shape as 4a: `pg_dump` from Harbor's bundled `harbor-database-0` pod, restore
into `capstone-pg`'s `harbor` database (role already exists), then edit
`applicationsets/harbor-app.yaml` to disable the bundled `database:` block and
point Harbor's `externalDatabase` config at `capstone-pg-rw.db-tier.svc.cluster.local`
with credentials from an ExternalSecret reading `platform/db/cnpg/harbor` (same
pattern as 4a step 3). Harbor's own docs call this config block `database.external`
in the `harbor` chart values — verify against the pinned chart version in
`applicationsets/harbor-app.yaml` before writing it (chart config surface changes
between majors).

### 4c. Crossplane tenant provisioning → repoint at the in-cluster tier

**This is the one that touches `ua-mis-db-1`'s role as system-of-record — treat it
as the highest-risk step and get an explicit go-ahead before starting.** It does
NOT require migrating existing tenant data immediately (existing tenant DBs can
keep living on `ua-mis-db-1` while NEW tenant DBs provision in-cluster — provider-
sql's ProviderConfig only affects where FUTURE `Database`/`User`/`Role` MRs land),
but plan the full data migration alongside it so you don't end up permanently
split-brained across two DB hosts.

1. **Repoint the ProviderConfigs** (no data movement yet — new tenants only):
   - `platform-services/crossplane/config/providerconfig-postgres.yaml`: change
     the connection secret ref from `db-tier-postgres-admin` to a NEW secret (e.g.
     `db-tier-postgres-admin-incluster`) sourced via ExternalSecret from
     `platform/db/cnpg/crossplane-provisioner` (endpoint
     `capstone-pg-rw.db-tier.svc.cluster.local`, port `5432`).
   - `platform-services/crossplane/config/providerconfig-sql.yaml`: same, pointing
     at `platform/db/mariadb/crossplane-provisioner`
     (`capstone-mariadb-mariadb-cluster.db-tier.svc.cluster.local`, port `3306`).
   - Verify with a throwaway tenant claim (`database: postgres` and
     `database: mysql`) that new `Database`/`Role`/`User`/`Grant` MRs reconcile
     Ready against the in-cluster tier before touching anything live.
2. **Migrate existing tenant data**, per team, on a schedule that doesn't disrupt
   them:
   - Postgres: `pg_dump -h ua-mis-db-1 -U crossplane_provisioner -d <team>_<env>
     -Fc | pg_restore -h capstone-pg-rw.db-tier.svc.cluster.local -U <team>_<env>_role
     -d <team>_<env>` (same `pg_dump`/`pg_restore` shape as 4a, per tenant db).
   - MySQL/MariaDB: `mysqldump -h ua-mis-db-1 -u crossplane_provisioner -p
     <team>_<env> | mysql -h capstone-mariadb-mariadb-cluster.db-tier.svc.cluster.local
     -u <team>_<env>_user -p <team>_<env>` (same shape as 4a).
   - Re-point each tenant's `DATABASE_URL`/connection secret in Vault
     (`tenants/<team>/<env>/database`) to the new host — ESO re-syncs it into the
     tenant's k8s Secret automatically, no code change on the tenant's side.
3. **Decommission `ua-mis-db-1`'s DB role** only after every tenant is confirmed
   migrated and stable for a full billing/semester cycle — keep it warm as a
   fallback until then. The box itself may still be useful for other purposes
   (see docs/db-tier-runbook.md); this only retires its *database* role.

### 4d. Rollback (any of 4a/4b/4c)

Every step above is additive until the "point X at Y" Helm-values/ProviderConfig
edit — revert that one PR (`git revert`) to fall back to the previous source
instantly; the old data/pod hasn't been touched. Only delete the old
subchart/box-side data after the new path has run clean for a real production
window (a week+ recommended for 4a/4b; a full semester for 4c per the note above).

---

## 5. Runbook index cross-ref

Add to `docs/operator/README.md` §6 runbook index:
`[in-cluster-db-tier-runbook.md](in-cluster-db-tier-runbook.md) | The in-cluster CNPG/MariaDB tier — Vault wiring + the pg_dump/mysqldump cutover from ua-mis-db-1 and the bundled per-app subcharts`
