# Multi-cluster — scaffolding for a second (homelab k3s) cluster

**Status: SCAFFOLDING, INERT.** As of 2026-07-07 exactly **one** physical cluster
exists — the 3× OptiPlex 7080 Talos hub (`admin@capstone`, everything in this repo's
component map). Nothing in this doc or the manifests it describes is running anywhere;
the mechanism is wired and ready, and stays a no-op until a human registers a real
second cluster. This is deliberate: build the plumbing now, while it's cheap and low
risk, without inventing workloads for hardware that doesn't exist yet.

The forcing use case is the planned **homelab k3s** box (a second, physically separate
cluster the operator intends to stand up later — see the roadmap note in
[gotchas-and-lessons.md](gotchas-and-lessons.md) / the retro roadmap). Nothing here is
specific to k3s, though — the mechanism works for any additional cluster ArgoCD can
reach a kubeconfig context for.

---

## 1. Why ArgoCD ApplicationSet (cluster generator), not Cluster API

Two different problems get conflated under "multi-cluster" and this platform only
needs one of them solved right now:

1. **Provisioning/lifecycle of the cluster itself** (turn hardware into a running
   Kubernetes API) — this is what **Cluster API** solves: a management cluster with
   CRDs (`Cluster`, `MachineDeployment`, infra providers) that creates/upgrades/deletes
   *clusters*.
2. **Deciding what GitOps deploys onto a cluster that already exists** — this is what
   an **ArgoCD ApplicationSet `clusters` generator** solves: it reads ArgoCD's own
   registered-cluster secrets and fans Applications out to whichever ones match a
   selector.

Every cluster this platform runs today is provisioned **out-of-band, by design**: Talos
via `talhelper` + the [phase-4-runbook.md](../phase-4-runbook.md), the Debian Mac
workers via Ansible ([debian-worker-onboarding.md](debian-worker-onboarding.md)). A
homelab k3s box follows the same pattern — a human runs `k3s` install (or `k3sup`/
whatever) on the hardware once, out-of-band. Adding **Cluster API** on top would mean
running a whole extra management-cluster control plane + a set of provider CRDs and
controllers **just to re-describe hardware we're going to build by hand anyway** — a
large new operational surface (another thing to patch, another failure mode, another
thing a successor has to learn) that buys nothing this platform needs. The **cluster
generator** is a few lines of YAML that reuses infrastructure ArgoCD already has
(cluster secrets, `argocd cluster add`), matches the existing "provision out-of-band,
GitOps owns the app layer" philosophy, and is the smallest thing that could possibly
work. If a future need arises to spin up/tear down clusters programmatically (e.g. a
fleet of ephemeral homelab-style boxes), revisit Cluster API then — it is not ruled out,
just not justified today for one box.

This also stays a **single ArgoCD control plane** (hub-and-spoke): the hub's ArgoCD
gains a remote destination; it does not install a second ArgoCD anywhere, and does not
need the newer `argocd-agent` distributed-control-plane project (built for
hundreds-of-clusters fleets — over-engineered for "one homelab box").

---

## 2. What's actually shipped by this scaffold

| Piece | File | What it does |
|---|---|---|
| ApplicationSet | [`applicationsets/satellite-clusters-appset.yaml`](../../applicationsets/satellite-clusters-appset.yaml) | `clusters` generator, selector `capstone.platform/tier: satellite`. One Application per matched cluster. |
| Baseline workload | [`clusters/_shared/satellite-baseline/`](../../clusters/_shared/satellite-baseline/) | Namespace + default-deny NetworkPolicy + a `cluster-registered` ConfigMap marker — the "proof of life" payload the appset ships today. |
| AppProject fence | [`bootstrap/platform-appproject.yaml`](../../bootstrap/platform-appproject.yaml) `destinations` | Adds `name: 'satellite-*'` so a matched cluster's Application is actually admitted (not just generated). |
| Registration helper | `make cluster-register` (Makefile) | Wraps `argocd cluster add` with the naming + label + least-privilege-namespace contract below. |

