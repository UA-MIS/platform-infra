# Node disk headroom on the Debian workers (capstone-w1 / capstone-w2)

Written after the 2026-09-03 `capstone-w1` DiskPressure incident, which evicted
three `alloy` pods, the VPA recommender, and both `mychef` CI runner pods —
failing a student team's build at `Initialize containers` with
*"pod failed to come online"*. Their code was fine; the node ate the build.

This page exists because the alert that fired pointed the operator at the wrong
directory. Read the [what actually binds](#what-actually-binds) section before
you start deleting anything.

---

## What actually binds

The kubelet on the Debian workers sets **no `evictionHard`**, so it uses the
upstream defaults. Both workers have a **single root filesystem** (`/dev/sda2`,
ext4, 433 GiB) — `nodefs` and `imagefs` are therefore the *same* filesystem, and
the rule that binds first is:

```
imagefs.available < 15%
```

**not** the `nodefs.available < 10%` that older comments in `alerts.yaml`
claimed. Verified from the kubelet's own eviction message on 2026-09-03:

```
The node was low on resource: ephemeral-storage.
Threshold quantity: 69707516625, available: 67952744Ki
```

`69707516625 / 464716759040 = 15.0%` exactly.

The second consequence of nodefs==imagefs: `imageGCHighThresholdPercent`
defaults to **85** — i.e. image garbage collection kicks in at *the same point*
as eviction. A worker sitting at 15% free is simultaneously evicting pods and
continuously deleting its container image cache, so it can never hold a warm
cache and re-pulls base images on every build.

Observed on 2026-09-03, and it is a clean signature of this state:

| node | root fs free | `/var/lib/containerd` |
|---|---|---|
| capstone-w1 | 15.8% | **16 G** (thrashing) |
| capstone-w2 | 75.3% | **77 G** (healthy warm cache) |

If a worker's containerd directory is *far smaller* than its peer's, that is not
tidiness — it is image-GC thrash, and CI on that node is slower and exposed to
registry rate limits.

### Alert bands

| free on `/` | what happens |
|---|---|
| < 20% | `BuildPoolDiskFilling` (warning) |
| < 17% | `NodeRootFilesystemNearEviction` (**critical**) |
| < 15% | kubelet evicts pods; image GC runs continuously |

The gap between the first warning and first eviction is only 5 percentage
points — about **22 GiB** on a 433 GiB disk. On a node taking nightly backups
that is roughly two nights of warning, not two weeks.

> **The 2026-09-03 lesson is not "we had no alert".** `BuildPoolDiskFilling` had
> been firing continuously for **59.1 hours** before the incident, and
> Alertmanager was delivering it successfully to the `platform-oncall` webhook
> the entire time. Detection worked and delivery worked. What failed was that a
> warning which never escalates reads as background noise. That is why the
> critical band exists, and why the MinIO quotas below exist — the quota does
> not require anybody to read anything.

---

## Find the consumer — in size order, and do not assume CI

The old runbook text said to check `/var/local-path-provisioner/*`. On
`capstone-w1` that directory was **empty**, and an operator who stopped there
would have found nothing. Always start with the whole picture:

```bash
sudo du -sh /var/lib/minio-dr-backup /var/lib/containerd \
            /var/local-path-provisioner /var/log 2>/dev/null | sort -rh
```

What this produced on `capstone-w1`, 2026-09-03 (346 G used of 433 GiB):

```
324.5G  /var/lib/minio-dr-backup    <- 94% of everything used
 16.0G  /var/lib/containerd
  3.7G  /var/log
```

### Why `capstone-w1` holds ~4x `capstone-w2`

It is **not** build scheduling. w1 was running *fewer* pods than w2 (56 vs 113)
at the time of the incident. The entire difference is that w1 hosts the
node-local DR store PV. w1's non-DR usage is ~21 G; w2's is ~107 G.

Do not "rebalance CI away from w1" on the strength of a `du` — check the pod
counts first.

---

## What is inside `/var/lib/minio-dr-backup`

Two buckets, and **the names are misleading**:

| path | size (2026-09-03) | what it actually is |
|---|---|---|
| `velero/kopia/<ns>/` | 261 G | Velero's per-namespace Kopia repos — the real DR data |
| `velero/backups/` | 315 M | backup metadata + resource lists only |
| `dr-backup/` | 64 G | **Thanos long-term metric blocks. Not backups at all.** |

`dr-backup` is the bucket named in `monitoring/thanos-objstore-config`; the ULID
directories with `meta.json` + `chunks/` + `index` are Prometheus TSDB blocks.
It is governed by the Thanos compactor's own retention
(`raw 30d / 5m 180d / 1h 1y`) and is healthy — but it grows toward that 1y
horizon and it is sharing a disk with the kubelet.

### There is no free lunch inside the Kopia repos

Checked and ruled out on 2026-09-03 — do not re-derive these:

- **Kopia maintenance is running and succeeding.** Hourly per repo
  (`maintenanceFrequency: 1h`), `BackupRepository.status.recentMaintenance`
  shows `Succeeded`. There is no large pool of unreferenced blobs to GC; the
  261 G is genuinely *referenced* by the retained backups.
- **No abandoned MinIO multipart uploads.** `.minio.sys` totals 500 K. (Worth
  re-checking after a spate of `Canceled` uploads, but it was clean here.)
- **`nvme0n1` on w1 is NOT free space.** It is a live Ceph BlueStore OSD
  (`blkid` → `TYPE="ceph_bluestore"`, `rook-ceph-osd-3`). **Never** reformat it.
- **`sda3` (24 G) is swap**, and swap is disabled (`failSwapOn: true`). Small
  and not worth an online root-partition resize.

So on this node the only levers are: store less, or cap what can be stored.

---

## Safe reclaim that deletes no backups

In the order worth doing:

1. **Vacuum and cap the journal.** `/var/log/journal` had grown to 3.4 G.
   ```bash
   sudo journalctl --vacuum-size=200M
   ```
   Made permanent in the Ansible worker role via
   `/etc/systemd/journald.conf.d/10-capstone-cap.conf`
   (`SystemMaxUse=200M`, `SystemKeepFree=2G`).

2. **Clear terminal pod objects.** These leave `/var/log/pods` and
   `/var/lib/kubelet/pods` directories behind, and — more importantly — every
   one of them is an item in the next nightly backup.
   ```bash
   kubectl delete pods -A --field-selector status.phase=Failed
   kubectl delete pods -A --field-selector status.phase=Succeeded
   ```
   There were **323** of them cluster-wide on 2026-09-03 (187 `Evicted` on w1
   alone), and Velero was dutifully backing up their pod specs every night.

Together these recovered ~3.4 GiB and took the margin above the eviction line
from **0.55 GiB to 3.88 GiB**. That stops immediate bleeding. It does not fix
anything — see below.

---

## Making it not come back

### 1. Retention (implemented in `applicationsets/velero-app.yaml`)

30 daily fulls of a ~14k-item cluster was the root cause. The footprint is
driven by *snapshot count x poor dedup*, not by data volume — see the measured
per-namespace multiplier table in that file's comments. Vault's 2.7 GiB of real
state cost 44 G because a live BoltDB file is nearly all-new content every
night.

### 2. MinIO bucket quotas — the part that does not need a human

`local-hostpath` does not enforce the PV's declared capacity, which is why a
volume declared `200Gi` was holding 324.5 G. MinIO's own hard bucket quota does
enforce, at the application layer, with no filesystem change and no reboot.

**Verified to actually bind** on 2026-09-03 (this is the whole point — an
unenforced quota is worse than none):

```
$ mc quota set m/quota-probe --size 1MiB
Successfully set bucket quota of 1.0 MiB on `quota-probe`
$ mc cp /tmp/blob.bin m/quota-probe/blob.bin     # 3 MB object
mc: <ERROR> Failed to copy `/tmp/blob.bin`. Bucket quota exceeded
$ mc ls m/quota-probe
                                                  # empty — nothing partial left
```

Both real buckets are currently **unlimited** (`mc quota info` → `quota of 0 B`).

```bash
mc quota set m/velero    --size 240GiB
mc quota set m/dr-backup --size 70GiB
```

**Set these only AFTER retention has brought `velero` below the ceiling** — a
quota below current usage fails every write immediately. With 261 G currently in
`velero`, applying a 240 GiB quota today would break tonight's backup.

The trade this makes, stated plainly: at the ceiling, **the backup fails loudly
instead of the node failing silently**. A failed backup is a `VeleroBackupStale`
critical alert and one missing restore point. A full node is evicted student CI,
evicted log collection, and a worker that cannot hold an image cache. The first
is strictly preferable, and it is the whole reason to prefer a quota over an
alert.

### 3. Sizing the ceiling

Root fs is 433 GiB. Non-DR usage on w1 is ~21 GiB. To stay above the **20%**
warning line the two buckets must together stay under:

```
433 - (0.20 x 433) - 21  ~=  325 GiB
```

which is *exactly* where the store already was — i.e. at 30-day daily retention
the node had **zero** growth headroom left. The 240 + 70 = 310 GiB pair above
leaves a real margin; adjust both together if you move the retention dial.

---

## Known gaps this incident exposed (not yet fixed)

- **Vault's raft snapshots are not backed up.** The `vault-raft-snapshot`
  CronJob writes to the `vault-snapshots` PVC at 03:00 and its pod is
  `Succeeded` by the time Velero runs at 04:00 — and Velero's file-system backup
  **skips volumes of non-running pods**. Result: `vault-snapshots` has **0**
  PodVolumeBackups across all 29 retained backups, while 44 G of
  crash-inconsistent live BoltDB copies *are* retained. The header of
  `velero-app.yaml` states the 04:00 schedule was chosen to run *after* the
  03:00 raft snapshot — that intent is silently unmet. Fix requires a
  long-lived pod mounting the PVC, or moving the snapshots to object storage
  directly.
- **`--default-volumes-to-fs-backup` backs up ~200 ephemeral volumes a night**
  (`tmp`, `var-run`, `var-cache-nginx`, `scratch`, `plugins`, kopia maintenance
  job pods' own volumes) against only ~56 real PVC-backed volumes. This is what
  pushes the nightly run into its 4h `ItemOperationTimeout`, after which Velero
  **cancels** in-flight PodVolumeBackups — on 2026-09-03 that cancelled 20 of
  them, including `ss-evan-and-emily-vm-prod` disks on other nights. Moving to
  the opt-in model (`defaultVolumesToFsBackup: false` plus explicit
  `backup.velero.io/backup-volumes` annotations) is the correct fix but must be
  done carefully: a missed annotation silently stops protecting a volume, which
  is exactly how the Vault gap above happened.
- **Observability volumes are backed up but reconstructible.**
  `thanos-compactor` (working dir) and `thanos-store-gateway` (index cache) are
  100% rebuildable, and Prometheus TSDB is already shipped durably to Thanos.
  They are a large share of the 108 G `monitoring` repo.
- **The `deadmansswitch` receiver is broken.** Alertmanager logs
  `open /etc/alertmanager/secrets/alertmanager-webhook/deadmansswitch-url: no
  such file or directory` every minute — the `alertmanager-webhook` secret has
  only a `url` key. This does not affect `platform-oncall` delivery, but it
  means the dead-man's switch that is supposed to tell you monitoring itself has
  died has never worked.

---

## Verifying a restore actually works

Phase strings are not evidence, in either direction. On 2026-09-03 most backups
showed `PartiallyFailed` — but with `itemsBackedUp == totalItems` and only 1-15
errors out of ~14,000 items, nearly all of them benign "skipped a volume on a
`Succeeded` pod" warnings. **A `PartiallyFailed` backup restored perfectly.**

Conversely, item counts count *Kubernetes resources*, not volume data — a backup
can show 13,913/13,913 items and still have had its PodVolumeBackups cancelled.
Always check volume-level status:

```bash
kubectl -n velero get podvolumebackups.velero.io -o json \
  | jq -r '.items[] | "\(.metadata.labels["velero.io/backup-name"]) \(.status.phase)"' \
  | sort | uniq -c
```

To prove a restore end-to-end, restore into a scratch namespace (never over the
live one) and diff against ground truth:

```bash
velero restore create drverify-slides-$(date +%Y%m%d) \
  --from-backup <backup-name> \
  --include-namespaces slides \
  --namespace-mappings slides:slides-drverify \
  --exclude-resources ingresses.networking.k8s.io,externalsecrets.external-secrets.io,\
secretstores.external-secrets.io,nodes,events,events.events.k8s.io,\
backups.velero.io,restores.velero.io,csinodes.storage.k8s.io,\
volumeattachments.storage.k8s.io,backuprepositories.velero.io
```

Excluding `ingresses` matters: a namespace-mapped copy that keeps its Ingress
will claim the same hostname as the live one.
