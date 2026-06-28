# ArgoCD & GitOps

ArgoCD is the only writer of desired state for the platform. You change the
platform by **merging a PR to `UA-MIS/platform-infra`**, not by running `kubectl`
against the cluster. ArgoCD continuously reconciles the live cluster to match git.

> **Golden rule.** Direct `kubectl apply` to the shared cluster creates drift that
> ArgoCD will either fight (selfHeal) or that `make bootstrap-reapply` has to
> repair. The only sanctioned imperative writes are the **install-owned** objects
> below and the one-time operator ceremonies documented in the other operator
> pages (Vault unseal, Crossplane Phase-0, robot minting).

---

## The app-of-apps / ApplicationSet model

The whole platform fans out from one root Application.

```
bootstrap/root-app.yaml            (the "root" Application — applied ONCE by make bootstrap)
  └─ points at applicationsets/  (directory recurse)
       ├─ platform-services-appset.yaml   → one Application per platform-services/*/ dir
       ├─ tenants-appset.yaml              → one "tenant-<team>" Application per tenants/team-*/ dir
       └─ *-app.yaml (one file each)       → the Helm-source platform apps
            (harbor, vault, external-secrets, kube-prometheus-stack, loki, alloy,
             arc-*, rook-ceph-*, traefik, metrics-server, crossplane-{core,runtime,apis,claims}, …)
```

- **`bootstrap/root-app.yaml`** (`Application/root`, `argocd` ns, `platform`
  project) points at `applicationsets/` with `directory.recurse: true`. It has
  `automated: {prune, selfHeal}` — once applied it pulls in everything else.
- **`applicationsets/platform-services-appset.yaml`** is a git **directory
  generator** over `platform-services/*` → emits `platform-svc-<dir>` Applications.
  Adding a directory under `platform-services/` adds a platform service.
  - Excludes (documented in the file): `platform-services/harbor-onboarding`
    (a per-team Job template with a literal `__TEAM__` placeholder — applied
    imperatively, never reconciled) and `platform-services/traefik` (now a
    standalone Helm-source app).
- **`applicationsets/tenants-appset.yaml`** is a git directory generator over
  `tenants/*` → emits `tenant-<team>` bootstrap Applications (each renders the
  team's AppProject, namespaces, quota/limitrange/netpol/RBAC, and env/preview
  ApplicationSets). `tenants/_template` is excluded (it is the blueprint).
- The individual `applicationsets/*-app.yaml` files are the Helm-source platform
  Applications (each pins its chart version in `targetRevision`).

**Two AppProjects enforce the tenancy fence:**

- **`platform`** (`bootstrap/platform-appproject.yaml`) — the privileged project.
  It alone may create cluster-scoped resources (CRDs, ClusterRoles, controllers).
  Only `platform-infra` and the pinned external Helm chart repos are in its
  `sourceRepos`. The root app, every `platform-svc-*`, and every `tenant-*`
  bootstrap app live here.
- **per-team projects** (rendered from `tenants/_template/appproject.yaml`) —
  whitelist only that team's namespaces and the team's own app repo, and forbid
  cluster-scoped resources. Team **workloads** run here; the `tenant-*` bootstrap
  app that *creates* the project runs in `platform`.

---

## `make bootstrap` and `make bootstrap-reapply`

Two objects are **install-owned and deliberately NOT GitOps-reconciled**:

1. `bootstrap/argocd-install/` — the ArgoCD install + the `argocd-server` patches.
2. `bootstrap/platform-appproject.yaml` — the `platform` AppProject `sourceRepos`
   allowlist.

When you merge a PR that touches `bootstrap/`, **git is updated but the live
cluster stays stale** until you re-apply. This is intentional (ArgoCD cannot
safely reconcile its own install/project), and it is the #1 "looks merged but
nothing happened" trap on the platform.

### Fresh-cluster install (one command, idempotent)

```bash
cd platform-infra
make bootstrap TARGET=real-talos KUBE_CONTEXT=admin@capstone
```

Installs ArgoCD (pinned `v3.4.3`, single-replica), applies the `platform`
AppProject, applies `bootstrap/root-app.yaml`. ArgoCD then pulls everything else.

### After any `bootstrap/` change (the one you will run most)

```bash
make bootstrap-reapply KUBE_CONTEXT=admin@capstone
```

`bootstrap-reapply` does five hardened steps (read the target in the `Makefile`):

0. Strips the stale `last-applied-configuration` annotation on `argocd-cm`
   (removes the CSA→SSA prune trigger — see the wipe gotcha below).
1. Re-applies `bootstrap/argocd-install` (`--server-side --force-conflicts`).
2. Re-applies `bootstrap/platform-appproject.yaml`.
3. **Force-syncs** `platform-svc-argocd-config` to re-assert the `argocd-cm`
   theme (`ui.cssurl`) + SSO (`oidc.config`) keys.
