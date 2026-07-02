# ADR-033 — Automatic per-tenant database provisioning

- **Status:** Proposed (extends ADR-031; one-time SRE review of the new admin cred required)
- **Date:** 2026-06-28
- **Repo:** platform-infra
- **Deciders:** human (Clayton) + SRE; drafted by devops
- **Extends:** ADR-031 (Crossplane zero-touch onboarding — the `CapstoneTenant` XRD/Composition),
  ADR-030 (ESO + Vault secrets), ADR-008 (promotion.yaml single source).
- **Relates to:** D-029 / PR #29 (the off-cluster DB tier `ua-mis-db-1`), the Wave-2
  scaffolder templates (PRs #143 Next.js/Prisma, #140 .NET/EF, #141 Python/FastAPI,
  #142 React-static), the per-team ESO secrets contract (`tenants/<team>/<env>/...`).
- **Library verified (Context7, 2026-06-28):** `crossplane-contrib/provider-sql`
  (High reputation, 481 snippets). MySQL `Database` / `User` / `Grant` MRs at
  `mysql.sql.crossplane.io/v1alpha1`; `ProviderConfig` with
  `credentials.source: MySQLConnectionSecret` + `connectionSecretRef`; connection
  details published as `host`, `port`, `username`, `password`, `database`. Latest
  stable release **v0.15.0** (v0.16.0-beta.0 exists; we pin stable).

---

## Context

The Wave-2 scaffolder templates split into two shapes:

- **DB-backed** (Next.js + Prisma, .NET + EF Core, Python + FastAPI) — all expect a
  **MySQL `DATABASE_URL`**. MariaDB 11.8 on the DB tier is MySQL wire-compatible, so a
  `mysql://` URL is correct for all three.
- **DB-less** (React static SPA) — needs no database.

Today a team that needs a database has **manual steps**: someone SSHes to `ua-mis-db-1`,
runs `CREATE DATABASE` / `CREATE USER` / `GRANT`, invents a password, and types the
connection string into The Process "Secrets" tab so ESO materializes it. That is exactly
the imperative-seam bug class ADR-031 eliminates for the rest of onboarding — forgotten
steps, hand-typed credentials, no drift correction, no audit. It also hands the team a
hand-made credential rather than a scoped, reconciling one.

The DB-backed template deployments already wire a `DATABASE_URL` env (`optional: true`,
M4 zero-config) from the ESO-materialized app Secret. **What is missing is the producer**:
nothing creates the schema/user and nothing puts the `DATABASE_URL` into Vault. This ADR
adds that producer to the existing Crossplane composite so a database becomes **data on
the XR**, not a checklist.

## Decision

Add an **optional `database: none|mysql` field** to the `CapstoneTenant` XRD. When
`mysql`, the reviewed-once Composition provisions a database **per environment**
(dev/staging/prod) on the off-cluster DB tier and bridges the credential into Vault so
the app's existing `DATABASE_URL` ExternalSecret materializes it — **zero manual steps**.

Concretely, gated on `database == mysql`, the Composition renders per env:

1. **provider-sql `Database`** `‹teamDb›_‹env›` — the schema (`utf8mb4` /
   `utf8mb4_unicode_ci`). `‹teamDb›` is the team slug with hyphens → underscores (a
   MySQL-identifier-safe form); the env is `dev|staging|prod`.
2. **provider-sql `User`** `‹teamDb›_‹env›` — a scoped login. **No `passwordSecretRef`**,
   so provider-sql **auto-generates** the password and writes it (with username, endpoint,
   port) to a connection secret `‹team›-‹env›-db` in `crossplane-system`
   (`writeConnectionSecretToRef`). Letting Harbor/the-DB generate-and-capture (rather than
   templating a password) is **reconcile-stable** — the same reliability rationale as the
   Harbor robot "Variant-2" already locked in the Composition (a templated secret in a
   stateless go-template would churn every reconcile).
3. **provider-sql `Grant`** — `ALL` privileges on `‹teamDb›_‹env›` to that user (the team
   owns its own database; nothing cross-tenant).
4. **ESO `PushSecret`** (rendered via provider-kubernetes `Object` into `crossplane-system`,
   next to the connection secret, using the platform **`vault-push`** writer SecretStore)
   — bridges the captured `username` / `password` / `endpoint→host` / `port` into Vault at
   **`tenants/‹team›/‹env›/database`**. This is the **same producer plane** as the Harbor
   robot → Vault bridge (one writer per Vault leaf, no dual-owner clobber).

The **admin credential** (a scoped MariaDB provisioner login — *not* `root`) is a
**placeholder SealedSecret** living **only** in `crossplane-system`, exactly like the
github/harbor/vault provisioner creds (ADR-031 §6). provider-sql's `ProviderConfig`
(`db-tier-mariadb`) reads it via `MySQLConnectionSecret`.

The **`crossplane.io/external-name`** annotation is pinned on the `Database`/`User` MRs so
the schema/username are **deterministic** (`‹teamDb›_‹env›`) — in a Composition the
composed MR's `metadata.name` is auto-generated, but the external-name is the actual MySQL
identifier the consumer must reproduce.

### The Vault path contract (⚠ CRITICAL — the producer/consumer seam)

| | value |
| --- | --- |
| **Vault KV v2 logical path** | `secret/data/tenants/‹team›/‹env›/database` |
| **ESO `remoteRef.key` / `PushSecret remoteKey`** | `tenants/‹team›/‹env›/database` |
| **Properties written** | `username`, `password`, `host`, `port` |
| **`‹team›`** | the XR `team` slug (hyphens kept — matches the app ExternalSecret's `tenants/${{ values.team }}/...`) |
| **`‹env›`** | `dev` \| `staging` \| `prod` |
| **DB / username (NOT in Vault — structural)** | `‹teamDb›_‹env›` where `‹teamDb›` = team slug with `-`→`_` |
| **Assembled DSN** | `mysql://‹username›:‹password›@‹host›:‹port›/‹teamDb›_‹env›` |

This leaf is **distinct** from the team-owned `tenants/‹team›/‹env›/app` leaf (the
"Secrets" tab writer), so the platform-owned DB credential and the team's own secrets each
have **exactly one writer** — the single-owner principle that ADR-031 uses to avoid the
dual-owner race (bug #3). It sits under `tenants/‹team›/*`, so the existing per-tenant
`vault-tenant` SecretStore (read scope `secret/data/tenants/‹team›/*`) can already read it
with no policy change.

**Why the URL is assembled by the consumer, not stored whole:** the password is only known
at *runtime* (generated by provider-sql), and neither `PushSecret` nor the Composition
go-template can template it into a URL safely (a render-time random churns; the runtime
value isn't available at render). So the producer pushes the parts; the **consumer's
ExternalSecret `target.template`** assembles the DSN — the identical pattern the
Composition already uses for the Harbor `dockerconfigjson` (`arc-pushsecret-es`).

### ⚠ Required consumer change in the DB templates (PRs #143 / #140 / #141)

The DB templates do **not** yet read a DB credential from Vault — the `.NET` deployment
wires `DATABASE_URL` from `‹app›-secret` key `DATABASE_URL`, but the shipped
`app-secret.externalsecret.yaml` has **no `DATABASE_URL` data entry** (it's only added by a
human via the Secrets tab, which writes to `tenants/‹team›/‹env›/app`). For zero-touch they
must add a **dedicated, platform-owned** ExternalSecret per env overlay (keep it OUT of
`app-secret.externalsecret.yaml`, which the Secrets tab rewrites):

```yaml
# .devops/chart/overlays/<env>/database.externalsecret.yaml  (NEW — platform-owned)
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: ${{ values.appName }}-db
  namespace: ${{ values.team }}-<env>
spec:
  refreshInterval: "1h"
  secretStoreRef:
    name: vault-tenant            # the per-tenant store (same as app-secret)
    kind: SecretStore
  target:
    name: ${{ values.appName }}-db
    creationPolicy: Owner
    deletionPolicy: Delete         # M4 zero-config: missing key != error (no DB yet -> no Secret)
    template:
      engineVersion: v2
      data:
        # assembled DSN; dbname follows the fixed rule <teamDb>_<env>
        DATABASE_URL: "mysql://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/${{ values.team | replace('-','_') }}_<env>"
  data:
    - { secretKey: username, remoteRef: { key: tenants/${{ values.team }}/<env>/database, property: username } }
    - { secretKey: password, remoteRef: { key: tenants/${{ values.team }}/<env>/database, property: password } }
    - { secretKey: host,     remoteRef: { key: tenants/${{ values.team }}/<env>/database, property: host } }
    - { secretKey: port,     remoteRef: { key: tenants/${{ values.team }}/<env>/database, property: port } }
```

and point the deployment's `DATABASE_URL` env at the **`‹app›-db`** Secret (key
`DATABASE_URL`) rather than `‹app›-secret` (the .NET base currently uses `‹app›-secret`;
change `secretKeyRef.name` to `${{ values.appName }}-db`). Keep `optional: true` so a
freshly-scaffolded app still starts before the DB credential lands. Add the new file to
each overlay `kustomization.yaml`. The React-static template needs **no** change (it leaves
`database: none`). These template edits are **out of scope for this PR** (they live on the
template PRs); this ADR specifies the exact contract they must implement.

### Trigger wiring

- The DB scaffolder templates set `database: mysql` in the `CapstoneTenant` XR they emit
  (`tenants/_claims/‹team›-‹app›.yaml`); React-static omits it (defaults to `none`).
- The XRD `enum: [none, mysql]` + `default: none` bounds the field — consistent with the
  low-trust, schema-validated XR posture (ADR-031): a DB-less stack provisions **zero**
  provider-sql resources and never reaches the DB admin credential.

## Near-term alternative (pre-Crossplane-cutover) — and why provider-sql wins

Until the Crossplane control plane is the live onboarding path, the same outcome can be
done **imperatively** by a Backstage scaffolder action **`capstone:provision-database`**
that, against the scoped provisioner login, runs `CREATE DATABASE`/`CREATE USER`/`GRANT`
and `vault kv put`s the four fields to `tenants/‹team›/‹env›/database`. It would honor the
**identical Vault contract** above, so the consumer templates are unchanged and the cutover
to provider-sql is transparent.

- *Use it only as a bridge.* It re-introduces exactly what ADR-031 removes: a
  credential on the web-facing Backstage backend, an imperative step with no drift
  correction (a dropped DB/user is **not** recreated), and bespoke idempotency/rollback
  code to own. **provider-sql is the durable target** — reconciling, drift-correcting, the
  cred confined to `crossplane-system`, de-provisioning by `git rm` of the claim (the
  Composition tears the Database/User/Grant down with the tenant). **Recommendation: build
  the provider-sql path (this ADR); use the action only if a DB is needed before the
  Crossplane cutover, then retire it.**

## Options considered

1. **provider-sql `Database`+`User`+`Grant` in the Composition + ESO PushSecret (CHOSEN).**
   Declarative, reconciling, cred in `crossplane-system`, reuses the existing producer
   plane and Vault read-path. Cost: a 5th provider to own; provider-sql speaks to an
   off-cluster host over the tailnet.
2. **Backstage `capstone:provision-database` imperative action.** Bridge only — see above.
3. **A shared database with per-team schemas, provisioned once.** Rejected: weaker
   isolation (one login blast radius), no per-env separation, and still needs per-team
   user/grant — provider-sql gives per-(team,env) isolation for the same effort.
4. **Run MySQL in-cluster per tenant (an operator / Helm per team).** Rejected: D-029
   deliberately put data on a dedicated off-cluster tier (durability, backups off-cluster,
   not subject to cluster churn); per-tenant in-cluster DBs multiply stateful surface.

## Consequences

**Positive**
- A DB-backed capstone gets a database + correct `DATABASE_URL` with zero manual steps;
  drift-corrected; de-provisioned by `git rm` (symmetry with the rest of ADR-031).
- The credential is scoped, generated, and confined to `crossplane-system` — never typed
  by a human, never on the Backstage backend.
- Per-(team,env) isolation: a leaked dev credential cannot touch staging/prod or another
  team; the Vault leaf sits inside the team's existing read fence (no policy change).
- DB-less stacks pay nothing (gated field).

**Negative / costs**
- **5th Crossplane provider to own** (provider-sql v0.15.0) — pin + watch.
- **provider-sql reaches an off-cluster host.** The controller Pod must egress
  `ua-mis-db-1:3306` over the Tailscale overlay; a `crossplane-system` egress
  NetworkPolicy must permit TCP/3306 to the tailnet CIDR (Cilium enforces — SEC-011).
- **A new powerful admin credential.** The provisioner login can create/drop databases
  and users — the focal point of the one-time SRE review (scope it to CREATE/DROP DB +
  CREATE/DROP USER + GRANT, **never `root`/SUPER**; bind to the tailnet CIDR).
- **Consumer template change required** (above) before the path is end-to-end zero-touch.
- **Requires the DB tier to be live** — see the flag below.

## ⚠ Flags (read before any apply)

- **DB TIER NOT LIVE.** `ua-mis-db-1` is **draft PR #29** (boxes not yet provisioned).
  This stack is **branch + PR only** and **cannot be tested end-to-end** until the DB tier
  is up and the admin credential is resealed. Until then provider-sql sits unauthenticated
  (no Database/User created) — the safe failure mode.
- **Admin cred is powerful → SRE review + bootstrap.** The provisioner login is a new
  privileged credential. It needs the same one-time SRE review as the other provider creds,
  and an operator bootstrap (mint the scoped MariaDB login + reseal `db-tier-mysql-admin`)
  exactly like the crossplane provisioner creds — see `platform-services/crossplane/creds/README.md`.
- **Phase-0 verification (DB tier live).** Confirm against the installed provider-sql
  v0.15.0 CRDs: (a) MR group/kind `mysql.sql.crossplane.io/v1alpha1` Database/User/Grant;
  (b) the **User connection-secret key names** (we map `endpoint`→`host`); (c) that the
  captured password shows **no diff on steady-state reconcile**; (d) the `ProviderConfig`
  `secretKeyMapping` field names; (e) the `crossplane-system`→tailnet:3306 egress policy.

## Validation performed (this PR)

- `python yaml.safe_load_all` on the new/edited manifests — all parse.
- `kubeconform -ignore-missing-schemas` on the standalone Provider/ProviderConfig/SealedSecret.
- **Offline render** of the Composition's inline go-template (Go `text/template` with the
  sprig/crossplane funcs stubbed) against a sample XR: `database: mysql` → 3×
  (Database/User/Grant) with deterministic external-names `demo_team_{dev,staging,prod}` and
  PushSecrets to `tenants/demo-team/‹env›/database`; `database: none` → **zero** provider-sql
  resources (gating confirmed). The full rendered output (60 docs) re-parses as valid YAML.
- `crossplane render` against live functions was **not** run (no Crossplane CLI / control
  plane in this environment; DB tier not live) — left to Phase-0.
