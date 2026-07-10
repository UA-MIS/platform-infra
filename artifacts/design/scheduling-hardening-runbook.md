# Scheduling hardening — Vault / Prometheus / DB-replica noisy-neighbor (runbook)

## Incident this closes

`mac-debian-01` (4c/8GB Intel Mac Mini worker) simultaneously hosted the **Vault
raft leader** (`vault-0`), **Prometheus** (`kube-prometheus-stack`, ~178-469m CPU /
~2.1-2.6GB RAM), a **CNPG Postgres replica** (`capstone-pg-3`), and a **MariaDB/Galera
replica** (`capstone-mariadb-mariadb-cluster-2`) — all fsync-sensitive on the same
overlay-attached Ceph RBD path, on the smallest node class in the fleet. A Cilium
policy-recalc loop saturated that node; Vault's raft snapshots stalled 2s → 23min and
ESO logins timed out. The incident itself is resolved — this PR reduces the odds of
recurrence by changing **future scheduling preferences**, not by moving anything at
merge time (except where noted below).

## Root cause is structural, not luck

Vault (3 pods) and the CNPG Cluster (3 instances) each carry their own **required**
one-pod-per-node anti-affinity, and MariaDB/Galera (3 pods) carries the operator's own
`antiAffinityEnabled: true`. There are exactly **3 Mac-Mini-class (4c/8GB) workers**
(`mac-debian-01/02/03`) currently eligible for general workloads at that resource
class. With 3 independent "exactly one per node" rules and only 3 such nodes, **every
Mac Mini structurally hosts one Vault pod, one CNPG instance, and one MariaDB replica
at all times** — that triad's mutual co-location cannot be fixed by adding more
anti-affinity rules between the three of them; it needs a 4th HA-eligible worker
(tracked as a follow-up, out of scope here — see "Deferred" below).

**What is fixable now:** Prometheus (and nothing else touched here) does not need to
be on one of those 3 nodes at all, and moving it is low-risk. That's the actual lever
this PR pulls.

## Live placement at the time of this PR (2026-07-09, `kubectl get pods -o wide`)

| Node | Role | Alloc CPU/Mem | Running fsync-critical / heavy pods |
| --- | --- | --- | --- |
| `mac-debian-01` | worker, 4c/8GB | 57%/85% requests, 70%/76% actual | `vault-0`, `prometheus-kube-prometheus-stack-prometheus-0`, `alertmanager-...-0`, `capstone-pg-3`, `capstone-mariadb-mariadb-cluster-2`, Rook-Ceph mgr/csi | **the incident node** |
| `mac-debian-02` | worker, 4c/8GB | 15%/63% actual | `vault-2` |
| `mac-debian-03` | worker, 4c/8GB | 15%/63% actual | `vault-1`, `capstone-mariadb-mariadb-cluster-0` |
| `capstone-n1/n2/n3` | control-plane, 15.9c/15GB, `PreferNoSchedule` (soft) taint | ~8-9%/64-66% actual | `vault-unsealer-0` (n3), one MariaDB replica (n3), Alloy/node-exporter DaemonSets |
| `ua-mis-db-1` | worker, 4c/8GB, untainted | 10%/32% actual | Grafana, MariaDB metrics exporter, Alloy — **the least-loaded node in the fleet** |

`vault-0` (main Vault, leader at last check) and Prometheus are on the **same node
today**. That is exactly the condition this PR makes the scheduler prefer to avoid
going forward.

## What changed (3 files, all `preferred`/additive — nothing `required`)

1. **`applicationsets/kube-prometheus-stack-app.yaml`** — `prometheus.prometheusSpec.affinity`:
   soft (`preferredDuringSchedulingIgnoredDuringExecution`) pod anti-affinity, weighted
   away from Vault server pods (weight 80), CNPG instances (weight 60), and MariaDB
   pods (weight 60). Also sets `podAntiAffinity: ""` — **required**, because the chart's
   `prometheus.yaml` template has two independent `if` blocks that both write into
   `spec.affinity`; leaving the chart's `podAntiAffinity: "soft"` default in place
   produces a **duplicate `podAntiAffinity:` map key** and the chart's own default term
   silently wins (last-key-wins on unmarshal), discarding ours entirely. Caught by
   rendering the chart with `helm template` — see "Verification" below.
2. **`applicationsets/vault-app.yaml`** — added a `preferredDuringSchedulingIgnoredDuringExecution`
   term to Vault's existing (untouched) hard self-anti-affinity, steering Vault pods
   away from Prometheus. Symmetric protection: the Prometheus-side rule only helps if
   Prometheus schedules after Vault; this half covers a future Vault pod restart
   landing on whatever node Prometheus is on.
3. **`platform-services/cnpg/cluster/cluster.yaml`** — added `additionalPodAntiAffinity`
   (CNPG's API explicitly documents this as *additive* to the existing required
   self-anti-affinity, not a replacement — safe to layer), soft-preferring nodes without
   a Vault pod (weight 80) or Prometheus pod (weight 60).

