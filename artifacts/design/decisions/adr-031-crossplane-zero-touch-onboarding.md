# ADR-031 — Zero-touch tenant onboarding via Crossplane

- **Status:** Proposed (architecture gate — requires human approval)
- **Date:** 2026-06-27
- **Repo:** platform-infra
- **Deciders:** human (Clayton) + SRE; drafted by architect
- **Companion:** `artifacts/design/crossplane-onboarding-architecture.md` (XRD/Composition
  sketch, cred boundaries, full bug→declarative table, phased migration)
- **Supersedes (in part):** the imperative onboarding seam — `make harbor-onboard` /
  `harbor-robot` / `harbor-push-robot` / `vault-onboard`, the post-merge operator checklist
  in `template.yaml` step 5b, and (for CI) the embed approach in
  `artifacts/design/self-contained-scaffolder.md`.
- **Relates to:** ADR-008 (promotion.yaml single source), ADR-030 (ESO+Vault secrets), the
  `tenants/_template/` tenancy fence, `capstone:harbor-onboard` (#114), the ArgoCD
  private-repo creds work (this branch).

---

## Context

The v1check golden path proved tenant onboarding works end-to-end, but exposed ~14 bugs.
They are not deep bugs — they are symptoms of an **imperative onboarding seam**:

- `tenants/_template/` is copied and `sed`-substituted (`__TEAM__`, `__SEMESTER__`,
  `__PRNUM__`, `__APPNAME__`) — token gaps and malformed-name bugs (SEC-001).
- Harbor projects + robots are minted by `make` targets running curl-Jobs, then
  `kubeseal`'d by hand into the right namespace with the right `TARGET` host — dual-owner
  collisions, shared-`harbor-push` last-write-wins, wrong-registry-host seals, read-only
  `/tmp` Job breaks, legacy-API breakage.
- The Vault role/policy + in-ns `vault-ca` ConfigMap come from a `make vault-onboard` an
  operator must remember to run (#107 gap).
- CI (`build-and-push.yaml` + `.devops/ci/*`) is copied verbatim into every repo, so fixes
  must be re-shipped to every tenant.
- The whole thing is gated on a **human-merged onboarding PR** plus **post-merge operator
  `make` steps**.

The user has **decided** (these are constraints, not open questions):

1. **Crossplane is the provisioning layer.**
2. **Zero human intervention per onboarding** — no operator scripts, no human-merged
   onboarding PR. The bar: *a human creates a project in Backstage → it just works.*
3. **Bypassing repo branch-protection for the trusted scaffold automation is acceptable.**
4. The human gate **moves to a one-time SRE review** of the Crossplane Composition + the
   providers' scoped creds — **not** per-onboarding approval. (Rationale: a non-SRE
   rubber-stamping onboarding PRs they can't evaluate is a *fake* gate; trust belongs in
   reviewed platform code + Crossplane's reconcile bounds.)

## Decision

Adopt a **Crossplane v2 `CapstoneTenant` composite resource (XRD + Composition)** as the
single declarative onboarding API. A Backstage scaffold emits **one XR**; a reviewed-once
Composition fans it out to **all** tenant provisioning:

- **provider-github** — repo, branch protection, team access, the CI caller file.
- **provider-harbor** — Harbor project + push/pull robot accounts.
- **provider-vault** — per-tenant policy + k8s-auth role (scoped to `tenants/<team>/*`).
- **provider-kubernetes** — AppProject, namespaces (quota/limitrange/netpol/RBAC/PSA),
  `vault-ca` ConfigMap, ESO `SecretStore`+`ExternalSecret`s, env + preview ApplicationSets.
- **ESO `PushSecret`** — bridges the Harbor robot's one-time token into Vault so the
  existing ESO read-path materializes the registry secrets (retires SealedSecrets for robots).

Specific sub-decisions:

- **Emit mechanism:** the scaffolder **commits the XR to `tenants/_claims/<team>-<app>.yaml`
  on `platform-infra` main** via the platform GitHub App (on the branch-protection bypass
  list); ArgoCD syncs it; Crossplane reconciles. **No PR, no human merge.** (Chosen over
  Backstage-direct-apply to keep cluster-write creds off the web-facing backend, get a git
  audit ledger, and make de-provisioning a `git rm` consistent with the existing
  `platform.capstone/semester` GC model.)
- **CI:** centralize `build-and-push.yaml` as a **reusable workflow** (`on: workflow_call`,
  pinned `@v1`); tenant repos ship a ~10-line caller. Fixes ship once.
- **Repo content (v1):** **hybrid** — keep Backstage `fetch:template` for the repo's starter
  content + the 3 small per-team files; Crossplane owns all *platform* provisioning (where
  13 of 14 bugs lived). Full provider-github `RepositoryFile` templating is deferred.
- **Credentials:** the four providers' admin creds live **only** in `crossplane-system` as
  scoped `ProviderConfig` secrets — never in Backstage, never with humans. The
  provider-kubernetes ClusterRole is a hand-curated allow-list (never `cluster-admin`) and is
  the focal point of the SRE review.
- **Migration:** `v1check`/`sample` stay as the frozen manual reference + rollback path;
  new tenants use the Crossplane path; existing live tenants age out with their cohort (or
  are adopted later via observe/import).

The XR carries ~10 schema-validated fields. Because the *shape of what is possible* is fixed
by the reviewed XRD + Composition + scoped ProviderConfigs, a fully automated emit cannot
escalate — which is precisely what makes constraint #4 (one-time SRE review) a real gate.

## Options considered

**Option 1 — Harden the imperative path (status quo+).** Keep `make` + scaffolder actions;
fix the 14 bugs individually; add a merge-triggered robot-mint action (the D-M4-1 fast-follow
already noted in `template.yaml`).
- *Rejected:* does not meet the bar. Still has human-merged PRs and operator steps; the
  bug class (forgotten/mis-flagged imperative steps) is structural, not incidental — fixing
  14 instances doesn't stop the 15th.

**Option 2 — Crossplane composite + GitOps-committed XR (CHOSEN).** Above.
- *Chosen:* turns every imperative gap into a reconciling MR; moves the gate to a one-time
  review of powerful code rather than per-onboarding rubber-stamps; reuses the existing
  ArgoCD + ESO+Vault planes; de-provisioning stays `git rm`.

**Option 3 — Crossplane composite + Backstage backend applies the XR directly.**
- *Rejected for v1:* puts a cluster-write credential on the web-facing Backstage backend
  (larger attack surface), loses the git audit ledger, and needs a separate de-provisioning
  path. Kept as a documented alternative (architecture §7 Option B).

**Option 4 — Pure Terraform/Atlantis or a bespoke onboarding operator.**
- *Rejected:* constraint #1 fixes Crossplane. A bespoke operator is more code to own than a
  Composition over existing providers; Terraform/Atlantis reintroduces a plan/apply approval
  step (another fake gate) and a second state plane outside GitOps.

## Consequences

**Positive**
- Onboarding becomes data (one XR) expanded by reviewed code → the 14-bug class is
  structurally eliminated (see the mapping table in the architecture doc).
- The security gate is honest: SRE reviews the Composition + four scoped creds + the
  provider-kubernetes ClusterRole **once**, instead of per-onboarding rubber-stamps.
- Drift-correcting: deleted/changed tenant resources are reconciled back.
- De-provisioning symmetry preserved (`git rm` the claim file; cohort GC unchanged).
- Robots move onto the ESO+Vault plane → SealedSecrets/`kubeseal`/`TARGET`-host bug class
  retired for registry creds.
- CI fixes ship once via `@v1` reusable workflow.

**Negative / costs**
- **New platform dependency to own:** Crossplane v2 + four providers + Composition functions
  (KCL or Go-templates) — a real learning + maintenance surface.
- **provider-harbor is the load-bearing risk (see "Open questions").**
- **provider-kubernetes ClusterRole is privileged** (mints RBAC/AppProjects); a flawed
  Composition could provision broadly — mitigated by the scoped ClusterRole + the one-time
  review, but this *is* the concentrated trust.
- Branch-protection bypass for the scaffold App must be configured (blessed by constraint #3,
  but it is a real exception to audit).
- Provider maturity: provider-vault is `v0.1.0`; pin and watch.

## Open questions (must resolve before/within build)

1. **Harbor robot secret coverage (BLOCKER for the primary path).** Context7 does not index a
   Crossplane `provider-harbor`; a community one exists but its handling of the *one-time*
   robot token is unconfirmed. **A focused spike is required.** Primary: provider-harbor
   `RobotAccount` connection secret → ESO `PushSecret` → Vault. Fallback: a Crossplane-managed
   mint-Job (the proven curl-Job) writing the token directly to Vault, or a tiny purpose-built
   controller. (Architecture §10.)
2. **Repo content templating** — confirm the v1 hybrid (Backstage keeps `fetch:template`) vs
   pushing repo files into provider-github `RepositoryFile` (architecture §9).
3. **provider-kubernetes ClusterRole** — agree the exact allow-list of kinds/verbs it may
   create (the reviewed boundary, architecture §6).
4. **Control-plane location** — co-resident on Talos (recommended v1) vs separate management
   cluster (architecture §12.5).
5. **Composition function choice** — function-kcl vs function-go-templating (both
   crossplane-contrib; pick on team familiarity).

## Provider-coverage summary (Context7-verified 2026-06-27)

| Provider | Coverage for our needs | Verdict |
| --- | --- | --- |
| **provider-kubernetes** (`crossplane-contrib`, High rep, 471 snippets) | `Object` for arbitrary k8s (AppProject, ns, Quota, LimitRange, NetworkPolicy, RBAC, ESO CRs, ApplicationSet); references + field-path patching; CEL readiness; management policies | ✅ Confirmed, mature — the workhorse |
| **provider-upjet-github** (`crossplane-contrib`, High rep, 112 snippets) | `Repository` (incl. template bootstrap), `BranchProtectionV3`, team repo, `RepositoryFile`; **GitHub App `app_auth`** ProviderConfig (matches `ua-mis-backstage`) | ✅ Confirmed; cannot render templated file *contents* (use template repo / hybrid) |
| **provider-vault** (`upbound/provider-vault`, Upjet, High rep) | `Policy`, `AuthBackendRole` (k8s auth), `Mount`; token ProviderConfig | ✅ Confirmed; ⚠ early version (`v0.1.0`) — pin |
| **provider-harbor** | **Not indexed in Context7.** Community provider exists; robot one-time-token handling **unconfirmed** | ⚠ **GAP — spike required** (open question 1) |
| Crossplane **v2** core | `apiextensions.crossplane.io/v2` XRD (`scope: Namespaced`, no separate Claim), `Composition.mode: Pipeline` with functions | ✅ Confirmed |
