# Disaster-recovery backups (MinIO + Velero)

The platform previously had **no off-cluster (or even off-Ceph) backup at all** — it
survived a real power outage largely by luck. This closes that gap: every namespace's
Kubernetes objects **and** PV data are backed up nightly, onto storage that is
deliberately **outside** the Rook-Ceph data path.

GitOps surfaces:
`platform-services/minio/` (the object store), `platform-services/velero/` (Velero's
namespace + SealedSecrets), `applicationsets/velero-app.yaml` (the Velero Helm
Application), `hardening/netpol-controlplane/minio-netpol.yaml` (network
restriction on the store, MANUAL-SYNC — see below). `applicationsets/minio` is
**not** a separate Application — MinIO is plain manifests picked up by the
`platform-services` ApplicationSet (`platform-svc-minio`), same as Dex/cloudflared/
vault-unsealer.

---

## ⚠⚠⚠ THE MINIO DISK IS THE CROWN JEWELS ⚠⚠⚠

**Read this before touching MinIO.** Because the nightly schedule backs up **every
namespace's Kubernetes Secrets** (`includedNamespaces: ["*"]`, only `minio` itself is
excluded — `applicationsets/velero-app.yaml`), the `velero` bucket on
`mac-debian-01`'s local disk (`/var/lib/minio-dr-backup`) is, in aggregate, a copy of
**every credential this platform has**: Harbor robot tokens, the Dex/OIDC client
secrets, Vault's own unseal material to the extent it's stored as a Secret, and —
critically — **the sealed-secrets controller's own signing key**. Anyone who reads
that key can decrypt **every SealedSecret in this entire git repo**, past and future.

That makes this disk (and the MinIO root/IAM credentials that unlock it) more
sensitive than almost anything else on the platform. Treat it accordingly:

