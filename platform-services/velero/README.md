# Velero (dr-backup) — scheduled backup of every namespace + PV

Deployed as the ArgoCD Application `platform-velero`
(`applicationsets/velero-app.yaml`, deploy method A — pinned `velero` chart
`12.1.0`, appVersion `1.18.1`). This dir ships only the `velero` **namespace** and
two SealedSecrets (the chart itself is a SEPARATE Application, same split as
Harbor/Vault):

- `sealedsecret-minio-credentials.yaml` -> `velero-minio-credentials` — the S3
  access-key pair Velero uses to *reach* MinIO.
- `sealedsecret-repo-credentials.yaml` -> `velero-repo-credentials` — the
  Kopia/restic **repository encryption password**. Pre-sealing a strong,
  randomly-generated password here (instead of letting Velero mint its own on
  first backup) is what keeps the backup store from being encrypted with
  upstream's well-known default password. See that file's header and
  `docs/operator/dr-backup.md` for why this matters and the no-rotate-after-
  first-backup caveat.

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
