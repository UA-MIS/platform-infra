# Crossplane zero-touch onboarding

Crossplane turns tenant onboarding into **data**: a Backstage scaffold commits one
`CapstoneTenant` resource to `tenants/_claims/<team>-<app>.yaml` on `main`, and a
reviewed-once Composition expands it into the entire tenant — GitHub repo, Harbor
project + robots, Vault policy/role, the k8s tenancy fence, ESO plumbing, and the
per-team ARC CI stack. **Zero human steps after submit.**

- Design: ADR-031
  (`artifacts/design/decisions/adr-031-crossplane-zero-touch-onboarding.md`,
  APPROVED) + `artifacts/design/crossplane-onboarding-architecture.md`.
- Source of truth: `platform-services/crossplane/README.md` and
  `platform-services/crossplane/creds/README.md`.

> ⚠ **This stack is NOT live yet.** It is **branch + PR only** until the one-time
> SRE review + the gated **Phase-0** below. Until the provider creds are resealed
> with real values, the providers sit **unauthenticated (not reconciling)** — the
> safe failure mode. The Phase-0 keyboard sequence is also in
> [Runbooks → (B)](runbooks.md).

---

## What it replaces

The retro found that **copy-not-reference** generated ~14 onboarding bugs (project
missing, robot collisions, `__PRNUM__` never substituted, appName/repo mismatch,
ESO whitelist gaps, RBAC name bugs…). Crossplane makes each one a reconciling
resource that "can't recur" — the full bug→resource mapping is the table in
`platform-services/crossplane/README.md`.

The human gate **moves** from a per-onboarding rubber-stamp to a **one-time SRE
review** of this directory.

---

## The XRD + Composition

- **`apis/xrd.yaml`** — the `CapstoneTenant` CompositeResourceDefinition. Spec
  fields: `team`, `appName`, `semester` (required), plus `githubTeam`, `port`,
  `previewEnabled`, `baseDomain`. CEL + `pattern` validation reject reserved names
  (`team: platform/argocd/default/kube-system…`, `appName:
  platform-infra/.github…`) — these can't be used as tenant slugs (they'd clobber
  privileged platform RBAC). This is the SEC-001/SEC-013 fix: validation, **no
  blanket `sed`**.
- **`apis/composition.yaml`** — the reviewed-once expansion (47 composed
  resources). Repo, registry, host, namespace all derive from one `appName` field
  (kills the v1check appName/repo mismatch). **SRE focus #2.**
- **`rbac/provider-kubernetes-rbac.yaml`** — the hand-curated ClusterRole the
  provider-kubernetes reconcile is bound to (never `cluster-admin`). With the
  Composition, **this IS the blast radius. SRE focus #1.**

Provisioning is **component-agnostic** (multi-component / N images per repo): the
Harbor project + project-level robots and the per-namespace tenancy fence span all
`<appName>-<comp>` repos; the XRD does not model components.

---

## The providers + install order

Four providers (github, harbor, vault, kubernetes) + 2 functions, pulled from
`xpkg.upbound.io` by the Crossplane package manager (not an ArgoCD source). Only
the Crossplane **core Helm chart** repo (`https://charts.crossplane.io/stable`) is
in the `platform` AppProject `sourceRepos` — install-owned (re-apply via
`make bootstrap-reapply`, verify, or `platform-crossplane-core` errors
"repo not permitted").

| Sync wave | Application | Installs |
| --- | --- | --- |
| -1 | `platform-crossplane-core` | Crossplane v2 control plane (chart 2.3.2) |
| 0 | `platform-crossplane-runtime` | 4 Providers + 2 Functions + ProviderConfigs + RBAC + creds |
| 1 | `platform-crossplane-apis` | `capstone-tenants` ns + XRD + Composition |
| 2 | `platform-crossplane-claims` | the committed `CapstoneTenant` XRs |

provider-kubernetes uses in-cluster `InjectedIdentity` (no secret). The other three
providers' admin creds are the **only privileged credentials in the whole stack**,
living only in `crossplane-system`.

---

## The gated Phase-0 (one-time, the human keyboard)

Order matters. **Do these before syncing the claims app.**

### 1. SRE review

Scrutinize, on `origin/main` (never a stale worktree):

- `rbac/provider-kubernetes-rbac.yaml` — the ClusterRole (the blast radius).
- `apis/composition.yaml` — what gets minted.
- `creds/` — the placeholder creds and the **scopes** to grant (next step).

