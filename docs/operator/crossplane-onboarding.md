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

> ✅ **This stack is LIVE (verified 2026-07-04).** `crossplane-system` runs Crossplane
> **v2.3.2** with all providers installed (harbor v0.1.1, github v0.19.1, kubernetes
> v0.18.0, sql v0.15.0, vault v0.1.0), the `CapstoneTenant` XRD + Composition are
> established, and real claims in [`tenants/_claims/`](../../tenants/_claims/) have
> provisioned tenants (e.g. `swami`). The Phase-0 SRE review + cred reseal below is
> **historical** — keep it as the rebuild-from-scratch procedure. (Original state:
> before Phase-0 the providers sat unauthenticated / not reconciling — the safe failure
> mode. The Phase-0 keyboard sequence is also in [Runbooks → (B)](runbooks.md).)

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
| `harbor-provider-creds` | a Harbor **provisioner robot** — project + robot + member admin, **plus `repository:push/pull/read/list`, `artifact:read/list`, `artifact-addition:read`** (derive from harbor-admin; do **not** use harbor-admin itself). ⚠ The repository/artifact grants are load-bearing: Harbor refuses to let a robot mint a child robot with wider permissions than itself, and the per-team CI push/pull robots this Composition mints need exactly those actions — omitting them 403s every `RobotAccount` create with "permission scope is invalid" and silently breaks tenant onboarding (2026-07-11 incident; full root cause + exact grant JSON + reseal runbook in `creds/README.md` § Harbor CI-push robot-minting scope) |
| `vault-provider-creds` | a Vault token with the `tenant-provisioner` policy (write `sys/policies/acl/tenant-*` + `auth/kubernetes/role/tenant-*`, plus `auth/token/create` for provider-vault's per-call child token) |

Reseal pattern (from `creds/README.md`, fish-safe — build the JSON in a file, no
heredoc in the outer shell):

```bash
# example: GitHub App creds (repeat per secret with its scoped value)
kubectl create secret generic github-provider-creds \
  --namespace crossplane-system --from-file=credentials=/tmp/gh.json \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
    --format yaml > platform-services/crossplane/creds/github-app-creds-sealed.yaml
rm -f /tmp/gh.json
```

### 3. Create the Vault roles (the provisioner + the writer)

The Composition needs two Vault identities beyond the per-tenant read role:

- **`tenant-provisioner`** (provider-vault) — manages tenant policy + k8s roles,
  plus `auth/token/create` so the provider can mint its own per-call child token.
  Scope (HCL) is in `creds/README.md`.
- **`crossplane-push`** (the writer) — `create`,`read`,`update` on both
  `secret/data/tenants/*` and `secret/metadata/tenants/*` (ESO's Vault PushSecret
  provider requires `read` too — it does a read-modify-write against KV v2 before
  every push). Committed for review and run as the script below; it backs the
  `crossplane-system` SecretStore `vault-push`
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

## Tenant teardown & recovery

De-provisioning is the mirror of onboarding: **remove the claim file, ArgoCD prunes
the XR, Crossplane tears the tenant down.** Operators should never `kubectl delete`
a tenant directly — drive it from git, exactly like onboarding.

### 1. Normal path (git-driven, zero-touch)

```bash
git rm tenants/_claims/<team>-<app>.yaml   # e.g. via the Backstage teardown page
# commit → main (the portal/GitHub App path)
```

`platform-crossplane-claims` (directory-sync of `tenants/_claims`, `automated:
{prune, selfHeal}`) removes the now-orphaned `CapstoneTenant` XR; Crossplane +
the team AppProject finalizers deprovision the tenant (repo, Harbor, Vault, the k8s
tenancy fence). Graduating a whole cohort = `git rm` all of that semester's claims.

> **Why `allowEmpty: true` is set on this app** (see
> `applicationsets/crossplane-claims-app.yaml`): when the **last** remaining claim
> file is removed, `tenants/_claims` renders to **zero** applied resources. ArgoCD's
> default `allowEmpty: false` safety guard then **refuses** the sync — logging
> `Skipping sync attempt … auto-sync will wipe out all resources` — so the orphaned
> XR is never pruned and teardown silently no-ops (verified live 2026-07-10:
> `meow-meow` + `computa-computa` claims stuck alive 9–13 h after their files were
> `git rm`'d). We flip `allowEmpty: true` **only on this claims app** because the
> safety it removes is **redundant here**: branch protection on `main` (1 required
> approving review, no force-push, no branch deletion — confirmed live) already
> prevents an unreviewed commit from mass-deleting claims; a wipe-to-empty must go
> through a reviewed PR. (The `ua-mis-platform-ci` GitHub App is on the
> branch-protection bypass list — it is the trusted onboarding/teardown automation,
> not an unreviewed human contributor.) This makes single-/last-tenant teardown
> reliable **and** kubectl-free.

### 2. If a claim sticks in `Terminating` (wedged composition)

A `CapstoneTenant` can wedge `Ready=False` with a `WatchCircuitOpen` hot-loop on its
`xp-<team>-<env>-secretstore` object; deleting such a claim then **hangs in
`Terminating`** on a stuck managed-resource finalizer (the 2026-07-10 apply-fight /
prune-hang class). Recover with the incident-runbook discipline — **orphan before
prune**, one tenant at a time:

1. **Pause the churn** first (stop ArgoCD re-syncing the claims app / stop the
   Composition re-rendering into the fight) so you are not racing the controller.
2. **Identify the stuck managed resource(s)** — the object(s) still holding a
   finalizer under the terminating XR (start with the `xp-<team>-<env>-secretstore`
   and any MR whose `Synced/Ready` is False):

   ```bash
   kubectl get managed | grep <team>          # find the wedged MRs
   kubectl get <mr-kind> <name> -o yaml | grep -A3 finalizers
   ```

3. **Orphan-before-prune** so the MR drains instead of blocking: set the deletion
   policy to `Orphan` (`kubectl patch <mr-kind> <name> --type merge -p
   '{"spec":{"deletionPolicy":"Orphan"}}'`) and/or remove the stuck finalizer
   (`kubectl patch <mr-kind> <name> --type merge -p '{"metadata":{"finalizers":[]}}'`).
   The XR then finishes terminating.
4. **Remove the claim** (if not already `git rm`'d) and let the prune complete.
5. **Unpause** and confirm the tenant's namespaces / appsets are gone.

**Never delete multiple wedged claims simultaneously.** Do them **one at a time**,
watching **cilium-agent and kube-apiserver CPU** between each — the 2026-07-10
incident was a duplicate-claim apply-fight that pinned cilium and saturated a node
(`mac-debian-01`, a worker since retired) until vault raft snapshots stalled.
Serialize and watch.

### 3. "ArgoCD app shows Suspended" is (usually) not a teardown signal

An ArgoCD Application reporting **Suspended** during teardown is almost always just a
**paused canary Rollout** (Argo Rollouts pauses at a step), **not** a stuck teardown.
Confirm with `kubectl argo rollouts get rollout <name> -n <ns>` before acting — do
**not** start yanking finalizers because a health status reads Suspended.

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