**Naming + label contract** (belt-and-suspenders, same "two independent gates" pattern
as the tenants-appset's underscore-exclude):

- The cluster must be registered with a **name starting `satellite-`** (checked by the
  AppProject `destinations` glob — get this wrong and ArgoCD rejects the Application
  with "cluster not permitted", loudly).
- The cluster must carry the **label `capstone.platform/tier: satellite`** (checked by
  the ApplicationSet's `clusters` generator selector — get this wrong and the appset
  simply never generates an Application for it; no error, just silence).

Both are set together by `make cluster-register` — see §3.

**Why inert today:** `argocd.argoproj.io/secret-type: cluster` secrets only exist for
clusters someone explicitly registered. ArgoCD's own implicit local/in-cluster entry
carries no `capstone.platform/tier` label, so the selector matches **zero** clusters
until a real one is registered. `kubectl -n argocd get applications -l
platform.capstone/component=multi-cluster` returns nothing today — that emptiness is
the expected, correct state, not a bug.

---

## 3. Registering the homelab k3s cluster (when it exists)

Prerequisites:

1. The box is running k3s (or any conformant Kubernetes) and is reachable from wherever
   you run `argocd`/`kubectl` — for a homelab machine behind residential NAT, that
   almost certainly means joining the existing **Tailscale** tailnet (`ualaims`), the
   same pattern already used for the Talos hub and the Debian Mac workers ([Tailscale-
   everywhere overlay](../phase-4-runbook.md)) — do **not** punch a hole in your home
   router for this.
2. Its kubeconfig is merged into your local kubeconfig as its own context (`k3s
   config`/`KUBECONFIG=... kubectl config view --flatten`, or copy `/etc/rancher/k3s/
   k3s.yaml` and repoint the server to the Tailscale IP).
3. You are logged in to the **hub's** ArgoCD CLI: `argocd login argocd.capstone.uamishub.com`.

Then, from the platform-infra repo:

```bash
make cluster-register CONTEXT=<homelab-kubeconfig-context> NAME=homelab-k3s
# registers ArgoCD cluster name "satellite-homelab-k3s", label
# capstone.platform/tier=satellite, argocd-manager scoped to ONLY the
# capstone-satellite-baseline namespace on the satellite (least privilege —
# widen with NAMESPACES="ns1 ns2" or `argocd cluster set` later).
```

Verify (all three, not just the first — "Synced/Healthy" alone is not proof, per
[argocd-gitops.md](argocd-gitops.md)):

```bash
argocd cluster list | grep satellite-homelab-k3s
kubectl -n argocd get applications -l capstone.platform/satellite-cluster=satellite-homelab-k3s
kubectl --context <homelab-kubeconfig-context> -n capstone-satellite-baseline get cm cluster-registered
```

If the AppProject rejects the Application ("cluster not permitted"): confirm
`bootstrap/platform-appproject.yaml`'s `satellite-*` destination has actually been
applied live — like every other AppProject change, it needs `make bootstrap-reapply
KUBE_CONTEXT=admin@capstone` after merge (the AppProject is install-owned, not
GitOps-reconciled — same gotcha as every `sourceRepos` addition documented in that
file).

**De-registering:** `argocd cluster rm satellite-homelab-k3s`. The generator stops
emitting the Application (it's deleted from ArgoCD's own state), **but the template
sets no `resources-finalizer.argocd.argoproj.io` finalizer** (matching the other
appset-generated templates in this repo — `platform-services-appset.yaml`,
`tenants-appset.yaml`), so the baseline namespace + objects are **left behind** on the
satellite cluster, not cascaded-deleted. Clean up manually if the box is being
decommissioned (`kubectl --context <ctx> delete ns capstone-satellite-baseline`).

**⚠ NetworkPolicy enforcement depends on the satellite's CNI.** Stock k3s ships
Flannel, which does **not enforce** NetworkPolicy objects — the same "looks
Synced/Healthy but is actually inert" trap hit on the Talos hub before the Cilium swap
([cilium-cni-runbook.md](../cilium-cni-runbook.md)). The baseline's
`default-deny-all`/`allow-egress-dns` NetworkPolicies will be present and reported
Synced on a default k3s install, but not enforced. Install Cilium/Calico on the
satellite (or run k3s with `--flannel-backend=none` + a policy-enforcing CNI) before
relying on them, or run an explicit deny-test the way SEC-011 did on the hub.

---

## 4. What would deploy here — roadmap, NOT implemented

The baseline above is deliberately the *smallest possible* payload, chosen to prove the
wiring rather than to guess at real capacity needs before the hardware exists. Once a
homelab k3s is actually registered, candidate next workloads (each its own follow-up
design, none started):

- **Observability shipping** — an Alloy DaemonSet on the satellite forwarding logs/
  metrics back to the hub's `platform-loki`/`kube-prometheus-stack`
  ([observability.md](observability.md)), federating the satellite into the one
  Grafana. Blocked on the hub exposing a remote-write/push endpoint reachable from the
  satellite (today Loki/Prometheus are cluster-local only, `*.monitoring.svc.cluster
  .local` — not reachable cross-cluster without a Tailscale-facing Service/Ingress and
  an auth story).
- **CI runner offload** — a second `gha-runner-scale-set` (ARC) on the satellite for
  extra Kaniko build capacity, so tenant CI isn't capped by the hub's fixed
  OptiPlex capacity. Needs its own Harbor push-robot + netpol posture
  ([runner-netpol :443-only](gotchas-and-lessons.md)) re-derived for a different box.
- **Tenant preview/dev overflow** — extending `applicationsets/tenants-appset.yaml`'s
  per-team env ApplicationSets to optionally target a satellite destination for
  capacity spillover. Needs the tenancy fence (AppProject, quotas, RBAC) re-proven on a
  cluster the security review hasn't looked at yet — do not do this casually.
- **Vault DR / warm-standby target** — ties into the already-backlogged Vault-DR work
  ([vault-and-dr.md](vault-and-dr.md)); a second cluster is a natural place for an
  off-site Raft-snapshot restore drill or a standby unsealer, but that's a DR design in
  its own right, not a side effect of this scaffold.

None of these are wired, scheduled, or assumed by the appset in §2 — they're recorded
here so the next person extending this scaffold doesn't have to re-derive "why would we
even want a second cluster" from scratch.