**Not changed:** `applicationsets/mariadb-cluster-app.yaml`. The mariadb-operator CRD
exposes both a convenience `antiAffinityEnabled: true` bool (already on) and a raw
`podAntiAffinity` field, but — unlike CNPG's explicitly-additive API — the operator's
own docs describe the raw field as an *alternative* to the bool, not something layered
on top of it. Guessing wrong here risks the Galera cluster's real HA guarantee (a
misconfigured anti-affinity could let 2 of 3 Galera pods land on one node, so a single
node loss costs quorum) — that is a worse outcome than the noisy-neighbor problem being
fixed. Left as a follow-up requiring a verified test (e.g. a non-prod MariaDB CR) before
touching it. See "Deferred" below.

## What reschedules on apply, and in what order

Merging this PR and letting ArgoCD sync (`automated: {prune: true, selfHeal: true}` on
all three apps) patches the live `Prometheus`, `StatefulSet vault`, and `Cluster
capstone-pg` objects. What happens next differs **per workload's own update strategy**
— verified live, not assumed:

| Object | Update strategy (verified live) | Effect of this PR's sync |
| --- | --- | --- |
| `Prometheus` CR → `StatefulSet prometheus-kube-prometheus-stack-prometheus` | `RollingUpdate` | **Automatic.** The Prometheus Operator patches the StatefulSet pod template; Kubernetes immediately terminates and reschedules `prometheus-...-0` under the new affinity. No human action needed. TSDB is on a Ceph RBD PVC — it just reattaches wherever the pod lands (most likely `ua-mis-db-1`, the least-loaded, untainted node; a control-plane OptiPlex node is the fallback if `ua-mis-db-1` scores worse for some other reason). Expect **~30-90s of Prometheus/Grafana scrape gap**; Alertmanager and the TSDB itself are unaffected. |
| `Cluster capstone-pg` → CNPG-managed instance pods | `primaryUpdateStrategy: unsupervised` (CNPG default, confirmed live) | **Automatic, but this is CNPG's normal supported rolling-update path** (the same mechanism used for every routine Cluster spec change): replicas restart first under the new affinity, catch up via streaming replication, then CNPG performs an automatic switchover of the primary last. Zero data loss by design; a few seconds of primary unavailability during the switchover, same as any other CNPG spec change. This is **not** the same risk class as the Vault raft concern below — CNPG's automatic failover is the whole point of running it in HA. |
| `StatefulSet vault` | `OnDelete` (confirmed live) | **Nothing moves automatically.** The chart's `updateStrategy: OnDelete` means ArgoCD/Helm can patch the StatefulSet spec all day and no Vault pod restarts until a human explicitly deletes one. This is what makes it safe to merge and sync this PR today without touching live Vault topology — the new soft anti-affinity only takes effect the *next* time a Vault pod restarts for any reason (upgrade, drain, OOM, or a deliberate future rebalance). |
| `MariaDB` CR | n/a — not touched by this PR | No change, no reschedule. |

