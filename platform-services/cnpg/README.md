# CloudNativePG (db-setup task)

This directory is **excluded** from the `platform-services` directory generator
(`applicationsets/platform-services-appset.yaml`) — it holds only subdirectories,
no root `kustomization.yaml`. Each subdirectory is sourced by its OWN dedicated
ArgoCD Application, same two-app CRD-then-CR split as `rook-ceph` / `cdi` / `kubevirt`:

| Dir | Application | Sync wave | What |
| --- | --- | --- | --- |
| (n/a — Helm chart, no git dir) | `applicationsets/cnpg-operator-app.yaml` | 0 | The CNPG operator (`cloudnative-pg` Helm chart) + its CRDs |
| `barman-plugin/` | `applicationsets/cnpg-barman-plugin-app.yaml` | 0 | The Barman Cloud plugin (backup/WAL-archive sidecar manager) + its `ObjectStore` CRD |
| `cluster/` | `applicationsets/cnpg-cluster-app.yaml` | 1 | The **control-plane** `Cluster` CR (`capstone-pg`, PG17 HA), its `ObjectStore`, `ScheduledBackup`, per-app `Database`/`DatabaseRole` CRs (Backstage + Harbor + a provisioner-parity role) |
| `tenant-cluster/` | `applicationsets/cnpg-tenant-cluster-app.yaml` | 1 | The **dedicated tenant** `Cluster` CR (`capstone-tenant-pg`, PG17 HA, ADR-036) + its `ObjectStore`/`ScheduledBackup` + the `crossplane_provisioner` `DatabaseRole` — hosts auto-provisioned per-(team,env) `host-postgres` tenant DBs (ADR-033), ISOLATED from the control-plane `capstone-pg`. No declarative per-tenant `Database` CRs — those are created dynamically by provider-sql. |

The operator + plugin namespace (`cnpg-system`) and the Cluster's namespace
(`db-tier`, shared with the MariaDB tier + the backup MinIO) ship via the flat,
generator-managed `platform-services/cnpg-system/` and `platform-services/db-tier/`
dirs — same "ns + secrets in a flat dir, chart/CR in a dedicated Application" split
used by Harbor/Vault/ESO.

See `docs/operator/in-cluster-db-tier-runbook.md` for the full picture (what got
deployed, the Vault paths the orchestrator must fill in, and the pg_dump/restore +
mysqldump/restore cutover procedure — NOT executed by this PR, setup only).
