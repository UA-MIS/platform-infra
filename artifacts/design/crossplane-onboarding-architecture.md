# Target architecture — Zero-touch tenant onboarding via Crossplane

**Status:** DESIGN for human approval (architecture gate). **Do not build/apply.**
Companion to `artifacts/design/decisions/adr-031-crossplane-zero-touch-onboarding.md`.
Date: 2026-06-27. Repo: `platform-infra`.

> **The bar (decided constraint):** *a human creates a project in Backstage → it just
> works.* Zero human intervention per onboarding — no operator `make` scripts, no
> human-merged onboarding PR. The human gate moves to a **one-time SRE review** of the
> Crossplane Composition + the providers' scoped credentials, not a per-onboarding
> approval.

---

## 1. The problem this replaces

The v1check golden path proved end-to-end but surfaced ~14 onboarding bugs. Almost
none are "deep" bugs — they are all symptoms of the **imperative seam**: `sed`-token
substitution (`tenants/_template/` copied with `__TEAM__`/`__SEMESTER__`/`__PRNUM__`/
`__APPNAME__` replaced), one-time secrets minted by `make` and `kubeseal`'d by hand,
CI copied per-repo, and post-merge operator steps that get forgotten or run with the
wrong flags. Today's flow (`template.yaml`) is *partly* declarative (the tenant
manifests are GitOps'd by `tenants-appset`) but still has three imperative gaps:

1. **`capstone:harbor-onboard`** — a Backstage backend action that calls the Harbor API
   at scaffold time (creates the project). Works, but the Backstage backend now holds a
   Harbor provisioner cred, and robots are still out of scope.
2. **The onboarding PR + post-merge `make harbor-*-robot` / `make vault-onboard`** — the
   robot tokens, the Vault role/policy, and the in-ns `vault-ca` ConfigMap are minted by a
   human operator running `make` with `TARGET=real-talos`. This is the "human merge" and
   the "operator scripts" the new bar forbids.
3. **Per-repo CI** — `.devops/ci/*` + `.github/workflows/build-and-push.yaml` are embedded
   verbatim in every scaffolded repo, so a fix (yq/git/selector/`safe.directory`) must be
   re-shipped to every tenant.

Crossplane converts gaps 1 and 2 into **reconciling, declarative managed resources** so
they "can't be forgotten or drift," and the **reusable workflow** (`workflow_call`) closes
gap 3.

---

## 2. Shape of the solution

```
                       ┌─────────────────────────── platform-infra (git) ───────────────────────────┐
 Backstage             │  tenants/_claims/<team>-<app>.yaml   ← ONE CapstoneTenant XR (the only       │
 "New Capstone         │                                        per-onboarding artifact; ~10 fields)  │
  Project"  ──emits──► │  apis/      XRD + Composition + Functions  (REVIEWED ONCE by SRE)            │
 (no cluster creds)    │  providers/ Provider + ProviderConfig refs (creds in crossplane-system)      │
                       └──────────────┬─────────────────────────────────────────────────────────────┘
                                      │ ArgoCD auto-sync (app-of-apps / git generator)
                                      ▼
              ┌──────────────────── workload cluster (Talos) ────────────────────┐
              │  Crossplane control plane (crossplane-system)                     │
              │   reconciles CapstoneTenant XR ──► Composition pipeline fans out: │
              │                                                                   │
              │   provider-github   → Repository, BranchProtection, TeamRepo,     │
              │                       (RepositoryFile for the CI caller)          │
              │   provider-harbor   → Project, RobotAccount(push + pull/env)      │
              │   provider-vault    → Policy, AuthBackendRole (k8s auth)          │
              │   provider-kubernetes → AppProject, Namespaces (quota/limitrange/ │
              │                       netpol/RBAC/PSA), vault-ca ConfigMap,       │
              │                       ESO SecretStore + ExternalSecrets,          │
              │                       env + preview ApplicationSets               │
              │   ESO PushSecret    → robot token (connection secret) → Vault     │
              └───────────────────────────────────────────────────────────────────┘
```

The **only** per-onboarding artifact is the `CapstoneTenant` custom resource (XR) — a
small, schema-validated, low-privilege object. Everything that used to be `sed`+`make`
is now a reviewed-once Composition expanding that one object.

---

## 3. The XRD (the tenant API)

Crossplane **v2** (`apiextensions.crossplane.io/v2`): XRs are **namespaced** by default and
there is **no separate Claim** — the scaffolder creates the XR directly. (Verified against
current Crossplane v2 docs: `scope: Namespaced`, `Composition.mode: Pipeline`.)

