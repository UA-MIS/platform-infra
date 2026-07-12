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
  single-eviction-safe controllers** — one file per group, one object per
  Deployment (exact `targetRef.name`, never a namespace selector). Current Auto set:

  | File | Auto targets |
  |---|---|
  | `external-secrets-vpa.yaml` | ESO controller, webhook, cert-controller |
  | `goldilocks-vpa.yaml` | goldilocks-controller, goldilocks-dashboard |
  | `argocd-vpa.yaml` | argocd-server, repo-server, applicationset-controller, notifications-controller, dex-server |
  | `crossplane-vpa.yaml` | crossplane (core), crossplane-rbac-manager |
  | `harbor-vpa.yaml` | harbor-core, harbor-registry, harbor-jobservice, harbor-portal |
  | `kyverno-vpa.yaml` | background-controller, cleanup-controller, reports-controller |
  | `monitoring-vpa.yaml` | grafana, kube-state-metrics, prometheus-operator, thanos-query, otel-collector, ntfy |
  | `backstage-vpa.yaml` | backstage (slow-start — resize LAST) |
  | `edge-and-controllers-vpa.yaml` | traefik, cloudflared, portal (all 2-replica, PDB-guarded); db-admin-console, oauth2-proxy, arc-gha-rs-controller |
  | `vpa-self-vpa.yaml` | vpa-recommender, vpa-updater |

- **Excluded from Auto (recommend-only Off VPAs only) — the stateful / quorum /
  request-path set.** These carry most of the cluster's over-provisioning but Auto
  eviction on them risks data/quorum/availability, so they are **deliberately left
  recommend-only** and right-sized by hand at a maintenance restart:
  - **Databases / quorum:** CNPG `capstone-pg-*`, MariaDB Galera `capstone-mariadb-*`,
    `harbor-database`, `harbor-redis`, Vault `vault-0/1/2`, `minio`, Rook-Ceph
    OSDs/mons/mgr, etcd + control-plane static pods.
  - **Monitoring state on PVCs:** Prometheus, Alertmanager, Loki, Tempo,
    thanos-store-gateway, thanos-compactor.
  - **Request-path singletons:** `kyverno-admission-controller` (its webhooks are
    `failurePolicy: Fail` — an eviction gap fails admission closed cluster-wide);
    `argocd-application-controller` (StatefulSet, the core reconcile engine);
    `argocd-redis`; `vpa-admission-controller` (the webhook that injects the
    recommendations — must stay up during the eviction wave or resized pods restart
    un-injected → thrash).
  - **Crossplane `provider-*` / `function-*`** — their Deployment names carry a
    revision hash that changes on every package bump, so a pinned `targetRef` would
    dangle; VPA has no selector form. Right-size at a deliberate package bump.
- **Tenant / everything else — recommend-only.** The `goldilocks.fairwinds.com/enabled`
  label on the platform namespaces (in their `platform-services/*/namespace.yaml`)
  and on the tenant namespaces (`tenants/_template/namespaces/*` + the Composition)
  gives Goldilocks Off-mode VPAs everywhere: full sizing visibility, **zero
  evictions** — a demo pod is never surprise-restarted. (Active tenant right-sizing
  is a separate opt-in, not enabled here.)

### The `--min-replicas=1` switch

