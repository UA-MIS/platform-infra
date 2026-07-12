# Three-Tier Tenant Model — Phased Implementation & Migration Plan

Companion to **ADR-036**. This is the *build-with-the-user* plan: the ordered set
of changes to the Composition / XRD / compose action / scaffolder / chart, plus a
migration runbook for existing tenants. **Nothing here is applied yet** — the ADR
is review-then-build.

Source-of-truth files (read alongside):
`platform-services/crossplane/apis/{xrd,composition}.yaml`;
`applicationsets/crossplane-*-app.yaml`;
`platform-services/backstage/app/plugins/scaffolder-backend-module-capstone/src/actions/{composeProject,emitTenantClaim,commitToMain,preflight}.ts`;
`platform-services/backstage/templates/_fragments/_contract/.devops/**`.

---

## Phase 0 — Design freeze & pre-flight verification (no cluster writes)

Goal: confirm the risky unknowns before writing any Composition.

1. Approve ADR-036 and resolve its §5 open questions.
2. **Enumerate live tenants:** `kubectl get capstonetenants -A` — the on-disk
   ledger (`tenants/_claims/`) has only `swami-swamiapp`, `swami-swami-student3`.
   computa/meow may exist in-cluster without committed claims (the 07-10 incident
   pattern) — the migration set is whatever this returns, not the file list.
3. **Provider adoption spike (scratch namespace):** for each provider used by the
   substrate, confirm import/adoption of an *existing* live resource into a new
   Composition without recreation:
   - provider-kubernetes `Object` adopting an existing k8s object (SSA
     field-manager takeover; test `--force-conflicts` semantics).
   - provider-harbor `Project`/`RobotAccount` import via `crossplane.io/external-name`.
   - provider-vault `Policy`/`AuthBackendRole` import.
   - provider-sql `Database`/`User`/`Grant` import (external-name = the SQL identifier).
   Record which need `managementPolicies: [Observe]` first. This gates the
   zero-downtime migration path (§Migration Option 1).
4. Confirm the provider-kubernetes ClusterRole
   (`rbac/provider-kubernetes-rbac.yaml`) already grants `networking.k8s.io`
   `Ingress` write (the app tier now creates Ingresses via `Object`); add if missing.

---

## Phase 1 — New XRDs + Compositions (additive; old model untouched)

Ship the three new APIs **alongside** the existing `CapstoneTenant`, with no
consumers yet. Old tenants keep running.

1. **XRDs** (`platform-services/crossplane/apis/`):
   - `xrd-team.yaml` — `CapstoneTeam` (`spec: team, semester, githubTeam?,
     quotaOverrides?`). Reserved-name CEL + `team` pattern (copied from ADR-031).
   - `xrd-app.yaml` — `CapstoneApp` (`spec: team, appName, semester, domain?,
     database?, port?, previewEnabled?, components[]{name,path,port}`).
   - `xrd-component.yaml` — `CapstoneComponent` (`spec: team, appName, repo,
     semester, previewEnabled?`).
2. **Compositions** — split the current 1471-line `composition.yaml` by ownership:
   - `composition-team.yaml` ← the AppProject (with wildcard `sourceRepos`),
     the per-env namespace bundle (ns/quota/limitrange/3×netpol/rolebinding/
     eso-SA/vault-ca/SecretStore), Harbor project + robots + PushSecrets, Vault
     Policy/Role, ARC block. **Verbatim-lifted** from today's Composition, minus
     the `$app`/`$repoUrl` references. `quotaOverrides` merges over the default
     env tiers.
   - `composition-app.yaml` ← the Ingress (new — rendered from `components[]`
     path-map, replacing the repo chart's `ingress.yaml`), app-secret
     ExternalSecret per env (Vault leaf `…/<app>/app`), and the ADR-033 DB block
     (Database/User/Grant/PushSecret + `<app>-db` ExternalSecret) **re-keyed to
     `<teamDb>_<app>_<env>` and the per-app Vault leaf**.
   - `composition-component.yaml` ← the env ApplicationSet (renamed
     `<team>-<repo>-envs`, git-files on the repo's promotion.yaml) + preview
     ApplicationSet, with the cross-tier `dependsOn` on the team namespaces +
     SecretStore + app-secret Objects (deterministic Object names) so
     provision-before-deploy still holds; ArgoCD retry covers residual readiness.
3. **Claims dirs + ApplicationSets:** create `tenants/_teams|_apps|_components/`
   (each with a README + `_example-*.yaml`) and three directory-recurse
   Applications (`platform-crossplane-{teams,apps,components}`) modeled on
   `applicationsets/crossplane-claims-app.yaml`, sync-waves 2/3/4.
4. **RBAC/governance:** add `CODEOWNERS` (labmx → `tenants/_teams/`; platform →
   `tenants/_apps/*vm*`). Verify provider-kubernetes Ingress RBAC (Phase 0.4).

Exit: `kubectl explain capstoneteam/capstoneapp/capstonecomponent` works; a
hand-written trio in a scratch team stands up a full tenant with **one** owner per
object; `crossplane render` (offline) is green for all three.

---

## Phase 2 — Chart / `_contract` changes

Make the repo chart ship only what a component owns.

1. **Remove from the repo chart/base:** `ingress.yaml` (now app-tier-owned). Keep
   `deployments.yaml` + `services.yaml` (+ `serviceaccount.yaml`), still looped
   over the repo's `.devops/components.yaml` (a repo may still hold multiple
   workloads — the monorepo case).
2. **Remove from every overlay:** `secretstore.yaml` (SecretStore + `eso-tenant`
   SA → team tier), `app-secret.externalsecret.yaml` + `database.externalsecret.yaml`
   (→ app tier). Overlays keep: `namespace:`, image tags, replicas, env labels.
   **Drop the Ingress host `patches:` block** (no Ingress in the repo now).
3. `components.yaml` stays (the CI build matrix for the repo). `promotion.yaml`
   stays (per-repo). `path`/`port` per workload are now *also* declared to the app
   claim's `components[]` (the compose action wires this — Phase 3).
4. Update `_contract` READMEs + `docs/` to the new ownership boundaries.

Exit: a scaffolded repo renders Deployment+Service only; `kustomize build` of each
overlay is green and produces no Ingress/SecretStore/ExternalSecret.

---

## Phase 3 — Scaffolder changes

Turn the one-XR emit into a tiered, idempotent emit.

1. **Emit actions** (`…/src/actions/`) — refactor `emitTenantClaim.ts` into:
   - `capstone:emit-team-claim` → `tenants/_teams/<team>.yaml` (skip if exists).
   - `capstone:emit-app-claim` → `tenants/_apps/<team>-<app>.yaml`; if it exists,
     **append** the new repo's entry to `components[]` (the additive, serialized
     edit — the host/path registry).
   - `capstone:emit-component-claim` → `tenants/_components/<team>-<repo>.yaml`.
   Keep the reserved-name denylist + slug validation in each (defense in depth).
