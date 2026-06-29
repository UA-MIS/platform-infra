# Tenant on/off switch

Reversibly **pause** a tenant — stop everything it runs and make it disappear from
`k9s` — then **bring it back**, without touching git, the repo, Harbor, Vault, or
GitHub. It is purely imperative `kubectl` against the live ArgoCD objects.

```bash
# DRY-RUN by default: prints the exact plan, changes nothing.
make tenant-off TEAM=sample
make tenant-on  TEAM=sample

# Act for real:
make tenant-off TEAM=sample DRY_RUN=false
make tenant-on  TEAM=sample DRY_RUN=false

# Real Talos cluster:
make tenant-off TEAM=sample DRY_RUN=false \
  KUBE_CONTEXT=admin@capstone KUBECONFIG=clusters/real-talos/talos-kubeconfig
```

Implementation: [`hack/tenant-onoff.sh`](../../hack/tenant-onoff.sh). The Makefile
targets are thin wrappers.

| Var | Default | Meaning |
|-----|---------|---------|
| `TEAM` | _(required)_ | Team slug, e.g. `sample` (the dir is `tenants/team-sample`). |
| `DRY_RUN` | `true` | Print the plan only. Set `false` to act. |
| `FORCE` | `false` | `tenant-off` only — allow deleting namespaces that contain a **PVC**. |
| `KUBE_CONTEXT` | `k3d-<cluster>` | Cluster to act on. Use `admin@capstone` for Talos. |
| `ARGOCD_NS` | `argocd` | Namespace ArgoCD runs in. |

---

## Why it is more than `kubectl delete ns`

The platform is app-of-apps. If you only delete a namespace, ArgoCD's self-heal
recreates it within seconds. The owners, from the leaf up:

```
root (Application, selfHeal)          → manages applicationsets/ incl. the SHARED
                                        `tenants` ApplicationSet
  tenants (ApplicationSet)            → generates the per-team BOOTSTRAP app
                                        `tenant-team-<team>`
    tenant-team-<team> (App, selfHeal)→ owns the team AppProject + namespaces +
                                        the `<team>-envs` / `<team>-preview` appsets
      <team>-envs / <team>-preview    → generate `<team>-dev|-staging|-prod` and
        (ApplicationSet)                `<team>-pr-<n>`
          <team>-<env> (Application)  → owns the workloads in the namespace
```

A durable OFF must stop **each** owner from re-asserting, top-down, but **scoped to
one team** so other tenants keep reconciling normally.

## OFF — exact step sequence

The PVC guard runs **first**, so an abort happens before any change.

0. **PVC guard.** Scan every target namespace for PVCs. If any exist and
   `FORCE != true`, **abort before mutating anything** (see the caveat below).
1. **`root.spec.ignoreDifferences`** `+=` a tightly-scoped entry telling `root` to
   ignore only `tenants.spec.ignoreApplicationDifferences`. `root` is the top of
   the app-of-apps (nothing reconciles its own spec), so this is the durability
   anchor — without it, `root`'s self-heal would wipe step 2 within ~3 min.
2. **`tenants.spec.ignoreApplicationDifferences`** `+=` a **name-scoped** entry for
   `tenant-team-<team>` (ignore `/spec/syncPolicy` + `/metadata/annotations`), so
   the shared `tenants` appset stops reverting our edits to **this** team's
   bootstrap app only. Other teams are untouched.
3. **Bootstrap app `tenant-team-<team>`:** add `argocd.argoproj.io/skip-reconcile:
   "true"` + set `spec.syncPolicy.automated: null`. The application controller now
   ignores it → it will not recreate the namespaces.
4. **Team appsets `<team>-envs` / `<team>-preview`:** add `skip-reconcile` +
   `ignoreApplicationDifferences`. Durable because their owner (the bootstrap app)
   is now neutralized; also stops the preview appset minting new `pr` apps.
5. **Env/preview apps `<team>-dev|-staging|-prod`, `<team>-pr-*`:** add
   `skip-reconcile` + `automated: null` on each (selected by the
   `platform.capstone/team=<team>` label).
6. **Delete the namespaces** `<team>-dev|-staging|-prod` and any `<team>-pr-<n>`
   (matched by name, so even bare dynamic preview namespaces are caught). They now
   vanish from `k9s` and stay gone.

The team **AppProject** is intentionally left in place; only namespaces are deleted.

## ON — exact step sequence (reverses 6 → 1, bootstrap first)

1. **Bootstrap app:** remove `skip-reconcile`, restore `automated: {prune, selfHeal}`.
2. **`tenants` appset:** remove the name-scoped guard for `tenant-team-<team>`.
3. **`root`:** remove the scoped `ignoreDifferences` guard.
4. **Refresh** the bootstrap app and **wait** for `<team>-dev` to reappear — the
   bootstrap re-sync recreates the namespaces + AppProject + team appsets from git.
5. **Team appsets:** remove `skip-reconcile` + clear `ignoreApplicationDifferences`.
   This re-asserts each env's correct sync policy from git — including the **prod
   manual gate** (ON does **not** force prod to auto-sync).
6. **Env/preview apps:** remove `skip-reconcile` + refresh; the un-frozen appset
   restores their per-env `automated` policy and redeploys the workloads.

## Reversibility

`tenant-on` is the exact inverse of `tenant-off`. Everything OFF removed is restored
from git by ArgoCD (namespaces, ResourceQuota/LimitRange/NetworkPolicy/RBAC,
AppProject, and the workloads). Both directions are **idempotent** — re-running is
safe and a no-op when already in the target state.

## ⚠ PVC / data-loss caveat

Deleting a namespace deletes its **PVCs and any in-cluster-only data**.
`tenant-off` therefore **refuses** to delete a namespace that contains a PVC unless
you pass `FORCE=true`, and it warns loudly listing the affected PVCs. There is no
backup taken — `FORCE=true` means the data is gone.

**ESO-materialized Secrets are safe**: the `ExternalSecret` objects are recreated by
the bootstrap/appset sync on `tenant-on`, and External Secrets Operator re-pulls
them from Vault into the fresh namespace.

## ArgoCD version / annotation check

Verified against the **installed** ArgoCD **v3.4.3**
(`bootstrap/argocd-install/kustomization.yaml`) via Context7:

- `argocd.argoproj.io/skip-reconcile: "true"` — **supported**; the application
  controller skips the Application entirely (user-guide/skip_reconcile.md).
- Per the docs, editing an appset-managed app's `spec.syncPolicy.automated` alone
  has **no effect** (the appset reverts it). The documented fix is the
  ApplicationSet's `ignoreApplicationDifferences` (jsonPointer `/spec/syncPolicy`)
  — which is exactly what this script uses as the reversion guard. The
  `skip-reconcile` annotation is also applied to the team **ApplicationSets** as a
  best-effort freeze; it is harmless if treated as an unknown annotation.

## Blast radius

Scoped to one team. The only shared objects touched are `root` and the `tenants`
appset, and only via **additive, name/field-scoped, fully-reversed** ignore entries
— other tenants keep reconciling normally. The entries are removed by `tenant-on`.
If you run `make bootstrap` / `bootstrap-reapply` while a tenant is paused, `root`
is re-applied from git and the guards are wiped; just re-run `make tenant-off`.
