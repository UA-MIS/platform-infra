# MinIO (dr-backup) — the platform's disaster-recovery object store

A single-node, single-drive **MinIO** instance pinned to `mac-debian-01`'s **local
disk** (a static hostPath PersistentVolume, `local-hostpath` StorageClass —
deliberately **NOT** Rook-Ceph). It exists to be the target Velero
(`platform-services/velero/`, `applicationsets/velero-app.yaml`) backs up into.

Plain pinned manifests, not a Helm chart — see `statefulset.yaml`'s header for why.
Picked up by the `platform-services` ApplicationSet as `platform-svc-minio` (same
as Dex/cloudflared/vault-unsealer).

| File | What |
| --- | --- |
| `namespace.yaml` | `minio` namespace — see its header for why this store is deliberately non-Ceph |
| `storageclass.yaml` | `local-hostpath` — static, no dynamic provisioner, `WaitForFirstConsumer`, `Retain` |
| `pv-local.yaml` | The static hostPath PV, node-pinned via `nodeAffinity` |
| `pvc.yaml` | Binds only to that PV (explicit `volumeName`) |
| `sealedsecret-admin.yaml` | MinIO root credentials (server + the provisioning Job) |
| `sealedsecret-velero-user.yaml` | A dedicated, non-root MinIO IAM user's creds, scoped later to only the `velero` bucket |
| `sealedsecret-thanos-user.yaml` | A dedicated, non-root MinIO IAM user's creds, scoped later to only the `dr-backup` bucket — ⚠ coupled to `monitoring/thanos.yaml`'s `thanos-objstore-config`, see its own header |
| `netpol.yaml` | CiliumNetworkPolicy: the provisioning Job's own intra-namespace access (auto-synced, additive-only) |
| `statefulset.yaml` | The MinIO server (1 replica) + its ClusterIP Service (API :9000, console :9001) |
| `minio-provision-job.yaml` | Idempotent bootstrap: creates the `velero` + `dr-backup` buckets + their scoped IAM users + least-privilege policies |

**Full architecture, day-2 checks, and the tested-restore drill:**
[`docs/operator/dr-backup.md`](../../docs/operator/dr-backup.md).

No ingress — reach the console via `kubectl -n minio port-forward svc/minio
9001:9001` (same pattern as the Goldilocks dashboard).
