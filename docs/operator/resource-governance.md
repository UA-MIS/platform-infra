# Resource governance (VPA + Goldilocks + Descheduler + tenant quotas)

Right-size workloads and fence tenants so no single team can starve the 3-box
cluster. Four layers, all GitOps (ArgoCD apps under `applicationsets/`):

| Layer | What it does | Evicts pods? |
|---|---|---|
| **VPA** (`platform-vpa`) | Installs the Vertical Pod Autoscaler (recommender + updater + admission controller) — the engine that observes real usage and recommends/sets right-sized **requests**. | Only where an Auto VPA object targets a workload. |
| **Goldilocks** (`platform-goldilocks`) | For every namespace labelled `goldilocks.fairwinds.com/enabled=true`, creates an **Off-mode** (recommend-only) VPA per workload and renders the suggestions as a dashboard. | **Never.** |
| **Descheduler** (`platform-descheduler`) | Hourly `CronJob` that evicts pods off genuinely over-utilized nodes (>50% CPU/mem) so the scheduler re-places them onto genuinely under-utilized ones (<20%). VPA/Goldilocks size **requests**; this is the layer that actually **moves** pods to use the headroom a new/idle node has. | Yes — bounded to 3 pods/node, 3 pods/namespace, 5 pods total **per run**; stateful tiers hard-excluded (see below). |
| **Tenant quota/LimitRange** (`tenants/_template` + CapstoneTenant Composition) | Per-namespace `ResourceQuota` (CPU/MEM/pods/**storage**) + `LimitRange` defaults so every pod gets a request and the quota is enforceable. | No. |

Charts are pinned Fairwinds charts from `https://charts.fairwinds.com/stable`
(added to the `platform` AppProject `sourceRepos`): **vpa 4.12.3** (appVersion
1.6.0) and **goldilocks 10.4.1** (appVersion v4.14.1). The VPA chart's bundled
`metrics-server` sub-chart is disabled — metrics-server is already installed
(`platform-metrics-server`).

## Sync-wave ordering

The VPA **CRDs must exist before any VPA object**:

- `platform-vpa` — **wave 0** (installs the CRDs + controllers; CRDs ship in the
  chart `crds/` dir, applied by ArgoCD).
- `platform-goldilocks` — **wave 1** (creates Off-mode VPA objects → needs CRDs).
- `platform-vpa-policies` — **wave 1** (the Auto VPA objects → needs CRDs).

`make bootstrap-reapply` after merge to add `charts.fairwinds.com/stable` to the
live `platform` AppProject (the AppProject is **install-owned**, not
GitOps-reconciled) — otherwise both apps `InvalidSpecError: repo not permitted`.

## The VPA policy split (platform vs. tenant)

- **Platform — active right-sizing.** `platform-vpa-policies`
  (`platform-services/vpa-policies/`) holds explicit `VerticalPodAutoscaler`
  objects: `updateMode: Auto` + `controlledValues: RequestsOnly` (set **requests**
  only, never touch limits). Scoped to a **curated allowlist of stateless,
  single-eviction-safe controllers** (currently the External Secrets trio + the
  Goldilocks stack itself). Extend it one reviewed stateless Deployment at a time —
  **never** with a namespace-wide selector, and **never** add a stateful singleton
  (Vault, Ceph mon/OSD, Postgres, Prometheus) — pre-k8s-1.33 Auto applies by
  **evicting** the pod.
- **Tenant / everything else — recommend-only.** The `goldilocks.fairwinds.com/enabled`
  label on the platform namespaces (in their `platform-services/*/namespace.yaml`)
  and on the tenant namespaces (`tenants/_template/namespaces/*` + the Composition)
  gives Goldilocks Off-mode VPAs everywhere: full sizing visibility, **zero
  evictions** — a demo pod is never surprise-restarted.

> ⚠ **Human-approval gate.** Merging + syncing `platform-vpa-policies` triggers a
> **one-time eviction** of each targeted controller as VPA applies its first
> recommendation. The targets are stateless + self-healing (a ~15s reconcile gap),
> but review the allowlist before allowing auto-sync. For a zero-eviction rollout,
> change `updateMode: Auto` → `Initial` (VPA then sets requests only at the pod's
> next natural restart).

## Tenant quota / LimitRange defaults

Already part of the tenancy fence (both the git `_template` and the zero-touch
Composition). This change **adds a storage cap** — the one starvation vector the
CPU/MEM quotas didn't fence (on replica-3 Ceph every 1Gi PVC costs 3Gi raw):

| Env | requests.cpu / mem | limits.cpu / mem | pods | requests.storage | PVCs |
|---|---|---|---|---|---|
| dev / staging | 2 / 2Gi | 4 / 4Gi | 10 | **5Gi** | **4** |
| prod | 4 / 4Gi | 8 / 8Gi | 15–20 | **20Gi** | **6** |
| preview (per-PR) | 1 / 1Gi | 2 / 2Gi | 5 | **2Gi** | **2** |

`LimitRange` (unchanged): default request `50m / 64Mi`, default limit
`500m / 256Mi`, max `1 / 1Gi` per container. Tunable per team.

## Using the dashboard

```bash
kubectl -n goldilocks port-forward svc/goldilocks-dashboard 8080:80
# open http://localhost:8080
```

ClusterIP only — it exposes request data for every workload, so it stays
cluster-internal. Publishing behind Traefik+OIDC is a follow-up.

## Descheduler (node rebalancing)

`applicationsets/descheduler-app.yaml`, pinned chart **descheduler 0.36.0**
(appVersion v0.36.0) from `https://kubernetes-sigs.github.io/descheduler/`
(added to the `platform` AppProject `sourceRepos` — `make bootstrap-reapply`
after merge, same install-owned caveat as every other Helm-source add).

**Why it exists:** the default scheduler only decides placement once, at pod
creation. A node that joins idle (e.g. a new laptop worker at ~1% CPU / 7% mem)
stays idle forever next to a node sitting at 60-70% memory — nothing ever moves
an already-running pod. The descheduler is the piece that evicts pods off the
hot node so the scheduler gets a second chance to place them on the idle one.

**Mode:** `kind: CronJob`, **not** the continuous `Deployment` mode — a bounded
batch job on an explicit schedule, not an in-process loop.

**Why conservative:** this cluster already had an incident where pod/policy
churn on one node saturated it and cascaded into a Vault raft-snapshot stall
(outage). A descheduler evicts healthy, running pods by design — run
aggressively it is a self-inflicted repeat of that incident. Guardrails:

| Knob | Value | Effect |
|---|---|---|
| `schedule` | `"0 * * * *"` (hourly) | Not the chart's `*/2 * * * *` default — rebalancing idle headroom is not urgent. |
| `maxNoOfPodsToEvictPerNode` / `PerNamespace` / `Total` | 3 / 3 / 5 | Hard cap on the blast radius of any single run. |
| `gracePeriodSeconds` | 60 | Evicted pods get a real shutdown window. |
| `DefaultEvictor.nodeFit` | `true` | Won't evict unless a schedulable target node actually exists — no evict-with-nowhere-to-go churn. |
| `DefaultEvictor.minReplicas` | 2 | Never evicts a singleton-replica workload. |
| `podProtections.extraEnabled` | `[PodsWithPVC]` | Any PVC-backed pod anywhere is protected, on top of the namespace excludes. |
| PodDisruptionBudgets | always respected | The chart's RBAC only grants the `pods/eviction` subresource — the API server enforces each pod's PDB server-side; there is no flag here that can bypass it. |
| Strategies enabled | `LowNodeUtilization` + `RemoveDuplicates` only | Every other upstream strategy (PodLifeTime, taint/affinity/topology-spread evictors, etc.) is left off. |

**LowNodeUtilization thresholds:** underutilized (eviction target) `< 20%`
CPU/mem/pods, overutilized (eviction source) `> 50%`. A node sitting between
20-50% is left alone — no reshuffling of nodes that are simply "fine".

**Stateful tier — hard-excluded on both `LowNodeUtilization.evictableNamespaces`
and `RemoveDuplicates.namespaces`:**

- `vault`, `vault-unsealer` — Raft quorum (mid-quorum eviction is the incident's
  failure mode).
- `db-tier` — CNPG + MariaDB Galera cluster members.
- `cnpg-system`, `mariadb-system` — the DB operators (leader election).
- `rook-ceph` — OSD/mon/mgr.
- `kube-system` — etcd-adjacent control-plane static pods (kube-apiserver,
  kube-controller-manager, kube-scheduler) + Cilium; also belt-and-suspenders
  since every DaemonSet is already protected cluster-wide by DefaultEvictor's
  default `DaemonSetPods` protection.

## Follow-ups (not in this change)

- **In-place pod resize** (`resizePolicy`, no eviction) needs the
  `InPlacePodVerticalScaling` GA in **Kubernetes 1.33** — a cluster upgrade. Until
  then Auto VPA applies by eviction, hence the stateless-only allowlist.
- Publish the Goldilocks dashboard behind Traefik + OIDC.
- Extend the Auto/RequestsOnly allowlist as more stateless controllers are vetted.
