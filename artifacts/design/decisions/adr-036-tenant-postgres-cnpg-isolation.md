# ADR-036 — Auto-provisioned tenant Postgres on a dedicated CNPG cluster

- **Status:** Proposed (extends ADR-033; HELD for a supervised DB-tier apply)
- **Date:** 2026-07-12
- **Repo:** platform-infra
- **Deciders:** human (Clayton) + SRE; drafted by developer
- **Extends:** ADR-033 (auto per-tenant database provisioning — the MySQL/provider-sql
  producer→Vault→ESO→`DATABASE_URL` contract), ADR-031 (Crossplane zero-touch onboarding —
  the `CapstoneTenant` XRD/Composition), ADR-030 (ESO + Vault secrets), ADR-035 (unified
  wizard). The in-cluster DB tier (`docs/operator/in-cluster-db-tier-runbook.md`) and the
  CNPG setup (`platform-services/cnpg/`).
- **Library verified (live repo, 2026-07-12):** CloudNativePG (`postgresql.cnpg.io/v1`
  `Cluster`/`Database`/`DatabaseRole`, `barmancloud.cnpg.io/v1` `ObjectStore`) — already
  running the `capstone-pg` cluster (PG17, 3-instance HA) on this fleet.
  `crossplane-contrib/provider-sql` v0.15.0 (`postgresql.sql.crossplane.io/v1alpha1`
  `Database`/`Role`/`Grant`) — already installed and wired.

---

## TL;DR (read first — the ground truth differs from the task framing)

