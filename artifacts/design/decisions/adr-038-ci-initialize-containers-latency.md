# ADR-038 — CI `Initialize containers` latency: runner spread, and the externals-copy tax

- **Status:** Accepted (spread + maxPods + storage swap all implemented)
- **Date:** 2026-08-25
- **Deciders:** platform owner (ccsmith33)
- **Related:** #535 (ARC ResourceQuota/LimitRange), #372 (soft RAM-aware affinity), #374 (CI node taint), ADR-031 (Crossplane onboarding)

---

> ### ⚠ #540 removed the CLIFF, not the TAX. Do not read it as a performance fix.
> Spread stopped jobs **hanging and failing** at a node's pod ceiling. It did **not** make
> `Initialize containers` faster. Verified on a real 5-job rerun after #540 merged:
> `python 162s · migrations 189s · chart 181s · frontend 132s · task-schema 60s` — **worse**
> than the ~107s baseline, because runners spread onto cold control-plane nodes. The ~47s
> figure quoted elsewhere in this ADR is an **idle-node benchmark**, not a prediction for
> concurrent load. **Only the storage swap (§3, §5) moves the tax.**

## 1. Context

Every GitHub Actions job on the platform spent ~107s in `Initialize containers` while the
actual work took 0–1s. On 2026-08-25, under 8-way concurrency, this degraded into a hard
outage: five `ida-llm` jobs sat in `Initialize containers` for **11m18s** and then failed
with `Executing the custom container implementation failed`, with **zero** workflow pods
ever created.

Ruled out with evidence: runner cold start (queued→started 13s), image pulls (`already
present on machine`), Ceph PVC provisioning (`Provisioning`→`ProvisioningSucceeded` ~1s),
namespace quota (8/40 pods, 2/20 CPU), admission/Kyverno denials (none), and GitHub-side
health (job leases renewing normally).

## 2. What the measurement actually found

Two independent causes compound.

### 2a. The steady-state tax: `copyExternalsToRoot()`

Read from the hook source inside the running production image
(`ghcr.io/actions/actions-runner:2.335.1`), `prepareJob` is:

```
prunePods() → copyExternalsToRoot() → createPod() → waitForPodPhases()
```

The copy is **unconditional, blocking, exposes no configuration knob, and runs BEFORE the
workflow pod is created**. It exists because the runner pod and the workflow pod are
separate pods whose only shared surface is the `work` volume, so the runner's `externals/`
(its node binaries) must be staged there for the job container to use.

Measured live inside a wedged runner:

| Quantity | Value |
|---|---|
| `/home/runner/externals` | **594 MB / 8,986 files** (node24 202M, node20 167M, node24_alpine 126M, node20_alpine 101M) |
| `/home/runner/_work/externals` on `/dev/rbd17` | growing 166 → 267 → 385 MB over ~2 min |
| Effective rate under 8-way concurrency | ~2.5–3 MB/s |

Benchmark of the identical 594 MB / 8,986-file tree, real runner image, **idle** node
(capstone-w2), two passes each:

| Target | Pass 1 | Pass 2 |
|---|---|---|
| Ceph RBD (`ceph-block`) | 49.4 s | 45.5 s |
| Node-local disk | 14.9 s | 10.8 s |

**~47 s → ~13 s (3.6×) with zero contention**, and the gap widens sharply under load.

### 2b. The outage: runner spread drift → node pod-ceiling → `OutOfpods`

`podAntiAffinity` (the soft per-node spread) was present in the org-wide scale set
(`applicationsets/arc-runner-scaleset-app.yaml`) and in the Kaniko step pod
(`platform-services/arc/hook-template.yaml`), but was **dropped when the nodeAffinity tiers
were copied into the Crossplane composition**. Every *tenant* pool (`ida-llm-kaniko`,
`crimson-copies-kaniko`) therefore ran with **no spread signal at all**.

Compounding it, pod **count** is not a scheduler scoring input, and ImageLocality wins every
tiebreak for the node that already has the runner/Kaniko images. Result: all 8 `ida-llm`
runners stacked onto `capstone-w1`, taking it to **110/110 pods** (`capstone-w2` sat at 65).

Why that produces *absent* rather than *Pending* workflow pods — the non-obvious part:
**the ARC hook sets `appPod.spec.nodeName` directly**, bypassing the scheduler. A
nodeName-pinned pod on a full node is rejected by the **kubelet**, not queued:

```
Failed | OutOfpods | Pod was rejected: Node didn't have enough resource:
pods, requested: 1, used: 110, capacity: 110
```

(Reproduced directly with a probe pod pinned to `capstone-w1`.) In the observed outage the
hook had not even reached `createPod` — it was still inside the externals copy, which is why
the job log shows 11m18s of *total silence* rather than repeated pod-creation errors.

## 2c. The cap was reasoned in the wrong unit (owner correction, refined)

