# ADR-036 — Three-Tier Tenant Model (team / app / component)

- **Status:** Proposed (review-then-build; supersedes the single `CapstoneTenant` claim shape of ADR-031 §3–§4)
- **Date:** 2026-07-12
- **Deciders:** platform owner (ccsmith33), labmx (governance)
- **Related:** ADR-031 (Crossplane zero-touch onboarding), ADR-033 (auto-DB), ADR-034 (unified project wizard), ADR-030 (ESO secrets), ADR-008 (promotion model), the 2026-07-10 duplicate-tenant-claim incident
- **Companion:** `artifacts/design/three-tier-tenant-implementation-plan.md` (phased plan + migration runbook)

---

## 1. Context

### 1.1 What exists today

Onboarding emits **one** `CapstoneTenant` custom resource (XR) per **app** to
`tenants/_claims/<team>-<app>.yaml` (ADR-031). A reviewed-once Crossplane
Composition (`platform-services/crossplane/apis/composition.yaml`) expands that
single XR into the *entire* tenant. Reading that Composition, the resources it
renders fall into two very different ownership classes:

| Keyed on `$team` (team-substrate — ~90% of the Composition) | Keyed on `$app`/repo (app-specific — a handful) |
| --- | --- |
| AppProject `<team>` | AppProject `sourceRepos` entry = `github.com/UA-MIS/<app>` |
| Namespaces `<team>-{dev,staging,prod}` + Quota + LimitRange + 3 NetworkPolicies + PSA + Goldilocks | env ApplicationSet `<team>-envs` → reads `<app>/.devops/promotion.yaml` |
| Developer RoleBinding → `capstone-tenant-developer` | preview ApplicationSet (`owner: UA-MIS, repo: <app>`) |
| Per-ns ESO plumbing: `eso-tenant` SA, `vault-ca` CM, `vault-tenant` SecretStore | `status.repoUrl` |
| Harbor project `<team>` + push/pull robots + PushSecrets→Vault | — |
| Vault policy `tenant-<team>-ro` + k8s AuthBackendRole | — |
| ARC per-team scale-set + hook CM + push ExternalSecret | — |
| Auto-DB schema `<teamDb>_<env>` + user + grant + Vault push | — |

**The XR conflates the team with the app.** Because ~90% of what it renders is
team-keyed, two apps for the same team emit two XRs that render *identically
named* substrate objects (same `AppProject swami`, same `swami-dev` namespace,
same `Project swami` in Harbor, same `<team>-envs` ApplicationSet **name** but a
*different* `repoURL`). Crossplane / ArgoCD then have two owners for one object —
the **apply-fight**.

### 1.2 The incident this fixes

The 2026-07-10 duplicate-`CapstoneTenant` incident: two claims for `team=swami`
(`swami-swamiapp`, `swami-swami-student3`) drove a netpol apply-fight →
Cilium CPU pin on `mac-debian-01` → vault-0 raft snapshot stall → ESO login
timeouts. Recovery required pausing churn, orphaning MRs before prune, and
removing a claim. **The data model — one team-substrate rendered N times per
team — is the root cause, not the reconcile mechanics.** Both those swami
claims are still on disk (`tenants/_claims/swami-*.yaml`): the collision is live.

### 1.3 What the user needs (decision 2026-07-11/12)

1. A team may have **unbounded apps**.
2. An app may be **split across multiple repos** (a separate frontend repo and a
   separate backend repo), **but keeps ONE host** `<app>.capstone.uamishub.com`,
   path-routed (`/` → frontend, `/api` → backend) — **not** `<app>-frontend` /
   `<app>-backend` hosts. Keep the dotted `<app>.<env>` hosts (the Advanced
   Certificate for `*.capstone.uamishub.com` is already paid).
3. **Governance:** labmx reviews quota (no hard cap); heavy true-VM workloads gate
   on a platform-infra PR approval.

The existing `frontend-backend` layout (ADR-034) **already** does one-host /
N-path routing — but only *within one repo* (`.devops/components.yaml` + one
chart). The missing capability is letting the path-mounted workloads live in
**separate repos** bound to one app host.

---

## 2. Decision

Split the monolithic `CapstoneTenant` into **three claim kinds**, each owning a
disjoint slice of the tenant, so every provisioned object has **exactly one
owner** and higher tiers are created **once** while lower tiers are **additive**.

