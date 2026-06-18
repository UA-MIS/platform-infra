# ARC — self-hosted GitHub Actions runners (P2.3, §1.3, D-032)

The platform CI engine: **GitHub Actions + Actions Runner Controller (ARC) +
Kaniko**, runners on our own cluster (no GitHub-hosted minutes), pushing to Harbor.
Modern **scale-set** ARC (`gha-runner-scale-set`), NOT the legacy summerwind CRDs.

- Controller: `gha-runner-scale-set-controller` **v0.14.2** (pinned OCI chart),
  `applicationsets/arc-controller-app.yaml` → ns `arc-system`.
- Runner scale set: `gha-runner-scale-set` v0.14.2,
  `applicationsets/arc-runner-scaleset-app.yaml` → ns `arc-runners`. Org-scoped to
  UA-MIS, **ephemeral, scale-from-zero** (`minRunners: 0`, `maxRunners: 3`).
- Isolation: `hardening/netpol-runners/` (manual-sync, the security gate).
- OCI chart registry allowlisted in `bootstrap/platform-appproject.yaml`
  (`ghcr.io/actions/actions-runner-controller-charts`) — install-owned, re-apply
  after merge (`make bootstrap-reapply`).

## containerMode: kubernetes (the rootless / no-docker-socket model)
Workflow job steps run as **separate Kubernetes pods**, not inside a privileged
dind container. No docker daemon, no docker socket, not privileged — exactly what
**Kaniko** (rootless image builds) needs, and the foundation of runner isolation.

## ⚠ Runner isolation — THE headline security gate (security signs this off)
Self-hosted runners execute **untrusted student PR code**, so `arc-runners` is the
highest-risk surface on the platform. Controls:
- **Pod security** (`arc-runner-scaleset-app.yaml` template): non-root (uid 1001),
  `allowPrivilegeEscalation: false`, drop **ALL** caps, seccomp `RuntimeDefault`,
  no privileged, no docker socket.
- **NetworkPolicy** (`hardening/netpol-runners/runner-netpol.yaml`, manual-sync):
  default-deny; egress only DNS + in-cluster services (10.43/16, incl. the
  `kubernetes` API Service for containerMode pod creation + Harbor) + external
  HTTPS:443 (GitHub). **The apiserver on the node IP (10.89/24:6443) and all
  cross-tenant pod ranges (10.42/16) are BLOCKED** — a runner cannot reach the
  apiserver directly or another team's pods.
- Enforce via the watched `argocd app sync platform-netpol-runners` (NOT
  auto-applied — see the Application header); verify a real build still
  clones+pushes AND a runner cannot reach the apiserver/other tenants.

## GitHub App (the runner credential — human creates this once)
The scale set authenticates to GitHub via a **GitHub App** (preferred over a PAT:
fine-grained, org-owned, rotatable). One-time human steps:
1. Create a GitHub App in the **UA-MIS** org with permissions: **Self-hosted
   runners: Read & write** (org), **Actions: Read**; install it on the org.
2. Note `App ID` + `Installation ID`; generate + download a private key (.pem).
3. Build the Secret + seal it into `arc-runners`:
   ```bash
   kubectl create secret generic arc-github-app -n arc-runners \
     --from-literal=github_app_id=<APP_ID> \
     --from-literal=github_app_installation_id=<INSTALLATION_ID> \
     --from-file=github_app_private_key=<path/to/key.pem> \
     --dry-run=client -o yaml \
   | make seal NS=arc-runners > platform-services/arc/sealedsecret-github-app.yaml
   # then uncomment sealedsecret-github-app.yaml in kustomization.yaml + commit.
   ```
The scale set's `githubConfigSecret: arc-github-app` references it. Until it exists
the listener can't auth (the app shows Progressing) — expected pre-credential.

## CI ↔ workflow contracts (coordinated with the developer)
- **`runs-on` = the scale-set name** (this is how the scale-set model works — the
  workflow selects the set by its name). Current: **`runs-on: ua-mis-kaniko`**
  (the `releaseName` in `arc-runner-scaleset-app.yaml`). Change both sides together.
- **Harbor PUSH credential** (separate from the workload PULL robot): CI pushes with
  a per-team **push** robot scoped to **only the team's own Harbor project** (least
  privilege — it must not push to other teams' projects). Secret **`harbor-push`**
  (dockerconfigjson), registry `harbor.capstone.uamishub.com/<name>/<app>:<tag>`, robot
  `robot$<name>+ci-push`, consumed by Kaniko at `/kaniko/.docker/config.json`.
  Provisioned by **`make harbor-push-robot NAME=<name> [RUNNER_NS=arc-runners] >
  harbor-push-sealed.yaml`** — mints a robot with **pull+push on project `<name>`
  ONLY** (least privilege; can't push to other teams' projects) and seals it as
  secret `harbor-push` into the runner namespace.
  - **CONSUMPTION = OPTION C (container-hook).** In `containerMode: kubernetes` the
    build runs in its own job-step pod (ARC requires job containers in k8s mode), so
    a secret on the runner pod is invisible to it. `hook-template.yaml` (the
    `arc-hook-template` ConfigMap) is merged by the k8s container hook into every
    job-step pod, landing `harbor-push` inside the build container at
    **`/kaniko/.docker/config.json`** — so the workflow needs **zero** cred-handling
    steps; Kaniko finds it. The cred is projected ONLY into the build container,
    never onto the general runner pod (untrusted non-build steps can't read it).
    Wired via `ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE` in
    `applicationsets/arc-runner-scaleset-app.yaml`.

## Resource posture (local k3d)
`minRunners: 0` + `maxRunners: 3` + per-runner requests/limits (250m/512Mi →
2cpu/2Gi) are **values knobs** — they cap a Kaniko build burst from OOMing the
laptop and scale up on real hardware (Phase-4). Box has ample headroom
(24c/62Gi/931G).
