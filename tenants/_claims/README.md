# tenants/_claims — the zero-touch onboarding ledger (ADR-031 §7 Option A)

Each file here is **one `CapstoneTenant` custom resource (XR)** — the *entire*
per-onboarding artifact. The Backstage "New Capstone Project" scaffold commits one
`<team>-<app>.yaml` here **directly to `main`** (via the platform GitHub App, on the
branch-protection bypass list — constraint #3); ArgoCD (`platform-crossplane-claims`)
syncs it; Crossplane's reviewed-once Composition
(`platform-services/crossplane/apis/composition.yaml`) reconciles it into the full
tenant: repo + branch protection + Harbor project/robots + Vault policy/role + the
whole k8s tenancy fence (AppProject, namespaces, quota/limitrange/netpol/RBAC/PSA,
ESO plumbing, env/preview ApplicationSets).

**No onboarding PR. No human merge. No operator `make` steps.** The bar (ADR-031):
*a human creates a project in Backstage → it just works.*

## This is the onboarding ledger

- **Onboard:** the scaffold commits `team-app.yaml` here → tenant stands up.
- **De-provision (cohort GC symmetry):** `git rm` the claim file(s) → ArgoCD prunes
  the XR → Crossplane + the AppProject finalizers tear the tenant down. Graduating a
  cohort = `git rm tenants/_claims/*` for that semester, exactly like the existing
  `platform.capstone/semester` GC model for `tenants/team-*`.

  **`git rm` alone reclaims the cluster/Harbor/Vault side correctly, but leaves two**
  **things behind** (FIX-10, VERIFY-2 2026-08-15 — see `artifacts/exploration/`):
  1. The tenant's GitHub **app repo** stays live and keeps its `capstone-tenant`
     topic, so catalog GitHub-discovery keeps re-registering it as a "ghost
     tenant". The Process admin **Tenant Teardown page**
     (`capstone-tenants-backend`/`teardownCore.ts`) opens the identical claim-removal
     PR AND strips that topic (and can optionally archive the repo) — it is the
     **recommended** de-provision path for single-tenant teardown. If you `git rm`
     directly (e.g. a bulk cohort GC, where the portal's one-at-a-time
     type-to-confirm dialog doesn't scale), strip the topic on each app repo
     afterward: `gh api -X PUT repos/UA-MIS/<appName>/topics -f names[]=<remaining
     topics>` (omit `capstone-tenant`).
  2. Vault KV data under `tenants/<team>/**` (Harbor robot credentials,
     per-environment database passwords) is **not** deleted — no tenant
     PushSecret sets `deletionPolicy: Delete`, so ESO's default (retain the
     remote value) applies. This is a **deliberate KEEP-BY-DESIGN decision**
     (decision-log `D-082`), not a bug and not an oversight: the writer identity
     these PushSecrets use (`crossplane-push`, see
     `platform-services/external-secrets/vault-policies/crossplane-push-role.sh`)
     is intentionally granted `create`/`read`/`update` only — no `delete` — so
     enabling cleanup would mean widening a deliberately narrow writer's blast
     radius. The retained data is also functionally inert the instant teardown
     completes (the underlying MySQL database/user and the Harbor robot are
     themselves deleted by the same cascade), so there is nothing live left to
     protect by deleting the Vault copy sooner. See `D-082` for the full
     reasoning and the punch-listed follow-up (an out-of-band, separately-
     credentialed KV garbage-collector, not a change to this writer's grant).

  Wiring topic-stripping into a fully-automatic git-path hook was considered and
  rejected for FIX-10: it would require handing a CI trigger (fired by any merge to
  this repo's protected `main`, not gated by the portal's admin-group check) the
  same GitHub App "Administration" write permission across every tenant app repo
  that `teardownCore.ts` currently only grants to an ADMIN-authenticated request —
  a real widening of the trust boundary for a convenience win. Manual topic-strip
  after a bulk `git rm`, or routing single-tenant teardown through the portal, is
  the safer trade.

## Excluded from sync

`platform-crossplane-claims` excludes `_*.yaml` and `README.md` — so
`_example-acme-app.yaml` is a documented sample, **not** a live claim (mirrors how
`tenants-appset` excludes `tenants/_template`).

## The XR shape (≈10 schema-validated fields)

See the XRD: `platform-services/crossplane/apis/xrd.yaml`. Required: `team`,
`appName`, `semester`. Optional (defaulted): `githubTeam`, `port`, `previewEnabled`,
`domain`.
