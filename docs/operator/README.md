# Operator Guide — UA-MIS Capstone IDP

**Start here if you just inherited this platform.** This is the successor's map: what
the platform is, what runs on it, and how to do the everyday operations — each a short
how-to with a link to the detailed runbook.

Assumed: you are comfortable with Kubernetes but have **no prior context on this
build**. Read this, then the [Operations & Handoff manual](../OPERATIONS-AND-HANDOFF.md)
(especially its **CONTINUANCE** section — the org-owned credentials that must not be
tied to a graduating student).

> **The golden rule: you do not `kubectl apply` to change the platform.** Desired state
> lives in git (`UA-MIS/platform-infra`); **ArgoCD** continuously reconciles the cluster
> to match it. You change the platform by **merging a PR**, not by touching the cluster.
> `kubectl`/`talosctl` are for **reading** state and node-level ops only.

---

## 1. What this is

An **Internal Developer Platform (IDP)** for University of Alabama MIS capstone teams:
students get a git-driven deploy pipeline, four environments per app (preview / dev /
staging / prod) with a click-to-approve prod gate, GitHub SSO, isolated namespaces +
registry + secrets, and a stable URL — with **no `kubectl` and no cluster access**.

Public URLs live under **`capstone.uamishub.com`** (e.g. `argocd.`, `harbor.`, `id.`,
`process.` [Backstage], `grafana.`), published by a **Cloudflare Tunnel** (`cloudflared`,
outbound-only) to in-cluster **Traefik**.

---

## 2. Component map (verified live 2026-07-04)

| Layer | Component | Version | Role |
|---|---|---|---|
| Node OS / k8s | **Talos Linux** | v1.13.4 / k8s **v1.31.5** | Immutable, API-only OS; 3× OptiPlex 7080, all control-plane + **untainted (converged)** + etcd quorum |
| Worker (Mac tier) | **Debian 13** | kernel 6.12 | Late-2014 Mac Minis that **can't boot Talos** → join as kubelet workers (`mac-debian-01` live) |
| CNI | **Cilium** | v1.17.4 | eBPF dataplane, `kubeProxyReplacement`, VXLAN tunnel, **NetworkPolicy enforcement** (kube-proxy is absent) |
| Overlay | **Tailscale** | `ualaims` tailnet | The network fabric — stable `100.x` addressing across LANs; node-to-node + API |
| Storage | **Rook-Ceph** | operator v1.19.7 / Ceph v20.2.1 | replica-3 block storage on each node's SATA SSD; `ceph-block` default StorageClass |
| GitOps | **ArgoCD** | v3.4.3 | Reconciles the whole platform from `platform-infra` (app-of-apps) |
| Registry | **Harbor** | v2.15.1 | Per-team OCI registry, Trivy scan-on-push, OIDC login |
| SSO | **Dex** | v2.45.0 | OIDC broker → GitHub-org (UA-MIS) membership/teams; every tool federates to it |
| Secrets (runtime) | **Vault + ESO** | Vault 1.21.2 / ESO v2.6.0 | Keyless per-team secrets: names in git, values in Vault, ESO syncs to k8s Secrets |
| Onboarding | **Crossplane** | v2.3.2 | Zero-touch tenant provisioning (`CapstoneTenant` XR → Composition); providers: harbor v0.1.1, github v0.19.1, kubernetes v0.18.0, sql v0.15.0, vault v0.1.0 |
| Portal | **Backstage** ("The Process") | (in-tree image) | Developer portal + **scaffolder** (self-service new project) + TechDocs |
| CI | **ARC** (Actions Runner Controller) | gha-runner-scale-set | Self-hosted GitHub Actions runners; **rootless Kaniko** builds → Harbor |
| VMs | **KubeVirt + CDI** | v1.8.4 / v1.65.0 | On-demand VM workloads for tenants |
| Observability | **kube-prometheus-stack + Loki** | Prom v3.12.0 / Loki 3.6.7 | Metrics, logs, Grafana dashboards, alerts |
| Ingress | **Traefik** | bundled | Host-routing for `*.capstone.uamishub.com` |
| Public edge | **cloudflared** | — | Cloudflare Tunnel, outbound-only (no inbound ports) |
| Data tier | **Postgres 17 + MariaDB** on `ua-mis-db-1` | — | **Off-cluster** shared multi-tenant DB host (Tailscale-reachable) — still the system of record; an **in-cluster CNPG (PG17) + mariadb-operator (11.8) tier** is deployed (`db-tier` ns) but not yet cut over → [in-cluster-db-tier-runbook.md](in-cluster-db-tier-runbook.md) |