```yaml
# apis/xrd.yaml  (sketch — illustrative, not final)
apiVersion: apiextensions.crossplane.io/v2
kind: CompositeResourceDefinition
metadata:
  name: capstonetenants.platform.capstone.uamishub.com
spec:
  scope: Namespaced                       # v2 default; XR lives in e.g. ns "tenancy"
  group: platform.capstone.uamishub.com
  names:
    kind: CapstoneTenant
    plural: capstonetenants
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [team, appName, semester]
              properties:
                team:       { type: string, pattern: '^[a-z]([-a-z0-9]*[a-z0-9])?$', maxLength: 30 }
                appName:    { type: string, pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$', maxLength: 30 }
                semester:   { type: string, pattern: '^[0-9]{4}-(spring|summer|fall)$' }
                githubTeam: { type: string }     # defaults to team
                port:       { type: integer, default: 8080, minimum: 1, maximum: 65535 }
                previewEnabled: { type: boolean, default: false }
                domain:     { type: string, default: capstone.uamishub.com }
```

The `pattern`/`maxLength` constraints are the **same** DNS-1123 guards the scaffolder form
enforces today — but now they bound the whole blast radius declaratively, so the SEC-001
blanket-`sed` class of bug (malformed RBAC names) is impossible by construction.

---

## 4. The Composition (the reviewed-once expansion)

`mode: Pipeline` with a templating function (recommend **function-kcl** or
**function-go-templating** — both are first-party `crossplane-contrib`, high reputation).
The function reads the one XR spec and renders every downstream managed resource, doing the
substitution that `sed` used to do — but type-checked, reconciling, and drift-correcting.

Pipeline steps:

| Step | Function / provider | Renders |
| --- | --- | --- |
| `render-repo` | provider-github | `Repository` (private, from `capstone-app-template`), `BranchProtectionV3` (PRs into main, code-owner review), `TeamRepository` (team=push, labmx=admin), `RepositoryFile` for the CI caller workflow |
| `render-harbor` | provider-harbor | `Project` (name=team), `RobotAccount` push (pull+push on team), `RobotAccount` pull per env → connection secrets |
| `render-vault` | provider-vault | `Policy` (scoped `secret/data/tenants/<team>/*`), `AuthBackendRole` (k8s auth, bound to the per-tenant ESO SAs) |
| `render-k8s` | provider-kubernetes `Object` | AppProject; dev/staging/prod/preview namespaces with Quota+LimitRange+NetworkPolicy+Role/RoleBinding+PSA; `vault-ca` ConfigMap; ESO `SecretStore` + `ExternalSecret`s; env + preview `ApplicationSet`s |
| `bridge-robot-secret` | ESO `PushSecret` (recommended) | robot connection secret → Vault `tenants/<team>/{harbor-push, <env>/harbor-pull}` |

provider-kubernetes `Object` is the workhorse for the entire tenancy fence — it manages
*arbitrary* k8s objects (AppProject, ApplicationSet, ESO CRs, RBAC, Quota, NetworkPolicy),
supports references/field-path patching between objects, CEL readiness, and management
policies. This is a **confirmed, mature** capability (crossplane-contrib, High reputation,
471 snippets).

---

## 5. The bug → declarative mapping (why each "can't be forgotten/drift")