- The backup **content** (the actual repository objects Kopia writes) is encrypted
  with the password in the `velero-repo-credentials` SealedSecret
  (`platform-services/velero/sealedsecret-repo-credentials.yaml`) — a strong,
  randomly-generated password sealed **before** Velero's first run, specifically so
  Velero never falls back to its well-known upstream default
  (`static-passw0rd`, see that file's header). Losing/rotating this password
  incorrectly can make existing backups **permanently unreadable** — see the
  file's no-rotate-after-first-backup caveat.
- **Network** access to the MinIO Service is restricted to Velero only
  (`hardening/netpol-controlplane/minio-netpol.yaml`) — same MANUAL-SYNC,
  default-deny posture as Vault/ArgoCD/Dex (`hardening/netpol-controlplane/`).
  This does **not** by itself protect the data at rest on disk or over anyone with
  direct SSH/filesystem access to `mac-debian-01` — it only stops other in-cluster
  pods from reaching the S3 API.
- Anyone doing filesystem-level backup/restore/copy of `/var/lib/minio-dr-backup`
  (e.g. the "Relocating MinIO" procedure below) is handling that same crown-jewels
  data — copy it with the same care as a Vault Raft snapshot, not like an ordinary
  application volume.
- If the MinIO root credential or the `velero-repo-credentials` password is ever
  suspected compromised, treat it as a **sealed-secrets-signing-key-compromise-level**
  incident, not a routine credential rotation: everything ever backed up should be
  considered readable by the party who got it.

---

## Architecture

```
        every namespace's objects + every PV's file data
                          │  nightly 04:00, 30d TTL
                          ▼
  ┌───────────────────────────────────┐        ┌──────────────────────────────┐
  │  Velero (velero ns)               │  S3    │  MinIO (minio ns)            │
  │  velero-plugin-for-aws + node-    │ ─────▶ │  StatefulSet, 1 replica       │
  │  agent DaemonSet (Kopia fs-backup)│        │  hostPath PV pinned to        │
  │                                    │        │  mac-debian-01's LOCAL disk   │
  └───────────────────────────────────┘        │  (/var/lib/minio-dr-backup)   │
                                                 │  bucket: velero               │
                                                 └──────────────────────────────┘
```

- **Why MinIO is node-local, not Ceph-backed:** the whole point of this store is to
  survive a failure Ceph itself might not (cluster-wide power loss, a Ceph mon quorum
  loss, a botched Rook upgrade). Backing the backup target with the same storage
  system the backups protect against would make it a correlated single point of
  failure. See `platform-services/minio/namespace.yaml` for the full rationale.
- **Why one node, one replica:** MinIO here is a DR target, not an HA service.
  Distributed/erasure-coded MinIO needs 4+ drives — gold-plating for a homelab. If
  `mac-debian-01` is down, backup/restore is paused (an availability gap, not a
  data-loss risk — existing snapshots on disk are untouched) until it returns.
- **Why file-system backup (Kopia), not CSI/volume snapshots:** this cluster has no
  `VolumeSnapshotClass` wired for the Rook-Ceph RBD CSI driver yet (a documented
  follow-up). Velero's node-agent DaemonSet backs up the actual file contents of every
  pod volume instead — works identically regardless of storage backend, and needs no
  CSI-snapshot prerequisite. `configuration.defaultVolumesToFsBackup: true` means this
  happens for **every** PV automatically — no per-pod annotation required.
- **Credentials — reaching MinIO:** Velero authenticates as a **dedicated, non-root
  MinIO IAM user** scoped to only the `velero` bucket (created by
  `platform-services/minio/minio-provision-job.yaml`), not the MinIO root account —
  same least-privilege pattern as Harbor's per-team robot accounts. See the
  SealedSecret file headers (`platform-services/minio/sealedsecret-*.yaml`,
  `platform-services/velero/sealedsecret-minio-credentials.yaml`) for the full
  key-custody picture.
- **Credentials — encrypting what's stored:** this is a **separate** secret from the
  one above. `platform-services/velero/sealedsecret-repo-credentials.yaml` seals a
  strong, randomly-generated password into `velero-repo-credentials` (the
  Kopia/restic backup-repository password) so the backup **contents** are encrypted
  at rest with something other than Velero's well-known upstream default password.
  See "THE MINIO DISK IS THE CROWN JEWELS" above.
- **Network access:** restricted to the `velero` namespace only, via
  `hardening/netpol-controlplane/minio-netpol.yaml` (MANUAL-SYNC — see "THE MINIO
  DISK IS THE CROWN JEWELS" above and that dir's header for the sync/rollback
  procedure).
- **Reused bucket, future observability:** this MinIO instance is intended to also
  back Thanos long-term metrics storage and Tempo traces later (both currently
  **not deployed** — anti-gold-plate, per the retro). When they land, add their own
  buckets + scoped IAM users in `minio-provision-job.yaml` (a commented placeholder
  is already there) rather than provisioning a second MinIO.

### ⚠ Residual risk: this is not truly *off-site*

`mac-debian-01` sits in the same physical location as every other node. This backup
protects against **logical** failures (bad `kubectl delete`, corrupt etcd, a botched
upgrade, even a full-site power outage the cluster otherwise doesn't survive
cleanly) — it does **not** protect against **physical loss of the site itself**
(fire, theft, that one disk failing). Closing that gap means replicating the
`velero` bucket off-site (e.g. `mc mirror` to a cloud bucket, or a second MinIO at a
different location) — a documented follow-up, not attempted here.

---

## Day-2: verify the schedule is running

```bash
kubectl -n velero get schedule
kubectl -n velero get backups                     # one per schedule firing
kubectl -n velero describe backup <name>           # Phase: Completed, no errors
kubectl -n minio get statefulset,pvc,pod
kubectl -n minio exec minio-0 -- df -h /data       # real disk headroom (hostPath has no quota)

# Confirm the repo password is OUR sealed value, not Velero's well-known default
# (expect this to print nothing — a match means the backup store is unencrypted,
# see "THE MINIO DISK IS THE CROWN JEWELS" above; escalate immediately if it prints):
kubectl -n velero get secret velero-repo-credentials -o jsonpath='{.data.repository-password}' \
  | base64 -d | grep -Fx 'static-passw0rd' && echo "!!! DEFAULT PASSWORD IN USE !!!"
```

Reach the MinIO console (root credentials only — do this from an operator
workstation, never expose this publicly):

```bash
kubectl -n minio port-forward svc/minio 9001:9001
# open http://localhost:9001, log in with the minio-admin SealedSecret's values
#   kubectl -n minio get secret minio-admin -o jsonpath='{.data.MINIO_ROOT_USER}' | base64 -d
#   kubectl -n minio get secret minio-admin -o jsonpath='{.data.MINIO_ROOT_PASSWORD}' | base64 -d
```

An ad-hoc, on-demand backup (does not wait for the 04:00 schedule):

```bash
velero backup create manual-$(date +%Y%m%d%H%M) --from-schedule daily-full-backup
velero backup describe manual-<ts> --details
```

---

## ⚠ Tested restore (operator must run this — not yet executed)

Every step below is a **cluster write** — per this platform's agent boundary, only
the human operator's keyboard runs these (see `docs/operator/vault-and-dr.md` for the
same convention on the Vault side). **DR is not "proven" until an operator has
actually run this drill once and it succeeded** — treat that as an open action item
from this PR, not a completed claim.