2. **Preflight** (`preflight.ts`) — read `tenants/_teams|_apps/` from platform-infra
   to decide which tiers are missing, and to detect **host/path collisions**
   (two repos claiming `/api` on one app) → fail closed.
3. **composeProject.ts** — unchanged assembly of the repo, minus the removed
   ingress/secret templates; add outputs for the app claim's `components[]` entry
   (name/path/port derived from the chosen fragment(s), as it already computes the
   component model via `composePlan.mjs`).
4. **commit-to-main** — commit the 1–3 new/edited claim files atomically (team?/
   app/component). VM or quota-override changes → **open a PR** instead of
   auto-commit (governance, ADR-036 §4).
5. **Wizard UX** — "New project" gains team-existing/new + app-existing/new +
   this-repo-is-a-new-component-of-an-existing-app paths; emits only missing tiers.

Exit: creating the first app for a new team emits three files; a second app emits
two; adding a second repo to an app emits one component file + one `components[]`
append. All auto-committed; the tenant stands up zero-touch.

---

## Phase 4 — Migration & cutover (per tenant; see runbook below)

Migrate live tenants off `CapstoneTenant` onto the trio, then retire the old
XRD/Composition once `kubectl get capstonetenants` is empty.

---

## Phase 5 — Cleanup

1. `git rm` old `CapstoneTenant` XRD + `composition.yaml` + `crossplane-claims-app`
   + `tenants/_claims/` once no live CapstoneTenants remain.
2. CI lint: host/path-collision check over `tenants/_apps/*.yaml`.
3. Update `CROSSPLANE-CUTOVER.md`, ADR-031/033/034 cross-refs, operator runbooks.

---

## Migration runbook

**Scope:** every object returned by `kubectl get capstonetenants -A` (not just the
two on-disk swami claims). Do **swami first** as the canary — its two-claim
collision is already live, so it is the highest-value and lowest-regret target.

### Option 1 — Zero-downtime orphan-adopt (per Phase-0.3 spike results)

Use only if Phase 0.3 confirmed clean per-provider import. Per team:

1. Author the trio (`CapstoneTeam`, one `CapstoneApp` per existing app, one
   `CapstoneComponent` per existing repo) with **identical** derived names/
   external-names (same `AppProject swami`, `swami-dev`, Harbor `swami`, schema
   `swami_*`). For the app tier, initialize each app Composition's provider MRs
   with `managementPolicies: [Observe]` if the spike required it.
2. **Orphan the old** substrate: set the old `CapstoneTenant`'s composed MRs to
   `deletionPolicy: Orphan` (patch the XR / composition-scoped), then `git rm` the
   old `tenants/_claims/<team>-*.yaml`. ArgoCD prunes the **XR**; the live MRs and
   k8s objects **remain** (the 07-10 "ORPHAN-all-before-prune" technique).
3. Commit the trio → the new Compositions **adopt** the orphaned resources
   (external-name match; provider-kubernetes SSA takeover). Flip any `Observe` MRs
   back to default `Observe,Create,Update,Delete`.