**Net effect of merge + sync, today:** Prometheus moves (safe, automatic). CNPG's 3
Postgres pods do a normal rolling restart + one primary switchover (safe, automatic,
CNPG's routine operation). **Vault does not move** unless a human deletes a Vault pod
in a separate, supervised step.

## Safe apply order

1. **Pre-check `vault-unsealer` health before touching anything Vault-related**,
   regardless of when: `kubectl -n vault-unsealer get pods` (expect `1/1 Running`) and
   check Alertmanager/Grafana for the generic `KubeStatefulSetReplicasMismatch` mixin
   alert (kube-prometheus-stack's bundled default rules, `defaultRules.create: true`)
   scoped to `vault-unsealer` — there is no unsealer-specific alert by name, this
   generic one is what would fire on a stuck rollout. Confirmed healthy at the time of
   writing (`vault-unsealer-0` 1/1 Running, age 12d). If it is NOT healthy, fix that
   first — the main Vault's transit auto-unseal depends on it, and step 4 below
   requires every Vault pod to be able to auto-unseal on restart.
2. **Merge this PR, let ArgoCD sync all three apps** (`platform-vault`,
   `platform-kube-prometheus-stack`, `platform-cnpg-cluster`). This applies the new
   preferences for *future* scheduling and is itself low-risk per the table above:
   - Prometheus reschedules automatically within the sync (~30-90s scrape gap).
   - CNPG's 3 instances do their normal rolling restart + one automatic switchover
     (routine CNPG behavior, not a special risk introduced by this PR).
   - Vault pods do **not** move (OnDelete strategy).
3. **Verify Prometheus landed off the Vault/DB-heavy nodes:**
   `kubectl -n monitoring get pod -l app.kubernetes.io/name=prometheus -o wide` — expect
   it NOT on `mac-debian-01/02/03` (most likely `ua-mis-db-1`). Confirm Grafana/Alertmanager
   are unaffected and no alerts fired from the brief scrape gap.
4. **Only if you also want to fail Vault off its current node** (e.g. `vault-0` is
   still co-located with something undesirable, or you want to fully prove the new
   preference end-to-end): this is a **separate, supervised step**, not part of the
   PR's automatic sync. Do this only after step 1's pre-check is re-confirmed green:
   ```bash
   kubectl -n vault-unsealer get pods            # re-confirm 1/1 Running immediately before
   kubectl -n vault get pods -o wide              # note which vault-N is on which node, and the current leader
   kubectl -n vault exec -it vault-0 -- vault operator raft list-peers   # confirm current leader
   kubectl -n vault delete pod <target-vault-pod> # triggers raft failover if it's the leader; pod restarts,
                                                    # auto-unseals via transit against vault-unsealer (no Shamir
                                                    # typing — see vault/README.md §A), rejoins raft
   kubectl -n vault get pods -w                    # watch it come back 1/1
   kubectl -n vault exec -it vault-1 -- vault operator raft list-peers   # confirm quorum intact, new leader if it moved
   ```
   Delete **one Vault pod at a time**, confirm `1/1 Running` and quorum before touching
   the next — same discipline as `vault/README.md` §G's existing HA rollout runbook.
   Do not delete more than one Vault pod within the same maintenance window.

## Rollback

All three changes are additive/soft (`preferred...`, plus CNPG's explicitly-additive
`additionalPodAntiAffinity`) except the `podAntiAffinity: ""` override on the
Prometheus values, which only suppresses a chart default that was inert with
`replicas: 1` anyway. Reverting the PR and re-syncing removes the preferences; nothing
about it is a one-way door. If Prometheus lands somewhere undesirable after the sync,
it can be nudged again with a further-adjusted `weight` or by cordoning a node — no
data loss risk (TSDB PVC persists independent of which node the pod lands on).

## Deferred (not in this PR's scope)

- **The Vault/CNPG/MariaDB triad's mutual co-location** (one of each, always, on every
  Mac Mini) is structural given only 3 HA-eligible nodes at that resource class and 3
  independent required one-per-node rules. Fixing it needs a 4th HA-eligible worker
  node, or relaxing one of the three CRs' `required` anti-affinity to `preferred`
  (not recommended — that's exactly the quorum-loss risk those `required` rules exist
  to prevent).
- **MariaDB/Galera anti-affinity vs. Vault/Prometheus** — deferred pending verification
  of whether `mariadb.affinity.podAntiAffinity` merges with or overrides
  `antiAffinityEnabled: true` in the mariadb-operator controller (undocumented/ambiguous
  from the CRD alone; the operator's own docs suggest it may be an alternative, not
  additive). Test in a non-prod MariaDB CR before applying to `capstone-mariadb`.
- **Alertmanager** (small, ~48-96Mi) was not given the same anti-affinity treatment as
  Prometheus — low value for the added diff size given it's not the heavy fsync-adjacent
  workload named in the incident. Trivial follow-up if desired, same pattern as
  Prometheus above.

## Verification performed (this PR, no cluster writes)

- `applicationsets/vault-app.yaml`, `applicationsets/kube-prometheus-stack-app.yaml`:
  parsed as YAML, the embedded Helm `values:` block re-parsed as YAML on its own, and
  each rendered with `helm template <chart> <version> -f <extracted values>` against the
  exact pinned chart versions already in use (`hashicorp/vault` 0.33.0,
  `kube-prometheus-stack` 87.3.0). Confirmed the rendered `StatefulSet`/`Prometheus`
  objects carry exactly the intended `affinity` — this is how the Prometheus chart's
  duplicate-`podAntiAffinity`-key bug (above) was caught and fixed before merge.
- `platform-services/cnpg/cluster/cluster.yaml`: rendered via `kubectl kustomize`
  (succeeds), and schema-checked with `kubectl apply --dry-run=client` against the
  live cluster's installed CNPG CRD (accepted, no rejection of `additionalPodAntiAffinity`).
  Same `--dry-run=client` check run against both edited `Application` manifests against
  the live ArgoCD CRD (accepted). `--dry-run=client` performs no cluster write.
- Cross-checked all label selectors used in the new rules (`app.kubernetes.io/name:
  vault` + `component: server` for Vault, `app.kubernetes.io/name: prometheus` for
  Prometheus, `cnpg.io/podRole: instance` for CNPG, `app.kubernetes.io/name: mariadb`
  for MariaDB) against the actual live pod labels (`kubectl get pod --show-labels`) —
  including confirming `vault-unsealer` pods also carry `app.kubernetes.io/name: vault`
  / `component: server` (same chart, different release name), so the Vault-side
  selectors intentionally also cover the unsealer.