```
CapstoneTeam        (tenants/_teams/<team>.yaml)          — filed ONCE per team
   └─ owns the substrate: AppProject, namespaces+quota+netpol+RBAC+PSA,
      Harbor project + robots, Vault policy/role, per-ns ESO plumbing, ARC.
CapstoneApp         (tenants/_apps/<team>-<app>.yaml)     — many per team
   └─ owns the app identity: ONE host + per-env path→service Ingress,
      app-secret (Vault leaf + ExternalSecret), optional per-app database.
CapstoneComponent   (tenants/_components/<team>-<repo>.yaml) — one per repo
   └─ owns one repo's delivery: env + preview ApplicationSets that deploy the
      repo's overlay into <team>-<env>. The repo's chart ships Deployment/
      Rollout + Service ONLY (no ingress, no secretstore) and mounts on a PATH
      declared by its parent CapstoneApp.
```

`CapstoneTenant` (old) = `CapstoneTeam` + one `CapstoneApp` + one
`CapstoneComponent`. The single-repo FE+BE app stays a **one-repo** component
that ships two workloads; a split FE/BE app becomes **two** components under one
app. Both feed the same app-owned Ingress. The tiering is the *only* structural
change — the reviewed-once, low-trust, zero-touch properties of ADR-031 are
preserved (each XRD is still a small, pattern-bounded, CEL-guarded surface).

### 2.1 Resource-ownership split (authoritative)

**Tier 1 — `CapstoneTeam`** (cluster-scoped XR; `tenants/_teams/<team>.yaml`).
Single owner of everything currently keyed on `$team`:

- `AppProject <team>` — **`sourceRepos: https://github.com/UA-MIS/*`** (org
  wildcard; see §3.3 rejected alternatives). `destinations` = `<team>-{dev,
  staging,prod}` + `<team>-pr-*` (unchanged). ESO/Rollout whitelist (unchanged).
- Namespaces `<team>-{dev,staging,prod}` + `ResourceQuota` + `LimitRange` +
  `default-deny-all` / `allow-ingress` / `allow-egress` NetworkPolicies + PSA
  labels + Goldilocks label (verbatim from today's Composition).
- Developer `RoleBinding` → the pre-reviewed `capstone-tenant-developer`
  ClusterRole (CXP-2).
- Per-namespace ESO plumbing: `eso-tenant` SA, `vault-ca` ConfigMap,
  `vault-tenant` SecretStore. **These move here from the repo overlay**
  (`secretstore.yaml`) — today the repo overlay *and* the Composition both ship
  them, a latent dual-owner that the split removes.
- Harbor `Project <team>` + `<team>-push` / `<team>-pull` RobotAccounts +
  PushSecrets → Vault (`tenants/<team>/ci/harbor-push`,
  `tenants/<team>/<env>/harbor-pull`). Robots are project-level, so they already
  cover every app/component image in the project — unchanged.
- Vault `Policy tenant-<team>-ro` (scope `secret/data/tenants/<team>/*`) +
  `AuthBackendRole tenant-<team>`. The policy already covers the *deeper*
  per-app leaves introduced in §2.1-T2 — no policy change needed.
- ARC per-team scale-set + hook ConfigMap + push ExternalSecret (unchanged).
- **`quotaOverrides`** (optional map, per env) — labmx-governed (§4).

**Tier 2 — `CapstoneApp`** (cluster-scoped XR; `tenants/_apps/<team>-<app>.yaml`).
Single owner of the app-scoped, additive resources:

- **Per-env Ingress** `<app>` in `<team>-<env>`, host
  `<app>.<env>.capstone.uamishub.com` (prod: `<app>.capstone.uamishub.com`),
  rendered from the app's **`components[]` path-map**
  (`{ name, path, port }` → Service `<app>-<name>`). This is the **single owner**
  of the merged host — no repo touches the Ingress (§3.1).
- **app-secret**: ExternalSecret `<app>-secret` per env (Vault leaf
  **`tenants/<team>/<env>/<app>/app`** — now *per-app*, was per-team). Owned here
  so multiple repos of one app share it and two apps never collide.
- **Optional per-app database** (`database: none|mysql|postgres`, ADR-033 logic
  moved here): schema/db `<teamDb>_<app>_<env>`, Vault leaf
  `tenants/<team>/<env>/<app>/database`, `<app>-db` ExternalSecret. Per-app DB
  (was per-team) so two apps don't share one schema (§3.4).
- `status`: host(s), db name.

**Tier 3 — `CapstoneComponent`** (cluster-scoped XR;
`tenants/_components/<team>-<repo>.yaml`). Single owner of one repo's delivery:

- env ApplicationSet `<team>-<repo>-envs` → git-files generator on **this repo's**
  `.devops/promotion.yaml`, deploying its overlay into `<team>-<env>`. Name is
  repo-unique → no collision between repos.
- optional preview ApplicationSet `<team>-<repo>-preview` (security-gated).
- The **repo's chart** (the `_contract`) ships `Deployment`/`Rollout` + `Service`
  (`<app>-<workload>`) **only** — ingress, secretstore and the app/db
  ExternalSecrets are removed from the repo (they belong to T1/T2). The workload
  is reached because its Service name matches a path entry in the parent
  `CapstoneApp.components[]`.

Cross-tier references: `CapstoneApp.spec.team` and `CapstoneComponent.spec.{team,
app}` are plain string refs (the Composition derives namespaces/host from them).
No CR *owns* another CR — deletion symmetry is per-file `git rm` at each tier.

### 2.2 How the substrate is created once and never fought over

- The team substrate is rendered by **exactly one** XR (`CapstoneTeam <team>`).
  Filing a second app for the team creates a `CapstoneApp` — which renders **no**
  substrate object — so there is nothing to double-manage. The apply-fight class
  is eliminated *by construction*, not by reconcile tuning.
- The scaffolder emits a `CapstoneTeam` **only if one does not already exist**
  (preflight reads `tenants/_teams/<team>.yaml`); otherwise it emits only the
  `CapstoneApp` (+ `CapstoneComponent`). Idempotent by file existence.
- `<team>-envs` (the colliding ApplicationSet in the incident) no longer exists;
  each repo owns a uniquely named `<team>-<repo>-envs`.

### 2.3 Host + path routing across separate repos

**Decision: the parent `CapstoneApp` owns the merged Ingress** (a single k8s
object per env), rendered from its `components[]` path-map; component repos ship
**only** Deployment + Service. Adding a repo to an app is a small, additive,
serialized edit to the app claim's `components[]` list (auto-committed by the
scaffolder when it creates the repo) **plus** a new `CapstoneComponent` file.