| # | v1check-era bug (imperative symptom) | Becomes declarative as | Why it can't recur |
| --- | --- | --- | --- |
| 1 | Harbor project missing → first build `UNAUTHORIZED: project not found` (#114 added scaffold-time create) | provider-harbor `Project` MR | Reconciled; if deleted, recreated. Not a one-shot action. |
| 2 | Shared `harbor-push` last-write-wins multi-tenant collision (#91/#95/#117) | per-team `RobotAccount` push MR + ESO PushSecret → per-team Vault path → per-team `harbor-push` | Each team owns its own robot + secret path; no shared single secret to clobber. |
| 3 | `harbor-pull` dual-owner: placeholder SealedSecret in app overlay collided with tenant copy (#123, #0f50b7a) | single owner: ESO `ExternalSecret` materializes pull secret from Vault; app overlay ships none | One writer (ESO). The two-owner race is structurally gone. |
| 4 | `__PRNUM__` token never substituted (#116) | XRD-validated `previewEnabled` + function-rendered preview ApplicationSet | No literal tokens; values are typed fields. |
| 5 | `__APPNAME__` / repo-name mismatch `v1check-app` vs `v1check` (#118) | `appName` is one XRD field; repo, registry, host, namespaces all derive from it in the function | Single source field; cross-references can't diverge. |
| 6 | Tenant AppProject ESO-whitelist gap (ExternalSecret/SecretStore kind not allowed) | AppProject `namespaceResourceWhitelist` rendered by the function from a reviewed list | The whitelist and the ESO objects are rendered together by one reviewed template — they can't drift apart. |
| 7 | Vault role/policy + `vault-ca` ConfigMap never run (`make vault-onboard` manual; #107 gap) | provider-vault `Policy`+`AuthBackendRole` + provider-kubernetes `vault-ca` ConfigMap MRs | Part of the Composition; created with the tenant, reconciled forever. The "never run" failure mode is eliminated. |
| 8 | ArgoCD private-repo creds placeholder (`argocd-repo-creds-uamis`, this branch) | org-wide repo cred is platform infra, not per-tenant; provider-github uses the same App | Onboarding stops depending on a per-tenant cred step. |
| 9 | CI chain copied per-repo (yq/git/selector/`safe.directory`; #91728fa, #a9f6ba6) | reusable workflow `workflow_call` + tiny caller via provider-github `RepositoryFile` | One central workflow; a fix ships once, every tenant gets it. |
| 10 | Harbor onboard Job read-only-rootfs `/tmp` break (#115) | no bespoke Job; provider-harbor reconciles via its own controller | The hand-rolled curl-Job is retired. |
| 11 | Harbor v2.15 removed legacy robot API (#57) | provider-harbor speaks the current unified API (pin provider version) | API drift handled by the provider, version-pinned once. |
| 12 | Image tag 12- vs 7-char gotcha | unchanged at onboarding; CI concern (reusable workflow standardizes the tag) | Centralized in one workflow, not 30 copies. |
| 13 | SEC-001 malformed RBAC names (blanket `sed`) | XRD pattern validation + function rendering | No `sed`; names are derived, schema-validated. |
| 14 | SEC-002 stray files / SEC-006 dangling argocd-rbac project ref | function emits only known kinds; AppProject + RBAC rendered together | No free-text file copy; structurally consistent. |

**Net:** every row moves from "a human (or a one-shot action) must remember to do X with
the right flags" to "X is a field in a reviewed template that reconciles."

---

## 6. Credential & trust boundaries

All privileged credentials live **only** in `crossplane-system` as `ProviderConfig`
secrets — never in Backstage, never with humans, audited via Vault audit + k8s audit.

| ProviderConfig | Credential | Scope (least privilege) | Source today |
| --- | --- | --- | --- |
| provider-github | GitHub App `app_auth` (id `4097147`, install `141394298`, `.pem`) | `repo` + `admin:org` on UA-MIS | `ua-mis-backstage` App already exists (see memory `capstone-github-app-m2`) — reuse it |
| provider-harbor | a **provisioner robot** (project+robot+member admin), NOT harbor-admin | create projects + robots only | derive from `harbor-admin` once, store as ProviderConfig secret |
| provider-vault | a Vault token/role with a `tenant-provisioner` policy | create `policy` + `auth/kubernetes/role` under `tenants/*` only | new Vault policy, reviewed once |
| provider-kubernetes | in-cluster SA + a curated ClusterRole | create/manage AppProject, ns, Quota, LimitRange, NetworkPolicy, Role/RoleBinding, ESO CRs, ApplicationSet — **and nothing else** | new SA in crossplane-system |

> The provider-kubernetes ClusterRole is the **most privileged** surface (it can mint RBAC
> and AppProjects). It is **the** thing the one-time SRE review must scrutinize. It must be
> a hand-curated allow-list of apiGroups/resources/verbs, **not** `cluster-admin`. This
> ClusterRole + the Composition together *are* the reconcile bound.

provider-github auth uses the exact `app_auth` JSON shape this provider documents
(`id`/`installation_id`/`pem_file` with `\n`-escaped key) — confirmed via Context7, and it
matches the App we already hold.

### Why this is a real gate, not a rubber stamp
- The **XR is low-trust**: ~10 string/int/bool fields, every one schema-validated. A fully
  automated Backstage emit cannot escalate, because the *shape of what's possible* is fixed
  by the reviewed XRD + Composition + the scoped ProviderConfigs.
- The **human reviews the powerful thing once** (the Composition + the four scoped creds +
  the provider-kubernetes ClusterRole) instead of rubber-stamping onboarding PRs whose
  security properties a non-SRE reviewer cannot actually evaluate. Trust lives in reviewed
  platform code + Crossplane's reconcile bounds, which is where it belongs.

---

## 7. How the Claim/XR auto-applies with NO human merge

Two candidate emit mechanisms:

**Option A — GitOps-committed XR (RECOMMENDED).** The scaffolder commits the
`CapstoneTenant` XR to `tenants/_claims/<team>-<app>.yaml` on `platform-infra` **directly to
main**, using the platform GitHub App, which is on the branch-protection **bypass list** for
that path (constraint #3 permits this for trusted scaffold automation). ArgoCD (an
app-of-apps or a git-files generator over `tenants/_claims/`) syncs the XR; Crossplane
reconciles. No PR, no human merge.

- **Pros:** git history is the onboarding ledger (audit); de-provisioning is `git rm`
  (matches the existing `platform.capstone/semester` GC model — graduate a cohort = delete
  its claim files); ArgoCD stays the single apply engine; Backstage backend holds **no**
  cluster-write cred (just the App token it already has for repo creation). One declarative
  source of truth.
- **Cons:** App must be on the bypass list (acceptable per constraint #3); one extra
  git→ArgoCD hop of latency (seconds, irrelevant for onboarding).

**Option B — Backstage backend applies the XR directly** with an in-cluster scoped cred
(a custom `capstone:apply-tenant` action, or the k8s apply action).

- **Pros:** no git hop.
- **Cons:** Backstage backend now holds a cluster-write credential (larger attack surface
  on a web-facing service); no git audit trail; de-provisioning needs a second imperative
  path; diverges from the GitOps model the rest of the platform uses.

**Recommendation: Option A.** It is strictly better on audit, de-provisioning symmetry,
and blast-radius (keeps cluster-write creds off Backstage). The only cost is the bypass-list
entry, which the constraints already bless.

---

## 8. CI: reusable workflow (`workflow_call`)

Move `build-and-push.yaml` into `UA-MIS/platform-infra/.github/workflows/build-and-push.yaml`
with `on: workflow_call` (inputs it can't self-derive; it already reads registry/app from
`promotion.yaml` at runtime). Each tenant repo ships only a ~10-line caller:

```yaml
# tenant repo .github/workflows/ci.yaml  (written by provider-github RepositoryFile)
on: [push, pull_request]
jobs:
  build:
    uses: UA-MIS/platform-infra/.github/workflows/tenant-build.yaml@v1
    secrets: inherit
```

- Fixes the per-repo-copy drift (bug #9): yq/git/selector/`safe.directory` fixes ship once
  and every tenant picks them up at the pinned `@v1` (bump deliberately, like a contract
  tag — but ONE tag, not embedded bytes in N repos).
- The caller is static (no `${{ }}`/nunjucks collision), so provider-github `RepositoryFile`
  can write it verbatim — no templating engine needed.
- The self-contained-scaffolder embed work (`artifacts/design/self-contained-scaffolder.md`)
  is **superseded for CI**: instead of embedding the whole CI surface in every repo, the repo
  references it. (The `.devops/chart` overlays + `promotion.yaml` still ship per-repo, since
  they are the student's deployment surface.)

---

## 9. Repo content seeding — the provider-github gap (hybrid recommendation)

provider-github can **create** the repo and bootstrap it from a **template repo**
(`spec.forProvider.template`), and can write **literal** files via `RepositoryFile` — but it
**cannot render per-team token substitution into file contents** the way Backstage
`fetch:template` (nunjucks) does. The per-team files a repo needs are small:
`promotion.yaml` (registry/app), `app-metadata.yaml` (4 fields), `catalog-info.yaml`.

Two paths:
- **9a (RECOMMENDED for v1) — hybrid.** Keep Backstage `fetch:template` for **repo content**
  (it is genuinely good at templating the starter app + the 3 small per-team files), and use
  Crossplane for **all platform provisioning** (Harbor/Vault/k8s/AppProject/ApplicationSets)
  — which is where 13 of the 14 bugs lived. The scaffolder's last step becomes "emit the XR"
  instead of "render-tenant + onboarding-PR + post-merge make steps." Smallest change,
  captures the whole win.
- **9b (later) — full Crossplane.** `capstone-app-template` repo + provider-github
  `RepositoryFile` MRs whose contents are rendered by the Composition function. Pushes repo
  creation into the same reconciling plane, at the cost of re-implementing the templating in
  KCL/Go-templates. Defer until 9a is proven.

This is the one place the "everything declarative via Crossplane" ideal meets a provider
limitation; the hybrid sidesteps it without losing the onboarding-reliability win.

---

## 10. The Harbor robot secret — the load-bearing open problem

This is the single hardest piece and the **#1 provider-coverage risk**.

- **Context7 does not index a Crossplane `provider-harbor`.** A community provider exists,
  but its maturity and — critically — its handling of the **robot token** (a *one-time,
  Harbor-generated* credential) are unconfirmed. A managed resource reconciles *desired
  state*; a generated secret is not desired state, it is an *output* that must be captured
  exactly once and propagated.
- **Primary design (if provider-harbor `RobotAccount` writes a connection secret):**
  `RobotAccount` → `writeConnectionSecretToRef` (k8s Secret in crossplane-system) → ESO
  **`PushSecret`** writes the token into Vault `tenants/<team>/{harbor-push,<env>/harbor-pull}`
  → the tenant's existing ESO `ExternalSecret`s materialize `dockerconfigjson` into the
  runner ns (push) and tenant ns (pull). This unifies everything on the **ESO+Vault** plane
  the platform already chose (ADR-030), and **retires SealedSecrets for robots** — removing
  the `kubeseal`/`TARGET`/empty-seal-guard class of bugs entirely.
- **Fallback (if provider-harbor lacks robot/secret support):** a tiny purpose-built
  reconciling controller, OR a Crossplane-managed mint Job (provider-kubernetes `Object`
  creating the proven curl-Job) that writes the token **directly to Vault** instead of
  stdout→kubeseal. Less elegant, still declarative-enough and zero-touch.

**A focused spike on provider-harbor robot+secret coverage must run before committing to the
primary path.** This is the gating unknown.

---

## 11. Phased migration plan

| Phase | Work | Exit criterion |
| --- | --- | --- |
| **0 — Spike & review** | Install Crossplane v2 + the four providers in non-prod; build ProviderConfigs; **spike provider-harbor robot+secret** (§10); SRE reviews the draft Composition + the provider-kubernetes ClusterRole | Harbor robot path decided (primary vs fallback); SRE sign-off on the cred boundary |
| **1 — Author & test** | Write XRD + Composition + function; create a throwaway tenant by hand-applying one XR; verify the full fan-out reconciles green | A hand-applied XR stands up a working tenant end-to-end |
| **2 — Backstage cutover** | Scaffolder's platform steps replaced by "emit XR to `tenants/_claims/`" (Option A); keep `fetch:template` for repo content (9a) | A Backstage "New Capstone Project" produces a working app with **zero** human steps after submit |
| **3 — CI cutover** | Central reusable workflow `@v1`; skeleton ships the caller; provider-github `RepositoryFile` writes it | New tenants build via the reusable workflow; a CI fix ships once |
| **4 — Existing tenants** | `v1check`/`sample` stay as the **frozen manual reference** (do not migrate — they are the proof + the rollback path). Live cohort tenants: either leave until cohort GC, or **adopt** into Crossplane via observe/import MRs | Decision logged per tenant; no live disruption |

Recommendation: **do not migrate `v1check`/`sample`.** They are the proven manual baseline
and the rollback story; let them age out with their cohort. New tenants use the Crossplane
path from Phase 2.

---

## 12. Open sub-decisions for the human

1. **Harbor robot secret path (§10)** — gated on a spike. Primary (provider-harbor +
   ESO PushSecret → Vault) vs fallback (mint-Job → Vault). *Highest-risk decision.*
2. **XR emit mechanism (§7)** — GitOps-commit (recommended) vs Backstage-direct-apply.
3. **Repo content seeding (§9)** — hybrid keep-Backstage-templating (recommended for v1) vs
   full Crossplane `RepositoryFile`.
4. **Provider maturity acceptance** — provider-vault is `v0.1.0`; provider-harbor is
   community/unindexed. Accept and pin, or vendor/fork.
5. **Crossplane control-plane location** — co-resident on the Talos workload cluster
   (recommended for v1; provider-kubernetes uses the in-cluster SA) vs a separate management
   cluster (cleaner blast-radius, more infra).
6. **provider-kubernetes ClusterRole scope** — the exact allow-list of kinds it may mint
   (this is the core of the reviewed boundary; must be curated, never `cluster-admin`).