Architecture diagram + rationale: [`docs/index.md`](../index.md). Deeper component
runbooks: the [`docs/operator/`](.) directory (linked per-operation below).

---

## 3. Access

Everything is reached over the **Tailscale `ualaims` tailnet** (`100.x` addressing).
Get invited to the tailnet, then:

```bash
# kubectl / k9s (read-only is safe; writes go through GitOps):
export KUBECONFIG=clusters/real-talos/clusterconfig/talos-kubeconfig   # fish: set -x KUBECONFIG ...
kubectl --context admin@capstone get nodes -o wide

# talosctl (node ops — there is NO SSH to Talos nodes):
export TALOSCONFIG=clusters/real-talos/clusterconfig/talosconfig
talosctl -n 100.117.55.70 health          # n3 (the apiserver endpoint)
```

The kubeconfig, talosconfig, the **age private key** (`~/.config/sops/age/keys.txt`),
and the Talos secrets (`talsecret.sops.yaml` / `talenv.sops.yaml`, **not in git**) all
belong in the **handoff vault** — see [OPERATIONS §5](../OPERATIONS-AND-HANDOFF.md#5-continuance).

> Workstation shell is **fish**: `export VAR=value` silently fails — use `set -x VAR value`.

---

## 4. Common operations

### 4.1 Onboard a node

- **Talos node** (OptiPlex-class hardware): edit `clusters/real-talos/talconfig.yaml`,
  `talhelper genconfig`, `talosctl apply-config`. Endpoints are the nodes' Tailscale
  `100.x` IPs. → **[talos-node-onboarding.md](talos-node-onboarding.md)** (first-time
  3-node bring-up: [phase-4-runbook.md](../phase-4-runbook.md)).
- **Debian worker** (Mac Minis — they **cannot boot Talos**): an Ansible play
  (`ansible/`) TLS-bootstraps the kubelet onto the cluster. Needs a bootstrap-token +
  a Tailscale key, and a **local KubePrism stand-in** (Cilium hardcodes `127.0.0.1:7445`).
  → **[debian-worker-onboarding.md](debian-worker-onboarding.md)**.

### 4.2 Onboard a tenant (zero-touch)

Onboarding is **self-service**: a human creates a project in **Backstage** ("New
Capstone Project"), which commits one small `CapstoneTenant` claim to
[`tenants/_claims/<team>-<app>.yaml`](../../tenants/_claims/). ArgoCD syncs it and
**Crossplane** reconciles the whole tenant — GitHub repo + branch protection, Harbor
project + robots, Vault policy/role, and the full k8s tenancy fence (AppProject,
namespaces, quota/limitrange/netpol/RBAC, ESO plumbing, ApplicationSets). **No
onboarding PR, no operator `make` steps.** De-provision a cohort by `git rm`-ing the
claim files. → **[crossplane-onboarding.md](crossplane-onboarding.md)**; secrets side:
[secrets-eso.md](secrets-eso.md); the older manual `make` path (VM/fallback):
[OPERATIONS §4.4](../OPERATIONS-AND-HANDOFF.md#44-onboarding-a-new-teamtenant).

To **pause/restore** a tenant without deleting its git config: `make tenant-off
TEAM=<slug>` / `make tenant-on TEAM=<slug>` → **[tenant-on-off-switch.md](tenant-on-off-switch.md)**.

### 4.3 Manage secrets

Two classes. **Runtime app secrets:** name in git, value in **Vault**; **ESO** syncs
`tenants/<team>/<env>/app` into a namespaced k8s Secret — students set values in the
Backstage Secrets UI, never touching Vault directly. **Platform/bootstrap secrets**
(Dex, Harbor OIDC, ARC GitHub App, Talos): **Sealed Secrets** (committed encrypted) and
sops/age (Talos). → **[secrets-eso.md](secrets-eso.md)**, [vault-and-dr.md](vault-and-dr.md),
[developer/secrets.md](../developer/secrets.md).

### 4.4 Promote to prod

Non-prod (dev/staging) tracks `main` automatically. **Prod is pinned to an immutable
`vX.Y.Z` tag and only moves after a PM clicks "Approve"** in the team's GitHub
Environment (no CLI). CI builds rootless with Kaniko → Harbor and bumps the image tag
in the app's `.devops/promotion.yaml`. → [developer/cicd.md](../developer/cicd.md),
[argocd-gitops.md](argocd-gitops.md).

### 4.5 Monitoring / Grafana

**Grafana** at `grafana.capstone.uamishub.com` (kube-prometheus-stack + Loki logs +
Alloy). Alerts are defined but the **Alertmanager receiver is a stub** — wire
`platform-oncall` before relying on paging. → **[observability.md](observability.md)**.

### 4.6 Day-2 GitOps + bootstrap

Change the platform via **branch → PR → merge → ArgoCD sync**. Two objects are
install-owned and **not** GitOps-reconciled — after a PR touching `bootstrap/`, run
`make bootstrap-reapply KUBE_CONTEXT=admin@capstone`. → [argocd-gitops.md](argocd-gitops.md),
[OPERATIONS §4](../OPERATIONS-AND-HANDOFF.md#4-day-2-operations). "Synced/Healthy" is
**not** proof it works — assert pods actually reach `Running`.

---

## 5. Known DR gaps & risks (read before you rely on it)

These are **live-verified** weak spots a successor should close:

- **Vault is single-node** (`vault-0`, Raft) and the **Raft-snapshot CronJob is
  currently failing** (snapshot pods in `Error`). Vault holds every tenant runtime
  secret — losing the node without a good snapshot loses them. Fix the snapshot job and
  verify restores. → [vault-and-dr.md](vault-and-dr.md).
- **Single apiserver endpoint** — pinned to **n3**'s Tailscale IP. Losing n3 loses the
  API endpoint until you repoint to another CP node (cert SANs already cover all 3, so
  no cert regen). Multi-endpoint HA is a documented later add.
- **Manual Vault unseal / no proven DR restore** — auto-unseal via a second unsealer
  Vault exists (`vault-unsealer`), but the end-to-end restore drill is unproven.
- **No CODEOWNERS/`enforce_admins`** on branch protection yet — pending a GitHub
  Education/Team upgrade (a **faculty/institution** action, [OPERATIONS §5.4](../OPERATIONS-AND-HANDOFF.md#54-the-github-education--team-upgrade--a-facultyinstitution-action)).
- **Continuance is the real risk**, not tech: the age key, the Sealed Secrets sealing
  key, `talsecret.sops.yaml`/`talenv.sops.yaml`, kubeconfig/talosconfig, and org-owned
  Tailscale/Cloudflare/GitHub/DigitalOcean accounts must be **institutionally held** and
  in the handoff vault. → [OPERATIONS §5 CONTINUANCE](../OPERATIONS-AND-HANDOFF.md#5-continuance).

---

## 6. Runbook index

| Runbook | Covers |
|---|---|
| [OPERATIONS-AND-HANDOFF.md](../OPERATIONS-AND-HANDOFF.md) | The full successor manual — architecture, access, day-2, **continuance**, gotchas |
| [talos-node-onboarding.md](talos-node-onboarding.md) | Add/replace a Talos node (talhelper) |
| [debian-worker-onboarding.md](debian-worker-onboarding.md) | Onboard a Debian (Mac Mini) worker |
| [phase-4-runbook.md](../phase-4-runbook.md) | First-time 3-node Talos + Rook-Ceph bring-up |
| [cilium-cni-runbook.md](../cilium-cni-runbook.md) | The Cilium CNI (design + the Tailscale/eBPF hazard) |
| [crossplane-onboarding.md](crossplane-onboarding.md) | Zero-touch tenant onboarding internals |
| [tenant-on-off-switch.md](tenant-on-off-switch.md) | Reversibly pause/restore a tenant |
| [secrets-eso.md](secrets-eso.md) · [vault-and-dr.md](vault-and-dr.md) | Runtime secrets (ESO) + Vault DR |
| [harbor.md](harbor.md) | Harbor registry ops (projects, robots, OIDC) |
| [argocd-gitops.md](argocd-gitops.md) | GitOps model, bootstrap, the `argocd-cm` SSA-wipe gotcha |
| [observability.md](observability.md) | Prometheus/Loki/Grafana + alerts |
| [resource-governance.md](resource-governance.md) | VPA/Goldilocks + per-tenant quotas |
| [db-tier-runbook.md](../db-tier-runbook.md) · [db-tier-provisioner-setup.md](db-tier-provisioner-setup.md) | Off-cluster Postgres/MariaDB tier |
| [in-cluster-db-tier-runbook.md](in-cluster-db-tier-runbook.md) | The in-cluster CNPG/MariaDB tier — Vault wiring + the pg_dump/mysqldump cutover from `ua-mis-db-1` and the bundled per-app subcharts |
| [vm-path-harbor-provisioner.md](vm-path-harbor-provisioner.md) | KubeVirt VM scaffolder wiring |
| [gotchas-and-lessons.md](gotchas-and-lessons.md) | Process-layer war stories |