### 2. Reseal the 4 provider creds **non-admin** (`creds/README.md`)

The committed ciphertext is a **placeholder** (won't decrypt). Reseal each with the
real **least-privilege** credential against the live sealed-secrets controller:

| Secret (crossplane-system) | Scope to grant — NOT admin |
| --- | --- |
| `github-provider-creds` | the existing `ua-mis-backstage` GitHub App (App ID 4097147, install 141394298) |
| `harbor-provider-creds` | a Harbor **provisioner robot** — project + robot + member admin ONLY (derive from harbor-admin; do **not** use harbor-admin itself) |
| `vault-provider-creds` | a Vault token with the `tenant-provisioner` policy (write `sys/policies/acl/tenant-*` + `auth/kubernetes/role/tenant-*` ONLY) |

Reseal pattern (from `creds/README.md`, fish-safe — build the JSON in a file, no
heredoc in the outer shell):

```bash
# example: GitHub App creds (repeat per secret with its scoped value)
kubectl create secret generic github-provider-creds \
  --namespace crossplane-system --from-file=credentials=/tmp/gh.json \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace sealed-secrets --controller-name sealed-secrets \
    --format yaml > platform-services/crossplane/creds/github-app-creds-sealed.yaml
rm -f /tmp/gh.json
```

### 3. Create the Vault roles (the provisioner + the writer)

The Composition needs two Vault identities beyond the per-tenant read role:

- **`tenant-provisioner`** (provider-vault) — manages tenant policy + k8s roles
  only. Scope (HCL) is in `creds/README.md`.
- **`crossplane-push`** (the writer) — WRITE (`create`,`update`) on
  `secret/data/tenants/*` **only**, no read. Committed for review and run as the
  script below; it backs the `crossplane-system` SecretStore `vault-push`
  (`config/vault-push-secretstore.yaml`, SA `eso-vault-push`):

```bash
# run inside vault-0, logged in as root — PIPE THE FILE (fish has no heredoc):
kubectl -n vault exec -i vault-0 -- sh \
  < platform-services/external-secrets/vault-policies/crossplane-push-role.sh
```

### 4. SRE-read, then apply runtime/apis, then the claims

```bash
make bootstrap-reapply KUBE_CONTEXT=admin@capstone     # adds the crossplane chart repo; VERIFY it took
argocd app sync platform-crossplane-core               # wave -1
argocd app sync platform-crossplane-runtime            # wave 0 (providers come up + authenticate)
argocd app sync platform-crossplane-apis               # wave 1 (XRD + Composition)
```

### 5. Validate ONE XR before opening the gate (ADR-031 §11)

Cluster-side, before letting the claims flow. Hand-apply one `CapstoneTenant`,
confirm the full fan-out reconciles green, and run the render/validate (agents
can't — these are cluster-side):

```bash
crossplane render <xr.yaml> apis/composition.yaml <functions.yaml>
crossplane beta validate ...     # against the installed provider CRDs
```

Confirm the provider MR apiVersions/fields flagged `⚠ Verify` in the Composition
(provider-harbor v0.1.1, provider-vault v0.1.0 are early-version — pinned).

Only then sync `platform-crossplane-claims` and let Backstage scaffolds flow.

---

## The cutover (drop the app-overlay SecretStore)

Track-4 (ESO per-team push) currently OWNS the consumer ExternalSecrets and the
app-overlay SecretStore. Crossplane is the **producer** — it mints robots and
PushSecrets into Vault at track-4's committed paths
(`tenants/<team>/ci/harbor-push`, `tenants/<team>/<env>/harbor-pull`). The
Composition does **not** render the app-overlay consumer ExternalSecrets, so there
is a single owner per object (no new dual-owner race).

`platform-services/backstage/templates/new-capstone-project/CROSSPLANE-CUTOVER.md`
documents the template-side cutover: once Crossplane is proven, the scaffolder stops
emitting the per-tenant SecretStore in the app overlay (Crossplane now provisions
it), removing the duplicate-owner path. Do this **after** Phase-0 is green and one
real tenant has been onboarded zero-touch end-to-end.

---

## Robot-secret reconcile stability (why no churn)

The Composition lets **Harbor generate** the robot token and captures it from the
connection secret (variant 2). The Harbor API does not return the secret on read,
so the value persists in provider state — **no regen on steady-state reconcile**.
Treat robot `permissions`/`name` as **immutable post-onboarding** (greenfield only,
no import) — those are the only changes that force a token replacement.
