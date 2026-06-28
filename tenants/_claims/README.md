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

## Excluded from sync

`platform-crossplane-claims` excludes `_*.yaml` and `README.md` — so
`_example-acme-app.yaml` is a documented sample, **not** a live claim (mirrors how
`tenants-appset` excludes `tenants/_template`).

## The XR shape (≈10 schema-validated fields)

See the XRD: `platform-services/crossplane/apis/xrd.yaml`. Required: `team`,
`appName`, `semester`. Optional (defaulted): `githubTeam`, `port`, `previewEnabled`,
`domain`.