Auto-provisioning of tenant Postgres for the wizard's `host-postgres` choice is **already
built and merged to `main`** end-to-end (PRs up to #192): the XRD enum
(`[none, mysql, postgres]`), the Composition's `postgresql.sql.crossplane.io`
`Role`/`Database`/`Grant` + PushSecret block, the engine-aware `DATABASE_URL` fragment
(`dbScheme=postgresql`), the compose engine mapping (`host-postgres → postgres`, #192),
and the CNPG engine itself (`capstone-pg` + a `crossplane_provisioner` role) are all
present. `host-postgres` does **not** provision "nothing" on `main` — the earlier
bring-your-own behavior is historical.

**What was actually missing / wrong** and what this ADR + PR change:

1. **Isolation gap (the substantive decision).** The merged path provisions tenant
   databases into **`capstone-pg` — the platform's own control-plane cluster** (Backstage
   catalog + Harbor metadata). Untrusted student databases sharing a Postgres cluster with
   the onboarding portal's own DB is a real blast-radius problem. **This ADR moves tenant
   Postgres onto a dedicated `capstone-tenant-pg` CNPG cluster.**
2. **A closed door.** `platform-services/db-tier/netpol.yaml` did not admit
   `crossplane-system → db-tier:5432`, so provider-sql's admin session would time out. This
   PR opens it (mirrors the existing `:3306` rule).
3. **A separate provisioner credential** for the tenant cluster (distinct Vault leaf), so a
   leaked tenant-cluster cred can't reach `capstone-pg`.

Everything else was already correct and is reused unchanged.

## Context

ADR-033 established the producer→consumer contract for auto-DB provisioning and chose
`provider-sql` against a DB tier as the engine-agnostic control plane. For **MySQL** the DB
tier is the in-cluster MariaDB (mariadb-operator) cluster in `db-tier`; provider-sql's
`db-tier-mariadb` ProviderConfig points at it. For **Postgres**, ADR-033 left a parity path
whose ProviderConfig (`db-tier-postgres`) was later pointed at the **in-cluster CNPG
cluster `capstone-pg`** — the same cluster that hosts Backstage's and Harbor's databases.

CNPG is the right *engine* choice: it already runs on this fleet, gives HA (streaming
replication + automatic failover), Ceph-RBD replica-3 storage, and Barman-Cloud backups
(nightly base + continuous WAL/PITR) to the in-cluster MinIO. The wrong part is the
**tenancy boundary**: a single cluster shared between the platform control plane and
untrusted, churny, auto-provisioned student databases.

## Decision

Provision auto-DB Postgres tenants on a **dedicated CNPG cluster `capstone-tenant-pg`** in
`db-tier`, separate from the control-plane `capstone-pg`, and repoint provider-sql's
`db-tier-postgres` ProviderConfig at it. **Keep the entire ADR-033 provisioning mechanism
unchanged** — CNPG is the engine; `provider-sql` remains the per-(team,env)
Role/Database/Grant control plane; the Vault path contract and the consumer `DATABASE_URL`
ExternalSecret are byte-for-byte the same. Only the *host* the credentials are minted
against moves to the isolated cluster, and that flows through automatically (see below).

### Cluster topology

| | `capstone-pg` (existing) | `capstone-tenant-pg` (this ADR) |
| --- | --- | --- |
| **Purpose** | Platform control-plane DBs: Backstage catalog, Harbor metadata | Auto-provisioned per-(team,env) **tenant** databases (`host-postgres`) |
| **Databases** | Fixed, declarative (`Database`/`DatabaseRole` CRs) | Dynamic — created by provider-sql per tenant; **no** declarative per-tenant CRs |
| **Instances** | 3 (HA) | 3 (HA; fleet-capacity knob — may drop to 1 for the demo) |
| **Storage** | `ceph-block` 10Gi | `ceph-block` 20Gi (many small tenant DBs) |
| **Backups** | Barman → MinIO `s3://postgres-backups/` (30d + WAL PITR) | Barman → MinIO `s3://postgres-backups/tenant/` (30d + WAL PITR) |
| **Provisioner role** | `crossplane_provisioner` (parity role, unused by tenants) | `crossplane_provisioner` — the live provider-sql admin identity |
| **Provisioner cred (Vault)** | `platform/db/cnpg/crossplane-provisioner` | `platform/db/cnpg-tenant/crossplane-provisioner` (distinct) |

### End-to-end flow (per team, per env — identical shape to MySQL/ADR-033)

1. **Wizard** → the student picks `host-postgres`; the compose engine
   (`composePlan.mjs`) resolves it to `spec.database: postgres` on the `CapstoneTenant` XR
   (only when a component actually reads `DATABASE_URL`; else `none`).
2. **Composition** (gated `{{- if eq $database "postgres" }}`), per env dev/staging/prod,
   renders on `postgresql.sql.crossplane.io/v1alpha1` against ProviderConfig
   `db-tier-postgres`:
   - `Role` `‹teamDb›_‹env›` — LOGIN, password **auto-generated** by provider-sql (never
     templated → reconcile-stable, same rationale as the Harbor-robot Variant-2 and the
     MySQL `User`), written with `username`/`endpoint`/`port` to a connection secret in
     `crossplane-system`.
   - `Database` `‹teamDb›_‹env›` — **owned by** that Role (PG-idiomatic; the team owns its
     own DB).
   - `Grant` CONNECT+CREATE+TEMPORARY (explicit DB-level ALL; mirrors MySQL's `GRANT ALL`).
   - `PushSecret` (via provider-kubernetes `Object`, in `crossplane-system`, using the
     platform `vault-push` writer SecretStore) → bridges `username`/`password`/
     `endpoint→host`/`port` into Vault at **`tenants/‹team›/‹env›/database`** — the SAME
     leaf + property names the MySQL block writes.
3. **ESO consumer** — the app overlay's platform-owned `database.externalsecret.yaml`
   (`values.database == 'postgres'` → `dbScheme='postgresql'`) reads those four parts via
   the per-tenant `vault-tenant` SecretStore and assembles
   `postgresql://‹user›:‹pass›@‹host›:‹port›/‹teamDb›_‹env›` into the `‹app›-db` Secret
   (key `DATABASE_URL`), which the base Deployment envs in.

Because the tenant's `host` is captured from provider-sql's admin `endpoint`, **repointing
the ProviderConfig at `capstone-tenant-pg-rw` makes every downstream consumer (the app
`DATABASE_URL` and the Adminer DB console) resolve to the isolated cluster with no consumer
edit.** The dbname is the fixed structural rule `‹teamDb›_‹env›` (pinned via
`crossplane.io/external-name`), not stored in Vault. `deletionPolicy: Delete` + the base's
`optional: true` keep a freshly-scaffolded app healthy before the DB lands (zero-config).

### Confirmed mirror of the MariaDB pattern

| Aspect | MySQL (ADR-033) | Postgres (this ADR) |
| --- | --- | --- |
| Engine | in-cluster MariaDB (mariadb-operator), `db-tier` | in-cluster CNPG `capstone-tenant-pg`, `db-tier` |
| Control plane | provider-sql `mysql.sql.crossplane.io` | provider-sql `postgresql.sql.crossplane.io` |
| Per-(team,env) objects | Database + User + Grant | Database + Role + Grant |
| Password | provider-sql auto-generated (no churn) | provider-sql auto-generated (no churn) |
| Producer→Vault | PushSecret → `tenants/‹team›/‹env›/database` | **same leaf, same 4 properties** |
| Consumer | `DATABASE_URL` ExternalSecret, `mysql://` | same ExternalSecret, `postgresql://` |
| Admin cred | scoped, `crossplane-system` only, SRE-reviewed | scoped (LOGIN CREATEDB CREATEROLE), `crossplane-system` only |
| De-provision | `git rm` the claim | `git rm` the claim |

The only intentional divergence from ADR-033's option-4 rejection ("no in-cluster
per-tenant DBs") is that Postgres uses an **in-cluster CNPG** engine rather than an
off-cluster box — but it is **one shared tenant cluster**, not a cluster per tenant, so the
"multiplies stateful surface" objection does not apply. CNPG already runs here, so this adds
no new operational technology, only a second Cluster CR.

## Options considered

1. **Dedicated `capstone-tenant-pg` CNPG cluster + reuse provider-sql (CHOSEN).** Full
   isolation of tenant data from the control plane; reuses the entire merged ADR-033
   mechanism; CNPG HA + Barman backups for free. Cost: a second 3-instance CNPG cluster on
   a small fleet.
2. **Keep provisioning into `capstone-pg` (the merged status quo).** Zero new cost, but
   untrusted tenant DBs share the cluster that runs Backstage/Harbor — a runaway tenant
   (connection storm, disk fill, a bad migration) can degrade the onboarding portal's own
   DB, and the CREATEDB/CREATEROLE provisioner operates on the control-plane cluster.
   Rejected as the durable target; it remains the safe **fallback** (skip the reseal + the
   new cluster, apply only the netpol rule).
3. **Pure-CNPG provisioning (CNPG `Database` CRD + `managed.roles`, drop provider-sql).**
   CNPG's `Database` CRD creates databases and `DatabaseRole` manages roles, but a role's
   password must be supplied via a Secret — there is no "generate-and-capture into a
   connection secret" like provider-sql. Reproducing that per-(team,env) would mean the
   Composition generating/sealing a password per role (render-time churn, the exact problem
   ADR-033's Variant-2 avoids) or a second control loop. It also diverges from the MySQL
   path (breaking the engine-agnostic symmetry). Rejected — more moving parts, worse
   reconcile-stability, no reuse.
4. **Per-tenant CNPG cluster.** Strongest isolation, but multiplies stateful surface N× on
   a 3-node fleet. Rejected (same reasoning ADR-033 used).

## Consequences

**Positive**
- Tenant database load/faults/disk are isolated from the platform control-plane DB.
- The tenant-cluster provisioner credential cannot authenticate to `capstone-pg`.
- Independent backup retention / PITR / restore blast radius for tenant data.
- Reuses 100% of the merged ADR-033 mechanism — no new provisioning code, no consumer edits.
- De-provisioning stays `git rm` of the claim; drift-corrected; scoped cred in
  `crossplane-system` only.

**Negative / costs**
- **A second 3-instance CNPG cluster** on 3 HA-eligible Mac-Mini workers (3 more PG pods,
  ~256Mi each) — see the fleet-capacity knob in `cluster.yaml` (droppable to 1 instance for
  the demo phase; the value is isolation, not replica count). A 4th HA worker is the real
  fix for deep co-location (`artifacts/design/scheduling-hardening-runbook.md`).
- **A reseal is required** — the target endpoint lives inside the `db-tier-postgres-admin`
  SealedSecret, so the repoint is an operator action, not a merge (see §Cutover).
- **DB-tier change → HELD for a supervised apply.** Standing up a Cluster + repointing the
  live provisioner touches the data tier.

## ⚠ Flags (read before any apply)

- **HELD — supervised apply only.** Do not let this sync unattended. Bring the tenant
  cluster up with the operator watching capacity, then reseal, then verify.
- **Reseal coupling.** The tenant provisioner password must be identical in three places:
  Vault `platform/db/cnpg-tenant/crossplane-provisioner` (→ the ESO → the CNPG
  `DatabaseRole` passwordSecret) **and** the resealed `db-tier-postgres-admin` (→
  provider-sql). A mismatch = provider-sql auth failure (safe: no tenant DB created).
- **Fallback is clean.** To keep the shared-cluster status quo instead, apply only the
  `db-tier/netpol.yaml` `:5432` rule and skip the new cluster + reseal — `db-tier-postgres`
  keeps pointing at `capstone-pg`.

## Cutover (supervised, operator + human)

1. **Merge** this PR (no auto-merge). Nothing provisions yet.
2. **Write Vault** `secret/platform/db/cnpg-tenant/crossplane-provisioner`
   `{username: crossplane_provisioner, password: <strong token>}` (orchestrator; agents are
   classifier-gated from prod secret writes — recipe in
   `docs/operator/in-cluster-db-tier-runbook.md §2`).
3. **Sync** `platform-svc-db-tier` (the ESO) and `platform-cnpg-tenant-cluster`. Watch the
   3 `capstone-tenant-pg` instances reach `1/1` and the cluster report healthy; confirm the
   `crossplane_provisioner` `DatabaseRole` goes Ready (its passwordSecret resolves).
4. **Reseal** `db-tier-postgres-admin` with `endpoint=capstone-tenant-pg-rw.db-tier.svc
   .cluster.local`, `port=5432`, `username=crossplane_provisioner`, `password=<the same
   token from step 2>`; commit the resealed
   `creds/postgres-admin-creds-sealed.yaml`; sync crossplane config.
5. **Verify** end-to-end with a throwaway `database: postgres` claim (see below), then
   `git rm` it.

## Verification / recovery

- **Server-dry-run** the new manifests: `kubectl apply --dry-run=server -f
  platform-services/cnpg/tenant-cluster/` (needs the CNPG CRDs; structural validation via
  `kubectl kustomize` + `kubeconform` is done in this PR).
- **Provisioner reachability:** from a debug pod, or `kubectl -n db-tier exec
  capstone-tenant-pg-1 -- psql -c '\du'` shows `crossplane_provisioner` with
  `Create role, Create DB`.
- **End-to-end:** apply a test `CapstoneTenant` with `database: postgres`; confirm
  `postgresql.sql.crossplane.io` Role/Database/Grant go Ready, Vault
  `tenants/<team>/<env>/database` gets 4 props, the app `‹app›-db` Secret's `DATABASE_URL`
  is a `postgresql://…@capstone-tenant-pg-rw…` DSN, and the pod connects.
- **Netpol:** Hubble `policy-verdict … EGRESS` shows provider-sql → db-tier:5432 ALLOWED;
  the `db-tier` ingress rule admits `crossplane-system` on 5432.
- **Backup/recovery:** `kubectl -n db-tier cnpg backup capstone-tenant-pg --method=plugin
  --plugin-name=barman-cloud.cloudnative-pg.io`; PITR via a bootstrap-from-recovery Cluster
  against `s3://postgres-backups/tenant/` (standard CNPG restore).
- **Rollback:** delete `platform-cnpg-tenant-cluster` + re-seal `db-tier-postgres-admin`
  back to `capstone-pg-rw` (fallback to the shared cluster). `databaseRoleReclaimPolicy:
  retain` + `databaseReclaimPolicy: retain` mean CR removal never DROPs live data.

## Validation performed (this PR)

- `kubectl kustomize platform-services/cnpg/tenant-cluster` and `… platform-services/db-tier`
  render cleanly.
- `kubeconform -ignore-missing-schemas` on the new/edited manifests — all parse (CNPG /
  provider-sql / ESO CRDs are skipped as missing schemas, expected).
- `crossplane render` / live `--dry-run=server` **not** run (no control plane in this
  environment; DB tier changes are HELD) — left to the supervised cutover.
