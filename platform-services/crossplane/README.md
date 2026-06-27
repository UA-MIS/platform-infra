# Crossplane zero-touch tenant onboarding (ADR-031)

Turns tenant onboarding into **data**: a Backstage scaffold commits **one
`CapstoneTenant` XR** to `tenants/_claims/<team>-<app>.yaml` on `main`; a
**reviewed-once Composition** expands it into the entire tenant (repo + Harbor +
Vault + the k8s tenancy fence). **Zero human steps after submit** — no onboarding
PR, no operator `make` scripts. The human gate moves to a **one-time SRE review** of
this directory (the Composition + the four scoped provider creds + the curated
provider-kubernetes ClusterRole), not a per-onboarding rubber-stamp.

> **Design:** `artifacts/design/decisions/adr-031-crossplane-zero-touch-onboarding.md`
> + `artifacts/design/crossplane-onboarding-architecture.md` (both APPROVED).
> **Spike result:** the provider-harbor PRIMARY path is viable (RobotAccount token →
> connection secret → ESO PushSecret → Vault); the mint-Job fallback is NOT needed.

## ⚠ DO NOT APPLY without the one-time SRE review

This stack installs a control plane that can mint repos, Harbor projects/robots,
Vault policy, and in-cluster RBAC. It is **branch + PR only**. The two files the SRE
must scrutinize:

1. **`rbac/provider-kubernetes-rbac.yaml`** — the hand-curated ClusterRole (the
   reconcile bound; never `cluster-admin`). With the Composition, this IS the blast radius.
2. **`apis/composition.yaml`** — the reviewed-once expansion (what gets minted).

And the **placeholder** provider creds in **`creds/`** (SECURITY-flagged; reseal the
real scoped values at go-live — `creds/README.md`).

## Layout

```
platform-services/crossplane/
  providers/   Provider + Function packages (4 providers, 2 functions) + the
               provider-kubernetes DeploymentRuntimeConfig (fixed SA name)
  config/      4 ProviderConfigs + the vault-push writer SecretStore
  rbac/        the curated provider-kubernetes ClusterRole + binding  ← SRE focus
  creds/       placeholder SealedSecret stubs (reseal at go-live)     ← SRE focus
  apis/        namespace + CapstoneTenant XRD + the Composition       ← SRE focus
tenants/_claims/   the committed XRs (the onboarding ledger)
applicationsets/   crossplane-{core,runtime,apis,claims}-app.yaml (ArgoCD install)
```

## Install order (ArgoCD sync-waves; all under the `platform` AppProject)

| Wave | Application | Installs |
| --- | --- | --- |
| -1 | `platform-crossplane-core` | Crossplane v2 control plane (Helm `crossplane` 2.3.2) |
| 0 | `platform-crossplane-runtime` | the 4 Providers + 2 Functions + ProviderConfigs + RBAC + creds |
| 1 | `platform-crossplane-apis` | `capstone-tenants` ns + the XRD + the Composition |
| 2 | `platform-crossplane-claims` | the committed `CapstoneTenant` XRs |

The Crossplane Helm chart repo is added to the `platform` AppProject `sourceRepos`
(`bootstrap/platform-appproject.yaml`) — ⚠ INSTALL-OWNED: re-apply via `make
bootstrap-reapply` after merge or `platform-crossplane-core` errors "repo not
permitted". Provider/Function packages are pulled from `xpkg.upbound.io` by the
Crossplane package manager (not an ArgoCD source).

## The bug → declarative mapping (why each onboarding bug "can't recur")

Each v1check-era onboarding bug becomes a reconciling resource rendered by the
Composition. The "Where" column points at the resource in `apis/composition.yaml`.

