# platform-infra — Capstone IDP (Phase 1)

Single source of truth for the cluster. ArgoCD watches this repo and reconciles
everything in it. This is the **platform-engineer-owned** half of the platform
(students own their `team-*-app` repos). See
[`artifacts/design/phase-1-architecture.md`](../artifacts/design/phase-1-architecture.md).

> **Generalize-then-instantiate.** Every primitive is written for *N* teams and
> parameterized by three variables. Porting to the real k3s cluster (Phase 4) is
> "fill `clusters/real-k3s/values.env` + re-point ArgoCD", not a rewrite (§6).

## Layout

```
platform-infra/
├── Makefile                      # cluster up/down, bootstrap, seal (this doc)
├── .env.example                  # optional local overrides
├── clusters/                     # the portability seam — one dir per target
│   ├── local-k3d/                #   Phase 1 (k3d)
│   │   ├── k3d-config.yaml        #     cluster shape: 1 server + 1 agent, registry, LB 80/443
│   │   └── values.env             #     PLATFORM_DOMAIN / REGISTRY / GITHUB_ORG / CLUSTER_NAME
│   └── real-k3s/                  #   Phase 4 stub (same keys, placeholder values)
├── bootstrap/                    # what a human applies ONCE (ArgoCD + root app) — T3
├── platform-services/            # ArgoCD-managed cluster services — T4
├── tenants/                      # multi-tenancy: one dir per team — T7
└── applicationsets/              # app-of-apps children — T3
```

## Prerequisites

| Tool | Why | Install |
| --- | --- | --- |
| `k3d` ≥ v5.9 | creates the k3s-in-Docker cluster (D-002) | release binary -> `~/.local/bin` |
| `kubectl` | talk to the cluster | distro pkg |
| `docker` **or** rootless `podman` | container runtime k3d drives | distro pkg |
| `helm`, `kubeseal` | later tasks (T3/T4) | distro pkg / release binary |

### Container runtime: Docker vs rootless Podman

The Makefile auto-detects the runtime. With **rootless Podman** it points k3d at
your user socket (`/run/user/$UID/podman/podman.sock`) and bind-mounts that
socket into the k3d nodes, avoiding the root-owned `/var/run/docker.sock`.

> **Rootless Podman requires one host prerequisite:** the cgroup-v2 **`cpuset`**
> controller must be delegated to your user, or k3s won't start
> (`failed to find cpuset cgroup (v2)`). `make preflight` checks this and prints
> the fix. One-time, needs root, then log out/in (or reboot):
>
> ```bash
> sudo mkdir -p /etc/systemd/system/user@.service.d
> printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | \
>   sudo tee /etc/systemd/system/user@.service.d/delegate.conf
> sudo systemctl daemon-reload
> loginctl terminate-user "$(id -un)"   # or reboot
> ```
>
> Verify after: `cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers`
> must list `cpuset`. (Native Docker / Docker Desktop users can ignore this.)

## Quick start

```bash
cd platform-infra

make preflight       # verify tools + cpuset delegation (actionable errors)
make cluster-up      # create the k3d cluster if absent (idempotent)
make cluster-info    # nodes + registry + ingress base URL
# ... later phases:
make bootstrap       # (T3) apply ArgoCD root app-of-apps
make bootstrap-reapply  # re-apply install-owned bootstrap objects after a bootstrap/ merge
make seal SECRET=... # (T4) kubeseal a secret for git
make cluster-stop    # stop the cluster + registry without deleting
make cluster-start   # restart a STOPPED cluster + registry (post-reboot)
make cluster-down    # tear the cluster down (idempotent)
```

All targets are **idempotent** — re-running them never errors. `cluster-up`
creates the cluster only if missing (otherwise starts it); `cluster-down` is a
no-op when the cluster is already gone.

### Post-reboot recovery (`cluster-start`)

A host reboot leaves the k3d cluster and registry **containers stopped, not
deleted** — so you don't need `cluster-up` (which would try to recreate them).
`make cluster-start` brings the existing cluster back in one command:

```bash
make cluster-start   # starts the registry, then the cluster, waits for nodes Ready
```

It injects the rootless-Podman socket automatically (no manual
`DOCKER_HOST=…` export), starts the registry **before** the cluster so node
containerd can resolve it, `k3d cluster start`s the cluster, waits for nodes to
go `Ready`, and switches your kube-context to `k3d-$(CLUSTER_NAME)`. ArgoCD apps
may take a minute to re-settle to `Healthy` after the restart. The inverse,
`make cluster-stop`, stops both without deleting them.

### Re-applying install-owned bootstrap objects (`bootstrap-reapply`)

**Most of the platform is GitOps-reconciled** — ArgoCD watches this repo and
self-heals `platform-services/`, `tenants/`, `applicationsets/`. But two objects
are **install-owned and NOT GitOps-reconciled, by design**:

- `bootstrap/argocd-install/` — the upstream ArgoCD install plus our `argocd-server`
  patches (the `server.insecure` flag, the UI-theme CSS volume mount).
- `bootstrap/platform-appproject.yaml` — the `platform` AppProject (its
  `sourceRepos` allowlist, destinations, resource whitelists).

These are the chicken-and-egg roots ArgoCD's own apps live in and run on, so the
application-controller doesn't manage them — `make bootstrap` applies them once.
**Consequence:** when you merge a PR that changes anything under `bootstrap/`, git
is updated but the **live cluster stays stale** until you re-apply. (We hit this:
the Harbor chart blocked on a missing `sourceRepos` entry, and the UI theme 404'd
because the `argocd-server` volume mount never reached the live Deployment.)

After merging any `bootstrap/` change, run:

```bash
make bootstrap-reapply
```

It server-side-applies (with `--force-conflicts`) both objects, then rolls
`argocd-server` so any Deployment-spec change (e.g. a new volume mount) takes
effect. **Idempotent** — safe to run repeatedly; a no-op when the live objects
already match git (the rollout creates no new ReplicaSet if the spec is unchanged).
It does **not** modify the manifests or touch GitOps-synced services.

### Built-in registry (D-005)

`cluster-up` provisions `k3d-registry.localhost:5000` and ensures it resolves on
the host. The local CI loop (T8) builds and pushes images there; containerd on
every node is pre-wired to pull from it. To push from the host you need a hosts
entry (the Makefile adds it if `/etc/hosts` is writable, otherwise prints):

```bash
echo '127.0.0.1 k3d-registry.localhost' | sudo tee -a /etc/hosts
```

## Portability (§6)

Switch targets with `TARGET=`:

```bash
make cluster-up TARGET=local-k3d     # Phase 1 (default)
# real-k3s is provisioned out-of-band; ArgoCD is re-pointed at it (no cluster-up)
```

Only three variables differ between targets — `PLATFORM_DOMAIN`, `REGISTRY`,
`GITHUB_ORG` — all in `clusters/<target>/values.env`. Everything else (tenants,
AppProjects, ApplicationSets, quotas, RBAC, NetworkPolicies) is identical across
targets because it is written against those variables, not hardcoded.