### A. Prerequisites

```bash
# velero CLI on the operator workstation (matches the chart's appVersion):
# https://github.com/vmware-tanzu/velero/releases/tag/v1.18.1
velero version    # Client + Server should both show v1.18.x
```

### B. Prove a full namespace round-trip

```bash
# 1. Create a disposable namespace with BOTH a plain object and a PV, so the
#    drill proves the node-agent fs-backup path too, not just object restore.
kubectl create namespace dr-drill
kubectl -n dr-drill create configmap canary --from-literal=proof="$(date -u)"
kubectl -n dr-drill apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: dr-drill-pvc
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: ceph-block
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: dr-drill-writer
  annotations:
    backup.velero.io/backup-volumes: data   # belt-and-suspenders; defaultVolumesToFsBackup already covers this
spec:
  restartPolicy: Never
  containers:
    - name: writer
      image: busybox:1.36
      command: ["sh", "-c", "echo dr-drill-canary > /data/proof.txt && sleep 3600"]
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: dr-drill-pvc
EOF
kubectl -n dr-drill wait --for=condition=Ready pod/dr-drill-writer --timeout=120s

# 2. Back it up on demand and wait for completion.
velero backup create dr-drill-backup --include-namespaces dr-drill --wait
velero backup describe dr-drill-backup --details    # Phase: Completed, 0 errors

# 3. Destroy the namespace — simulates the disaster.
kubectl delete namespace dr-drill --wait=true

# 4. Restore it from the backup.
velero restore create dr-drill-restore --from-backup dr-drill-backup --wait
velero restore describe dr-drill-restore --details   # Phase: Completed, 0 errors

# 5. VERIFY the restore actually brought the data back (this is the point of the
#    drill — a "Completed" restore phase is not proof by itself).
kubectl -n dr-drill get configmap canary -o jsonpath='{.data.proof}'; echo
kubectl -n dr-drill exec dr-drill-writer -- cat /data/proof.txt   # expect "dr-drill-canary"

# 6. Clean up.
kubectl delete namespace dr-drill --wait=true
velero backup delete dr-drill-backup --confirm
```

If step 5 prints the expected values, the restore path is proven end-to-end
(objects + PV file data, via MinIO). Record the date this was last run successfully
— see the failure cheatsheet below for what to do if any step fails.

### C. Whole-namespace / whole-cluster restore (real disaster)

Same `velero restore create --from-backup <name>` command, scoped wider:

```bash
velero backup get                                   # pick the most recent good backup
velero restore create --from-backup <backup-name>   # restores EVERY namespace the backup covered
```