4. **Copy-forward secrets:** `vault kv get/put` app-secret from
   `tenants/<team>/<env>/app` → `tenants/<team>/<env>/<app>/app` for each env.
   (DB creds already live at the per-team path — keep swami's `swamiapp` DB on its
   legacy schema/path via a one-off `database` mapping, or dump/restore into
   `<teamDb>_<app>_<env>`; decide per ADR-036 §5.4.)
5. Verify: one owner per object (`kubectl get … -o yaml | grep managedFields` — no
   two Crossplane field managers), pods stay `1/1`, no netpol/Object flap, Harbor
   pull works, app-secret + DB resolve.

### Option 2 — Backup + teardown + re-onboard (safe; brief downtime)

Recommended for **test** tenants (computa/meow, and swami if disposable) — avoids
provider-import risk entirely.

1. Back up: `vault kv get` every `tenants/<team>/**`; `mysqldump`/`pg_dump` each
   live DB; note the repo list.
2. `git rm` the team's old `tenants/_claims/*.yaml`; let ArgoCD prune + Crossplane
   + AppProject finalizers tear the tenant down. Confirm namespaces gone.
   (Heed the incident gotchas: pause churn if MRs fight during prune; shared team
   namespaces default `Delete` — cascade is intended here.)
3. Re-onboard through the new wizard (emits the trio) → substrate + app + component
   stand up fresh under the new model.
4. Restore: `vault kv put` secrets to the **new** per-app path; restore DB dumps
   into `<teamDb>_<app>_<env>`.
5. Verify as in Option 1.5.

### swami specifics

- Two apps under `team=swami`: `swamiapp` (`database: mysql`, port 3000) and
  `swami-student3` (`database: none`, port 8080). → one `CapstoneTeam(swami)` +
  two `CapstoneApp` + two `CapstoneComponent`.
- `swamiapp` has live data (MariaDB schema `swami_*`) and a public URL / Clerk /
  DB (per the swami-live memory) → back it up first; prefer Option 1 if the spike
  is clean, else Option 2 in a maintenance window.
- `swami-student3` is DB-less → trivial either way.

---

## Change-surface summary (what to touch, in order)

| # | Area | Files | Change |
|---|------|-------|--------|
| 1 | XRDs | `apis/xrd-team.yaml`, `apis/xrd-app.yaml`, `apis/xrd-component.yaml` | new (split ADR-031 XRD by tier) |
| 2 | Compositions | `apis/composition-{team,app,component}.yaml` | split current `composition.yaml`; re-key DB + app-secret per-app; new app Ingress |
| 3 | Claims sync | `applicationsets/crossplane-{teams,apps,components}-app.yaml`; `tenants/_{teams,apps,components}/` | new dirs + directory-recurse Apps |
| 4 | Repo chart | `_fragments/_contract/.devops/chart/**` | remove ingress from base; remove secretstore/app-secret/db ES from overlays; drop ingress host-patch |
| 5 | Scaffolder | `actions/emit{Team,App,Component}Claim.ts`, `preflight.ts`, `composeProject.ts`, `commitToMain.ts` | tiered idempotent emit; components[] append; collision check; VM/quota → PR |
| 6 | Wizard | `templates/**/template.yaml` | team/app/component existing-vs-new flow |
| 7 | Governance | `CODEOWNERS`, CI lint | labmx on `_teams`; platform on VM; host/path-collision lint |
| 8 | Migrate | `tenants/_claims/*` → trio; retire old XRD/Composition | per runbook |

---

## Top risks

1. **Provider adoption (highest).** Zero-downtime migration hinges on Crossplane
   importing existing Harbor/Vault/SQL/k8s resources without recreation. SSA
   field-manager takeover and per-provider external-name import are the specific
   unknowns → gated by the Phase-0.3 spike; Option 2 (teardown/re-onboard) is the
   fallback that removes this risk.
2. **Cross-tier ordering.** The component ApplicationSet must not deploy before
   the team namespaces/SecretStore + app-secret exist. `dependsOn` across
   Compositions needs deterministic Object names; residual gaps lean on ArgoCD
   retry (as today). Verify no ImagePullBackOff / ESO flap on first sync.
3. **Secret/DB path move.** app-secret moves to a per-app Vault leaf; DB schema
   naming changes. Copy-forward must be exact or apps start with "secret loaded:
   false" / DATABASE_URL unset. swami has live data.
4. **Ingress ownership regression.** Moving the Ingress from repo→app claim means
   an in-flight repo must not also ship one during migration (double Ingress on one
   host). Sequence Phase-2 chart change with each repo's component migration.
5. **`sourceRepos` wildcard** loosens the AppProject guardrail to the whole UA-MIS
   org (isolation still enforced by namespace/RBAC/netpol) — accept or revert to a
   list (ADR-036 §5.3).
6. **Governance drift.** CODEOWNERS + the VM/quota PR-gate must actually block
   auto-commit for those paths; verify the GitHub App bypass does not also bypass
   CODEOWNERS review for `_teams`/VM claims.