- One Ingress object, one owner → **no runtime merge ambiguity, one TLS block**,
  and the app claim is the single host/path **registry** (collisions are caught
  at emit/CI time, not at runtime).
- Path routing is unchanged from ADR-034: `pathType: Prefix`, longest-prefix
  wins, so `/api/*` → backend Service and `/` → frontend Service regardless of
  repo boundaries. The Services are just in the shared `<team>-<env>` namespace,
  written by two different component charts.
- The alternative — each repo ships its own path-scoped Ingress and Traefik
  merges same-host Ingresses — is **rejected as primary** (§3.1): it reintroduces
  a shared *implicit* object (the merged host) with N writers, duplicate TLS
  blocks, and no central collision guard — the opposite of this ADR's goal.

### 2.4 Claim file layout

```
tenants/
  _teams/       <team>.yaml                 CapstoneTeam   (labmx CODEOWNER)
  _apps/        <team>-<app>.yaml           CapstoneApp
  _components/  <team>-<repo>.yaml          CapstoneComponent
  _claims/      (retired after migration — old CapstoneTenant)
```

Three directory-recurse ApplicationSets (`platform-crossplane-teams|apps|
components`), each excluding `{_*.yaml,README.md}`, sync-waved
`teams(2) → apps(3) → components(4)` after `apis(1)`. `git rm` at any tier prunes
that tier only; removing a team prunes its substrate (and, via AppProject
finalizers, its apps' workloads).

---

## 3. Consequences & rejected alternatives

### 3.1 Ingress ownership (chosen: centralized on the app claim)

- **Chosen (A):** `CapstoneApp` renders the per-env Ingress from `components[]`.
  Single owner; collisions guarded in the claim; consistent for mono- and
  multi-repo apps. Cost: adding a repo edits the app claim (a serialized,
  scaffolder-authored commit — **not** a concurrent cluster writer, so no
  apply-fight).
- **Rejected (B):** each repo ships its own path Ingress; Traefik merges by host.
  Truly decentralized, but: implicit shared host with N writers, duplicate/
  conflicting TLS + annotations, path collisions only surface at runtime, and the
  per-env host-prefix knowledge is duplicated into every repo overlay. Rejected —
  it re-creates the shared-object hazard this ADR removes.

### 3.2 Number of CRDs (chosen: three XRDs)

Three separate XRDs/Compositions (vs one XRD with a `tier` discriminator). Chosen
for clean per-tier prune semantics, clean CODEOWNERS boundaries, and smaller
reviewed Compositions. Cost: three files to keep coherent; mitigated by shared
CEL/reserved-name guards copied across XRDs (already the pattern in ADR-031).

### 3.3 AppProject `sourceRepos` (chosen: org wildcard)

`https://github.com/UA-MIS/*` on the team AppProject. Rejected: an explicit
per-repo list maintained on the team claim — it re-introduces per-component churn
on a shared (team-tier) object, the exact hazard we are removing. The real tenant
isolation is the namespace/RBAC/netpol fence, not `sourceRepos`; the wildcard is
scoped to the UA-MIS org and is an acceptable guardrail loosening (flagged as an
open question for the user).

### 3.4 Database granularity (chosen: per-app)

Per-app schema `<teamDb>_<app>_<env>` + Vault leaf
`tenants/<team>/<env>/<app>/database`. Rejected: one shared `<teamDb>_<env>`
schema across a team's apps — two apps would collide on table names and share
credentials. Cost: existing swami DB lives at the *old* per-team path/schema and
must be handled at migration (keep-legacy-path for `swamiapp`, or dump/restore —
see companion plan §Migration).

### 3.5 Backward-compat / breaking surface

- Repo chart contract changes (ingress + secretstore + app/db ExternalSecrets
  leave the repo). Existing tenant repos keep working until migrated; the change
  ships in the `_contract` for *new* repos and is applied to existing repos as
  part of migration.
- Vault app-secret path moves `tenants/<team>/<env>/app` →
  `tenants/<team>/<env>/<app>/app`. Existing secrets must be copied at migration.
- The 07-10 incident's live swami collision is resolved by migration, not by this
  file alone.

### 3.6 Positive consequences

- Apply-fight class eliminated for the team substrate (single owner).
- Unbounded apps per team; unbounded repos per app; one host per app with
  path-routed multi-repo components.
- Latent dual-owner (repo overlay vs Composition shipping the same SecretStore/SA)
  is cleaned up as a side effect.
- Governance seams (labmx quota, VM PR-gate) map cleanly onto CODEOWNERS of the
  three claim directories.

---

## 4. Governance

- **Quota (labmx, no hard cap):** `tenants/_teams/` has a CODEOWNERS entry for the
  labmx GitHub team. Default env tiers ship in the team Composition; a bump is an
  edit to `CapstoneTeam.spec.quotaOverrides` in the team claim → a platform-infra
  PR that labmx reviews. (Team-claim *creation* stays zero-touch auto-commit;
  *quota-override edits* are PRs — the scaffolder does not auto-commit overrides.)
- **Heavy true-VMs (platform PR-gate):** a VM workload is emitted as a **PR**, not
  an auto-commit (the scaffolder opens a PR for `kind: vm` apps/components);
  `tenants/_apps/*` VM claims require platform review via CODEOWNERS. VM design
  itself is deferred to a follow-up (the `tenants/_template/vm/` scaffolding and
  ADR-032 KubeVirt work are the starting point).
- **Reserved-name + CEL guards** (CXP-1) are copied into all three XRDs and mirrored
  in the scaffolder emit actions (defense in depth, unchanged from ADR-031).

---

## 5. Open questions for the user (decide before build)

1. **Ingress model** — confirm centralized app-owned Ingress (A) over Traefik
   same-host merge (B). (Recommendation: A.)
2. **Migration mode for live swami** — zero-downtime orphan-adopt (risky;
   per-provider Crossplane import) vs backup + teardown + re-onboard (safe; brief
   downtime). Confirm computa/meow are disposable (enumerate live
   `kubectl get capstonetenants` — they are **not** in `tenants/_claims/`).
3. **`sourceRepos`** — org wildcard `UA-MIS/*` (recommended) vs explicit list.
4. **DB granularity** — per-app `<teamDb>_<app>_<env>` (recommended). Confirms the
   swami schema-path handling in migration.
5. **Vault app-secret path move** — `…/<env>/<app>/app`. Confirm the copy-forward
   of existing swami secrets.
6. **Three XRDs** vs one discriminated XRD (recommendation: three).
7. **Scaffolder auto-edits the app claim's `components[]`** on new repo (keeps
   zero-touch; serialized commit, not concurrent writer). Confirm acceptable.
8. **labmx GitHub team handle** for the `tenants/_teams/` CODEOWNERS entry.