4. Rolls `argocd-server` so it re-reads the restored config.
5. **Asserts** both keys survived — fails loudly if SSO/theme would be down.

It then prints verification commands:

```bash
kubectl -n argocd get appproject platform -o jsonpath='{.spec.sourceRepos}'
curl -sk https://argocd.capstone.uamishub.com/custom/ua-mis.css | head
```

> Symptom you forgot to run it: a new platform app sits
> `InvalidSpecError "repo not permitted"` (its chart repo isn't in the live
> AppProject `sourceRepos` yet). Every external chart repo is install-owned —
> Harbor, ARC, Rook, metrics-server, Traefik, Backstage, ESO, Vault, Crossplane,
> kube-prometheus-stack, Grafana/Loki. Re-apply, then **verify it took**.

### ⚠ The stale-local-checkout gotcha → always run from a fresh `main`

`bootstrap-reapply` applies **the files on your disk**, not what's in git. If you
run it from a stale worktree (an old branch, an un-pulled checkout, or a render
worktree), you re-apply **old** bootstrap objects over the live cluster — silently
reverting a merged `sourceRepos` add or argocd-server patch. **Always check out a
clean `origin/main` and `git pull` before running it.** Verify ground truth with
`gh`/`git show origin/main:…`, never a stale local worktree.

### ⚠ The `argocd-cm` SSA wipe gotcha

`argocd-cm` is co-managed: the install ships only `resource.customizations.*`; the
GitOps app `platform-svc-argocd-config` owns `ui.*` (theme) + `oidc.*` (SSO). A
**bare** `kubectl apply -k bootstrap/argocd-install --server-side
--force-conflicts` **wipes the entire `argocd-cm.data`** (SSO + theme break),
because a stale `last-applied-configuration` annotation triggers a CSA→SSA
migration that prunes the GitOps keys. **Never** run that bare apply against
argocd-cm — use `make bootstrap-reapply`, which is hardened against it (step 0 +
step 3 + step 5) and is live-proven safe.

---

## Sync & health

```bash
export KUBECONFIG=clusters/real-talos/clusterconfig/talos-kubeconfig   # fish: set -x KUBECONFIG ...
kubectl -n argocd get applications                       # the fleet at a glance
argocd app sync <app>                                    # manual sync (CLI)
argocd app get <app>                                     # detailed health/sync state
```

- Most apps `automated: {prune, selfHeal}` and converge on merge.
- **Manual-sync by design** (do not expect auto-sync): the SEC-011 network
  policies — `platform-netpol-controlplane` and `platform-netpol-runners`. They
  show `OutOfSync` until you `argocd app sync` them. The
  `ArgoCDAppStuckOutOfSync` alert explicitly **excludes** the netpol app.

> **"Synced/Healthy" is not proof it works** (ADV-002). An app can be green with
> every pod in `ImagePullBackOff`, and a hook-only app shows green while the hook
> never ran. Always assert the actual pods reach `Running` / the behavior
> happened. `make verify-image-pull` checks the registry-mirror class of failure.

---

## The theme / SSO re-assert

The platform's ArgoCD UI theme and OIDC SSO live in `argocd-cm`, owned by the
GitOps app `platform-svc-argocd-config` (`platform-services/argocd-config/`:
`argocd-cm.yaml`, `argocd-rbac-cm.yaml`, `ua-mis.css`, `ingress.yaml`,
`sealedsecret.yaml`). Two ways they can disappear:

- A bare install apply wiped them (gotcha above) → run `make bootstrap-reapply`.
- They drifted → force-sync the config app directly:

```bash
kubectl -n argocd patch app platform-svc-argocd-config --type merge \
  -p '{"operation":{"sync":{"syncStrategy":{"apply":{"force":true}}}}}'
```

Verify both keys are present (this is what `bootstrap-reapply` step 5 checks):

```bash
kubectl -n argocd get cm argocd-cm -o jsonpath='{.data.ui\.cssurl}{"\n"}{.data.oidc\.config}'
```

ArgoCD RBAC (`argocd-rbac-cm.yaml`) maps the Dex `UA-MIS:<team>` group to a scoped
`role:<team>` (matches `<project>/<app>`). The **one-slug-everywhere** convention
(D-026) means any divergence between the team slug, AppProject, namespace prefix,
and OIDC group makes the role silently inert — `make validate` guards it.

---

## The repoURL seam

Every `repoURL`/`sourceRepos` entry hardcodes `https://github.com/UA-MIS/<repo>`
(the real home). For a local mirror you can repoint them all in one shot:

```bash
make show-repo-base                    # what's wired in now
make set-repo-base GIT_BASE_URL=https://github.com/UA-MIS    # rewrite (idempotent, reversible)
```

See `bootstrap/REPO-SEAM.md`. In normal operation you never touch this.