| # | v1check-era bug | Now declarative as | Where |
| --- | --- | --- | --- |
| 1 | Harbor project missing → `project not found` | provider-harbor `Project` MR | `harbor-project` |
| 2 | Shared `harbor-push` last-write-wins collision | per-team push `RobotAccount` → PushSecret → per-team Vault path → per-team `gha-runner-scale-set` + hook ConfigMap + `harbor-push-<team>` ExternalSecret | `harbor-robot-push`, `push-harbor-push`, `arc-scaleset`, `arc-hook-cm`, `arc-pushsecret-es` |
| 3 | `harbor-pull` dual-owner race | single owner: track-4 app-overlay ExternalSecret reads Vault; Composition only PRODUCES the data | `push-harbor-pull` (consumer NOT rendered here — by design) |
| 4 | `__PRNUM__` never substituted | typed `previewEnabled` + rendered preview ApplicationSet | `k8s-appset-preview` |
| 5 | `appName`/repo-name mismatch (`v1check-app` vs `v1check`) | repo/registry/host/ns all derive from one `appName` field | `github-repo` + everywhere `$app` |
| 6 | Tenant AppProject ESO-whitelist gap | AppProject `namespaceResourceWhitelist` rendered WITH the ESO objects | `k8s-appproject` |
| 7 | Vault role/policy + `vault-ca` never run (`make vault-onboard`) | provider-vault `Policy`+`AuthBackendRole` + `vault-ca` ConfigMap MRs | `vault-policy`, `vault-k8s-role`, `k8s-vault-ca-*` |
| 8 | ArgoCD private-repo creds per-tenant step | org-wide cred is platform infra; provider reuses the same App | provider-github ProviderConfig |
| 9 | CI chain copied per-repo | reusable workflow `@v1` (track-1) + a tiny `RepositoryFile` caller | `github-ci-caller` |
| 10 | Harbor onboard Job read-only `/tmp` break | no Job — provider-harbor reconciles via its controller | (Job retired) |
| 11 | Harbor v2.15 removed legacy robot API | provider speaks the unified API, version-pinned once | `providers/provider-harbor.yaml` |
| 12 | Image tag 12- vs 7-char gotcha | centralized in the one reusable workflow (track-1) | (CI) |
| 13 | SEC-001 malformed RBAC names (blanket `sed`) | XRD `pattern` validation + function rendering (no `sed`) | `apis/xrd.yaml` |
| 14 | SEC-002 stray files / SEC-006 dangling refs | function emits only known kinds; AppProject+RBAC rendered together | whole Composition |

## Provision-before-deploy (reliability-first)

Mirrors the user's checks→plan→apply→**deploy** model: nothing deploys into
half-provisioned infra. The env + preview ApplicationSet Objects (which generate the
workload Applications) carry provider-kubernetes `references[].dependsOn` on the tenant
fence + secret plumbing — the AppProject, the per-env namespaces, the per-env
SecretStores, and the Harbor-robot→Vault PushSecrets. provider-kubernetes blocks
applying the ApplicationSet until those Objects exist, so no workload App is generated
until the project/namespaces/secret-store/pull-cred are in place (no `ImagePullBackOff`
flap, no "project not found" race). Key Objects also set `readiness.policy:
DeriveFromObject`, so the XR's overall Ready (via function-auto-ready) reflects real
provisioning — the signal a consumer can gate on. ArgoCD's own retry/self-heal covers
residual readiness after creation.

## Multi-component (N images per repo) — provisioning is component-agnostic

A repo may ship N deployable components (e.g. frontend+backend; track-6 `multicomp`
owns the repo-content chart). This per-tenant provisioning is **component-agnostic by
design** — the XRD does **not** model components:
- Harbor **project + project-level push/pull robots** cover all `<appName>-<comp>`
  repos under `<team>/` (project scope already spans N images).
- The tenancy fence (namespaces, quota, netpol, RBAC, ESO) is per-namespace, not
  per-image.
- The preview ApplicationSet does **not** hardcode a single-image kustomize override
  (that would assume one image); per-PR image tags for N components are set by the
  overlay+CI (multicomp/track-1 contract). Single-component stays correct.

## Robot-secret reconcile-stability — variant 2 LOCKED

The spike found two ways to get the Harbor robot token to Vault. We locked
**variant 2 (let Harbor generate it, capture from the connection secret)** on the
reliability-first criterion (no reconcile churn):

