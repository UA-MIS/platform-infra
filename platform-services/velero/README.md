# Velero (dr-backup) — scheduled backup of every namespace + PV

Deployed as the ArgoCD Application `platform-velero`
(`applicationsets/velero-app.yaml`, deploy method A — pinned `velero` chart
`12.1.0`, appVersion `1.18.1`). This dir ships only the `velero` **namespace** and
the SealedSecret with the credentials Velero uses to reach MinIO (the chart itself
is a SEPARATE Application, same split as Harbor/Vault).

Backs up into `platform-services/minio/` (a dedicated, node-local, non-Ceph object
store — see that dir's `namespace.yaml` for why) via the AWS S3 provider plugin
(MinIO is S3-API-compatible). PV data is captured with Velero's node-agent
file-system backup (Kopia), not CSI/volume snapshots — no `VolumeSnapshotClass` is
wired for Rook-Ceph RBD yet.

Schedule: `daily-full-backup`, 04:00 daily, 30-day TTL, every namespace except
`minio` itself (see `applicationsets/velero-app.yaml`'s header for the full
rationale on each choice).

**Full architecture, day-2 checks, and the tested-restore drill an operator must
run:** [`docs/operator/dr-backup.md`](../../docs/operator/dr-backup.md).