`maxRunners` was sized against **cluster-wide CPU/memory** ("80 vCPU / ~216GiB across 5
nodes … 4-8% cluster CPU"). The binding constraint is the **per-node kubelet pod ceiling**,
which was never modelled.

The owner's correction was that a job consumes a *pair* of pod slots on one node. Measured,
it is worse than that — **up to three**:

| # | Pod | Pinned by |
|---|---|---|
| 1 | runner pod | the scale set |
| 2 | workflow pod (the job's `container:`) | hook `createPod()` → `spec.nodeName` |
| 3 | container-step pod, per `uses: docker://` step (Kaniko, scanners, toolchains) | hook `createJob()` → `job.spec.template.spec.nodeName` |

The RWO `_work` PVC co-pins them regardless. The existing "pair" language in
`arc-runner-scaleset-app.yaml` (job-container + Kaniko step = 8Gi) counts only #2 and #3 —
it **omits the runner pod**. So `maxRunners: N` ⇒ **up to 3N pods on one node**.

Because all three are `nodeName`-pinned they bypass the scheduler, so a node at its ceiling
**rejects** them (`OutOfpods`, phase Failed) instead of queueing them Pending — the cliff
described in §2b.

### Measured headroom (2026-08-25, allocatable 110/node)

**CORRECTION (2026-08-25, verified live):** an earlier reading held that CI was fenced to
`pool=build` (w1+w2) because n1–n3 supposedly lacked the standard control-plane label. That is
**wrong** — `kubectl` confirms n1/n2/n3 all carry `node-role.kubernetes.io/control-plane`, so the
second `nodeSelectorTerm` (`control-plane Exists`) **does** match and the candidate set is **all
five nodes**. Headroom is therefore materially better than the w1+w2-only figures below imply.
Those figures are retained as the *observed* state during the incident, not as a fence.

| Node | Non-terminal pods | Headroom | Jobs at 3 pods/job |
|---|---|---|---|
| capstone-w1 | 103 / 110 | **7** | **~2** |
| capstone-w2 | 63 / 110 | 47 | ~15 |

Velero's hourly kopia-maintenance burst (~34 pods, landing disproportionately on w1) moves
w1's baseline by up to ~23 pods with no CI involvement at all.

### Sizing rule

Spread is `ScheduleAnyway` (soft) and ImageLocality biases toward the warm node, so size
against the **worst** pool node, not the average:

```
ceil(N_pool_total / n_build_nodes) * 3  ≤  min(per-node headroom) − burst_margin
```

Today's live 8/8/4 = 20 concurrent jobs ⇒ **up to 60 pods** against **54** pool-wide
headroom, most of it stranded on the node with 7 free slots. The arithmetic does not
support it.

**Recommended until w1 is rebalanced: ida-llm 4 / crimson-copies 4 / ua-mis 2** (aggregate
~10 jobs ≈ 30 pods). Restoring 8/8/4 is fine once w1's baseline approaches w2's, or once
`maxPods` is raised — re-derive with the rule above rather than guessing.

**The `arc-runners` ResourceQuota (`pods: 40`) was itself sized on pair math**: at 3 pods/job
it admits ~13 jobs, not the 20 that 8/8/4 permits. It is a cluster-wide backstop only — it
never modelled the per-node dimension that actually wedged us.

> The caps are not the root problem. **w1 carrying 103 pods against w2's 63 is.** Lowering
> `maxRunners` is a tourniquet; rebalancing that baseline is the fix.

## 3. Decision

**Accepted and implemented here — restore and strengthen runner spread.** Add to all three
runner definitions, kept in sync:
1. the missing `podAntiAffinity` soft spread (composition + per-team template), and
2. a `topologySpreadConstraints` with `maxSkew: 2`, `whenUnsatisfiable: ScheduleAnyway`,
   which bounds pod-count skew explicitly rather than relying on a score that ImageLocality
   outweighs. `ScheduleAnyway` keeps it a preference, so a single-node pool or an
   over-pool-size burst still schedules instead of hanging Pending.

**Accepted and implemented — move the ARC work volume to a node-local StorageClass.**
Evidence supports it (3.6× on an idle node, far more under load) and the co-scheduling
constraint is *not* a blocker: the hook pins the workflow pod to the runner's node itself,
so a node-affine RWO volume binds correctly by construction. Held back because it requires
installing a new cluster-wide provisioner (`local-path-provisioner`), whose per-volume
create/delete **helper pods add pod churn to the very nodes that just hit a pod ceiling** —
that interaction must be settled first. See §5.

## 3a. Storage swap — as built

New platform service `platform-services/local-path-provisioner/` (picked up automatically by
the `platform-services/*` directory generator), providing StorageClass **`local-path-ci`**.
It is **not** the cluster default — `ceph-block` keeps that role; only the three ARC
`kubernetesModeWorkVolumeClaim` definitions opt in.

| Decision | Why |
|---|---|
| `volumeBindingMode: WaitForFirstConsumer` | Load-bearing. The runner pod is the first consumer, so the PV is created on the node the scheduler picked for it. ARC then pins the workflow pod (`createPod`) and every `uses: docker://` step pod (`createJob`) to that same node. With `Immediate` the PV could land elsewhere and wedge every job. |
| **RWO retained** | The job-container + Kaniko-step co-pinning argument that sizes their 4Gi requests depends on it, and node-local RWO binds correctly *by construction* here. No reason to touch it. |
| `nodePathMap` → `/var/local-path-provisioner` | The one path writable on **both** node families. Talos (n1–n3) has a read-only root; `/var` is its writable partition — verified live with a hostPath probe on capstone-n1 (wrote, read back, removed; `/dev/nvme0n1p4`, 442G free) before choosing it. |
| Covers **all five** nodes, not just the build pool | Routine CI is kept off n1–n3 (#541), but they remain a genuine fallback. A node the runner can land on but the provisioner cannot serve would hang the PVC Pending — reintroducing exactly the wedge #540/#541 removed. |
| Helper-pod image from the Harbor pull-through cache | Platform egress is :443-to-Harbor; Docker Hub rate limits have bitten this cluster before. Pull verified through the proxy. |
| Helper pod tolerates `node.kubernetes.io/disk-pressure` | Teardown is `rm -rf`. If the helper could not schedule under disk pressure, the node could never reclaim space — a deadlock precisely when it matters most. |

### Cost: helper-pod churn

`local-path-provisioner` runs one short-lived helper pod per volume **create** and one per
**delete**. Against the corrected triple multiplier, a pool running N concurrent jobs peaks at
`3N` steady pods **plus up to 2 transient helpers per job**. At the live 8/8/4 that is a
worst case of ~60 steady + ~40 transient. With `maxPods` now 200 on both workers (~400 slots
against ~166 used) there is real room; at the previous 110 ceiling this change would have
been unsafe. **Sequencing mattered.**

### Regression accepted, with a compensating control

`ceph-block` gave each job a real 5Gi RBD **block device** — a runaway build hit `ENOSPC`
inside its own volume and failed alone. `local-path` is a **directory on the node root
filesystem** and does **not** enforce the PVC's requested size, so `storage: 5Gi` is now
**nominal**. A runaway build can pressure the *node* and trigger DiskPressure evictions for
unrelated pods. capstone-w1 was already at 64% used / 150G free when this landed.

Compensating control: the **`BuildPoolDiskFilling`** alert (`platform-services/monitoring/alerts.yaml`)
fires at <20% free, ahead of the kubelet's 10% eviction threshold. This is a deliberate trade
of hard size enforcement for ~35s per job, not an oversight.

## 4. Consequences

- Tenant pools regain the spread the platform pool always had; no pool can silently pack one
  node to its ceiling.
- `Initialize containers` is **not** fixed by this ADR — it remains ~47s of externals copy at
  low concurrency. This change removes the *cliff* (hang/failure), not the *tax*.
- The three `containerMode.kubernetesModeWorkVolumeClaim` copies remain bound by comment
  only; a CI sync check for composition↔blueprint drift is still missing and is exactly the
  failure mode that caused 2b. Recommend adopting the `ci-scripts-sync-check.yaml` pattern.

## 5. Open items

| Item | Note |
|---|---|
| ~~Node-local StorageClass~~ **DONE** | Implemented as `local-path-ci`; see §3a. |
| Trim `externals` | node*_alpine is 227 MB (38%) and is only needed for Alpine job containers; requires a derived runner image and per-release maintenance. |
| Node imbalance (w1 103/110 vs w2 63/110) — THE root capacity issue, see §2c | Descheduler is effectively inert here: `thresholds.pods: 20` means n1–n3 (~25%) never qualify as under-utilized, `targetThresholds.pods: 50` means w2 (59%) is not a valid destination, `PodsWithPVC` protection exempts most tenant pods, and `maxNoOfPodsToEvictTotal: 5`/hour cannot correct a 41-pod skew. |
| 34 Velero `kopia-maintain` pods | `keepLatestMaintenanceJobs: 1` is already minimal and deliberate (breadcrumb); the problem is that all 34 land on one node. Spread, not TTL, is the fix. |
| `capstone.io/ci-build=true` preference | Matches **no node** — a live no-op. Either label the dedicated CI node or drop the weight-100 rule. |
| Control-plane placement | #540's spread treated all 5 nodes as equal domains and put runners on n1-n3 — against the owner's preference, and measurably slower. Fixed by dropping the control-plane toleration + `nodeTaintsPolicy: Honor`, which removes n1-n3 from spread **domains** while `PreferNoSchedule` keeps them **schedulable** as fallback. |
| ~~`maxPods: 110`~~ **DONE** | Raised 110→200 on both Debian workers 2026-08-25. Durable in `ansible/roles/kubelet_join/templates/kubelet-config.yaml.j2` (Ansible-managed; a hand-edit would be reverted). Applied w2-first as canary, then w1: kubelet active with 0 restarts and zero error-priority log entries on both, nodes Ready, `/configz` + node capacity both report 200, w1 running pods 101→101 (none lost). Build pool now ~400 slots vs ~166 used. |