- **Variant 2 is stable across reconciles.** The Harbor API does not return the
  robot secret on read, so Upjet/Terraform keep the value in state — Computed-once,
  persists, **no regen on steady-state reconcile**. Regen happens only on
  REPLACEMENT-forcing changes (editing `permissions` (goharbor TF #140), a prefix
  plus-sign (#479), or import (#447)) — none of which are reconciles. Mitigation:
  treat the robot `permissions`/`name` as immutable post-onboarding; greenfield only
  (no import).
- **Variant 1 (supply the secret) was rejected.** In a stateless go-template
  Composition a supplied value would be regenerated every render (sprig
  `randAlphaNum`) → churns every reconcile; and supplying the plain `secret` risks a
  perpetual update-diff (why the TF provider added write-only `secret_wo` +
  `secret_wo_version`, unconfirmed in v0.1.1). It trades a rare, controllable
  replacement event for a potential per-reconcile churn — worse on the criterion.
- **Lesson:** "deterministic" ≠ "stable" under stateless rendering. ⚠ Phase-0:
  confirm the captured secret shows no reconcile-diff; revisit only if variant-2
  permission-change churn ever bites AND `secret_wo` is available.

## Coordination with sibling tracks

- **track-1** (`feat/reusable-tenant-ci-workflow`): the `github-ci-caller`
  RepositoryFile calls `UA-MIS/platform-infra/.github/workflows/build-and-push.yaml@v1`.
- **track-4** (`feat/eso-perteam-push`): track-4 OWNS the consumer ExternalSecrets
  (app overlay) and the Vault paths; track-5 (this) is the PRODUCER it delegated to —
  it mints the robots and PushSecrets their creds into Vault at track-4's committed
  paths (`tenants/<team>/ci/harbor-push`, `tenants/<team>/<env>/harbor-pull`, KV
  fields `name`+`secret`). The Composition does NOT render the app-overlay consumer
  ExternalSecrets → single owner per object (no new dual-owner race).
  - **ARC per-team CI push (PR #128 A1).** The Composition also emits the per-team
    ARC stack — rendered from `platform-services/arc/per-team/*.template.yaml`: a
    `gha-runner-scale-set` Application (`releaseName: <team>-kaniko` = the `runs-on`
    label), its container-hook ConfigMap (`arc-hook-template-<team>`), and the
    `harbor-push-<team>` **ExternalSecret** that materializes the dockerconfigjson
    from Vault `tenants/<team>/ci/harbor-push` (the zero-touch replacement for
    `make harbor-push-robot` + seal). This retires the shared-`harbor-push`
    last-write-wins hole declaratively. Shared bits (`arc-github-app` via ESO from
    `platform/arc/github-app`, `platform-ca`, the runner netpol) stay
    finish-eso/operator-owned in `arc-runners`. The provider-kubernetes ClusterRole
    gained `applications` (the scale-set is an ArgoCD Application).

## Operator go-live steps (one-time, the human keyboard)

1. SRE review of `rbac/` + `apis/composition.yaml` + `creds/` scopes.
2. Reseal the real provider creds (`creds/README.md`).
3. Create the Vault `tenant-provisioner` + `crossplane-push` policies/roles
   (`creds/README.md` + `config/vault-push-secretstore.yaml`).
4. `make bootstrap-reapply` (adds the Crossplane chart repo to the AppProject) + VERIFY.
5. Phase-0/1 (ADR-031 §11): hand-apply ONE XR; confirm the full fan-out reconciles
   green; run `crossplane render` / `crossplane beta validate` against the pinned
   function + provider CRDs (the cluster-side test agents can't run — see below).

## Validation done in this PR (offline) vs. required at apply

- **Done (offline):** every manifest is valid YAML (`yq`); the Composition's inline
  go-template **renders** against a sample XR and every rendered document is valid
  YAML, with 47 composed resources, **no duplicate** composition-resource-names,
  correct per-env quota tiers, the preview ApplicationSet gated on `previewEnabled`,
  the ESO whitelist present, and the PushSecret paths matching track-4's contract.
- **Required at apply (cluster-side, Phase-0):** `crossplane render` with the real
  functions + `crossplane beta validate` against the installed provider CRDs; confirm
  the provider MR apiVersions/fields flagged `⚠ Verify` in the Composition
  (provider-harbor v0.1.1, provider-vault v0.1.0 are early — pinned, verify groups).
