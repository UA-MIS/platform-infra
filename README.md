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
make seal SECRET=... # (T4) kubeseal a secret for git
make cluster-down    # tear the cluster down (idempotent)
```

All targets are **idempotent** — re-running them never errors. `cluster-up`
creates the cluster only if missing (otherwise starts it); `cluster-down` is a
no-op when the cluster is already gone.

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