`excludedNamespaces: [minio]` on the schedule means the MinIO store itself is never
restored from its own backups — recreate it from git (`platform-services/minio/`,
ArgoCD sync) instead, same as any other platform service.

---

## Relocating MinIO to a different node

The disk is pinned to one node deliberately (see architecture above). To move it:

1. Copy `/var/lib/minio-dr-backup` from the old node to the new one (or accept a
   cold start with only the new node's fresh, empty directory — you lose local
   backup history unless you copy it).
2. Edit **both** `platform-services/minio/pv-local.yaml` (the `nodeAffinity`
   `kubernetes.io/hostname` value) and `platform-services/minio/statefulset.yaml`
   (the `nodeSelector`) to the new node's name.
3. Merge, let ArgoCD sync, delete `minio-0` if it does not reschedule automatically
   (`kubectl -n minio delete pod minio-0`).
4. Confirm `kubectl -n minio get pod -o wide` shows it on the new node and
   `kubectl -n minio exec minio-0 -- mc ls /data` (or the console) shows the
   `velero` bucket's existing contents (if you copied the directory).

---

## Failure cheatsheet

| Symptom | Cause | Fix |
| --- | --- | --- |
| `minio-0` Pending, `node(s) had volume node affinity conflict` | pod scheduled off `mac-debian-01` for some other reason (taint/drain) or the PV's nodeAffinity/StatefulSet nodeSelector got out of sync | confirm `mac-debian-01` is `Ready` + untainted; confirm both files in "Relocating MinIO" step 2 agree |
| `minio-provision` Job `CrashLoopBackOff` / stuck retrying "MinIO not reachable" | `minio-0` itself isn't Ready yet | check `kubectl -n minio get pod minio-0`; the Job retries for ~5m, which should be enough once MinIO starts |
| Velero pod `CrashLoopBackOff`, BackupStorageLocation `Unavailable` | `velero-minio-credentials` Secret missing/wrong, or MinIO unreachable | `kubectl -n velero describe backupstoragelocation default`; confirm the SealedSecret decrypted (`kubectl -n velero get secret velero-minio-credentials`) and the `minio-provision` Job actually created the scoped IAM user (`mc admin user list local` from a debug pod, or the console) |
| Backup `PartiallyFailed`, node-agent errors in the backup's logs | node-agent DaemonSet pod not Ready on the node the workload's PV lives on | `kubectl -n velero get pods -l name=node-agent -o wide`; `kubectl -n velero logs -l name=node-agent` |
| Restore completes but PV data is empty | pod that owned the volume wasn't Running long enough for Kopia to complete the backup, or the restore ran before the node-agent's restore-helper init container finished | re-run the drill (§B) after confirming the ORIGINAL backup's `.status.progress` shows non-zero bytes for the volume |
| `mc: <ERROR> ... Access Denied` from the provisioning Job | the `velero-rw` policy JSON or the IAM user attach step failed partway | re-run the Job (`argocd app sync platform-svc-minio` or delete+let ArgoCD recreate); check its logs for the exact `mc admin` step that failed |
| Velero/node-agent times out reaching MinIO, or a NON-velero pod suddenly can't reach `minio.minio.svc.cluster.local:9000` | `hardening/netpol-controlplane/minio-netpol.yaml` was synced (`argocd app sync platform-netpol-controlplane`) and either legitimately blocked a non-Velero caller, or a rule is mis-scoped | confirm the caller is actually in the `velero` namespace; if it should be allowed and isn't, fix the netpol in git and re-sync — do NOT `kubectl edit` the live NetworkPolicy (drifts from git); rollback command is in that file's header |

---

## Fix accompanying this PR: `CreateNamespace=true` (issue #199)

`applicationsets/vpa-app.yaml` and `applicationsets/goldilocks-app.yaml` were audited
as part of this PR — both **already carry** `syncOptions: [CreateNamespace=true, ...]`
(added when they were first merged in #199). No change was needed; this is recorded
here as the verification trail for that ask.