`applicationsets/vpa-app.yaml` runs the updater with `updater.extraArgs.min-replicas:
"1"`. **This is load-bearing:** the updater's default is `--min-replicas=2`, which
makes it **refuse to evict any workload with fewer than 2 replicas** — nearly every
target above is single-replica, so at the default Auto would be a *silent no-op* for
them (they'd only right-size at their next natural restart). Setting `1` lets Auto
actively evict-and-resize singletons. It is safe cluster-wide because Auto is scoped
to this curated allowlist only; every excluded workload has an `updateMode: Off` VPA
that is never evicted regardless of the flag. **Remove the flag** (revert to `2`) for
the gentle path: singletons then right-size only at their next natural restart — no
forced eviction wave, slower convergence.

### PDBs

`pdbs.yaml` adds `minAvailable: 1` PodDisruptionBudgets for the three 2-replica Auto
targets (traefik, cloudflared, portal) which had none — so the updater (and the
descheduler, and node drains) can never take both replicas at once, making their
resize zero-downtime. Single-replica targets get **no** PDB on purpose: a
`minAvailable:1` PDB on a 1-replica workload would forbid *all* voluntary eviction and
**deadlock** VPA-Auto; they accept a one-time eviction blip instead.

> ⚠ **Human-approval gate — HELD for a supervised apply.** Syncing
> `platform-vpa-policies` (with `--min-replicas=1` live) triggers a **wave of one-time
> evictions** across ~24 single-replica controllers as VPA applies first
> recommendations, plus rolling resizes of the 2-replica ones. Targets are stateless +
> self-healing, but this IS a live disruption (ArgoCD UI blip, Harbor auth blip, a
> 1-2 min Backstage portal outage). Do it in a watched window — see the runbook below.
> Per-object escape hatch: set one object's `updateMode: Auto` → `Initial` to resize
> it only at its next natural restart (used for Backstage if the portal outage is
> unwanted).

### Net effect — right-sizing, not a big reclaim (be honest)

VPA-Auto is **bidirectional**: it lowers over-provisioned requests *and raises
under-provisioned ones*. On this cluster many stateless controllers ship with **no
memory request at all** (most argocd components, harbor-trivy) or are genuinely
under-set (crossplane core: 256Mi request vs ~1Gi real use), so applying the full
allowlist **nets ≈ +3Gi of *reserved* memory, not a reclaim.** That is a *correctness
/ OOM-safety* win — the pods already *use* that memory; the reservation was just
missing, which is a scheduling hazard on a RAM-constrained cluster. Genuine reclaim is
small and concentrated (vpa-updater/recommender ~0.7Gi, crossplane-rbac ~0.15Gi,
harbor-core ~0.05Gi). The **large** over-provisioning is locked inside the *excluded*
stateful tier (Ceph OSDs ~2Gi each, mons, Prometheus ~3Gi, CI kaniko runners) which
Auto must not touch. The real levers for the RAM crunch remain the **descheduler**
(bin-packing onto idle nodes) and the **hardware upgrade**; VPA's contribution is
honest requests so those layers can pack accurately.

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

## Supervised-apply runbook — flipping the platform to VPA-Auto

Run in a watched window. The quorum/stateful services are **not** in the Auto set, so
nothing should evict them — the job is to confirm they stay up while the stateless wave
rolls, and to stop if a node goes under memory pressure.

**0. Pre-flight (read-only).**
```bash
kubectl get nodes                                   # all Ready
kubectl -n vault get pods                            # vault-0/1/2 Running, unsealed
kubectl -n db-tier get pods                          # CNPG + Galera all Ready
kubectl -n rook-ceph get pods | grep -E 'osd|mon'    # OSDs/mons Running
kubectl top nodes                                    # note memory headroom per node
```

**1. Merge + install-owned AppProject reapply** (no new sourceRepos here, but the
apps must be registered): confirm `platform-vpa`, `platform-goldilocks`,
`platform-vpa-policies` are `Synced/Healthy` in ArgoCD.

**2. Land the updater flag FIRST, then the policies.** Sync `platform-vpa` so the
updater comes up with `--min-replicas=1` *before* the new Auto objects exist:
```bash
kubectl -n vpa get deploy vpa-updater \
  -o jsonpath='{.spec.template.spec.containers[0].args}'; echo   # -> ["--min-replicas=1"]
```
Then sync `platform-vpa-policies` (the 29 Auto VPAs + 3 PDBs).

**3. Watch the eviction wave** (rolls over ~5-15 min as the updater reconciles). In one
terminal:
```bash
kubectl get events -A --field-selector reason=EvictedByVPA -w
# or watch pod churn:
kubectl get pods -A -w | grep -vE 'Running|Completed'
```
In another, keep the quorum services in view — they should NOT restart:
```bash
watch -n5 'kubectl -n vault get pods; echo ---; kubectl -n db-tier get pods; \
  echo ---; kubectl -n rook-ceph get pods | grep -E "osd|mon"; echo ---; kubectl top nodes'
```

**4. Suggested sequence if you want to stage it** (instead of one big sync): comment
all but the low-risk files in `kustomization.yaml`, sync, verify, then uncomment in
waves. Recommended order (least → most disruptive):
   1. `vpa-self-vpa.yaml`, `edge-and-controllers-vpa.yaml` (PDB-guarded multi-replica + tiny singletons)
   2. `argocd-vpa.yaml`, `crossplane-vpa.yaml`, `kyverno-vpa.yaml`, `monitoring-vpa.yaml`
   3. `harbor-vpa.yaml` (registry auth blip — pick a moment with no tenant CI push in flight)
   4. `backstage-vpa.yaml` **last** (1-2 min portal outage; or leave it `Initial`)

**5. Verify convergence.**
```bash
kubectl get vpa -A | grep -v '   Off '     # Auto objects should show PROVIDED=True
# spot-check a resized pod actually got the injected request:
kubectl -n crossplane-system get pod -l app=crossplane \
  -o jsonpath='{.items[0].spec.containers[0].resources.requests}'; echo
kubectl top nodes                            # compare reserved vs step 0
```

**Rollback.** VPA never edits git-owned Deployment specs (RequestsOnly injects at pod
admission), so recovery is just: set the offending object's `updateMode` back to `Off`
(or `git revert` the PR) and delete/recreate the affected pod once — it comes back with
its declared (git) request. If a *node* goes into memory pressure mid-wave, flip
`platform-vpa-policies` to a manual sync (or set the updater back to `--min-replicas=2`)
to freeze further evictions immediately.

## Follow-ups (not in this change)

- **In-place pod resize** (`resizePolicy`, no eviction) needs the
  `InPlacePodVerticalScaling` GA in **Kubernetes 1.33** — a cluster upgrade. Until
  then Auto VPA applies by eviction, hence the stateless-only allowlist.
- Publish the Goldilocks dashboard behind Traefik + OIDC.
- Extend the Auto/RequestsOnly allowlist as more stateless controllers are vetted.
