# platform-services/vpa-policies

The curated allowlist of **active** VPA right-sizing objects, synced by
`applicationsets/vpa-platform-policies-app.yaml` (directory-source app,
sync-wave 1 — after the VPA CRDs from `platform-vpa`, wave 0).

Every object here is `controlledValues: RequestsOnly`: VPA sets right-sized
**requests** (never touches limits) for a stateless, single-eviction-safe
controller. Pre-k8s-1.33 Auto applies by evicting the pod, so within that
constraint this directory splits into two `updateMode`s (D-180):
- **`Auto`** — controllers and collectors, plus PDB-guarded multi-replica edges
  (traefik, cloudflared, portal, argocd-server). A blip here is invisible (no
  human is looking at it) or zero-downtime (the PDB rolls one replica at a
  time), so evicting live is correct and gets the resize applied immediately.
- **`Initial`** — single-replica, user-facing services with no PDB possible
  (grafana, backstage, argocd-dex-server, thanos-query, ntfy). A live eviction
  here is a visible outage (UI down, SSO logins broken, dashboards/datasource
  gone) for a resize that isn't urgent, so sizing lands only at the pod's next
  natural restart instead.

This directory is the ONLY place Auto VPAs live, and the allowlist is
deliberately curated (one file per component group, one object per Deployment).

> Auto only actively evicts single-replica workloads because the **vpa-updater is
> run with `--min-replicas=1`** (`applicationsets/vpa-app.yaml`). At the chart
> default (`2`) the updater skips every singleton here — Auto would be a silent
> no-op until the pod's next natural restart.

`pdbs.yaml` carries `minAvailable: 1` PDBs for the multi-replica targets (traefik,
cloudflared, portal) so their resize is zero-downtime. Single-replica targets get
NO PDB (a `minAvailable:1` PDB on 1 replica would deadlock the eviction).

Full target list, exclusions, net-effect analysis and the supervised-apply runbook:
`docs/operator/resource-governance.md`.

**Rules for adding a target:**
- Stateless, self-healing Deployment only (a ~15s eviction gap must be a non-event).
- NEVER a stateful singleton: Vault, Ceph mon/OSD, Postgres, Prometheus/Alertmanager,
  the argocd application-controller. Those get recommend-only (Off) VPAs from
  Goldilocks via the `goldilocks.fairwinds.com/enabled` namespace label instead.
- One explicit object per Deployment (exact `targetRef.name`) — no namespace-wide
  selectors.
- Keep `minAllowed`/`maxAllowed` floors so VPA can't thrash requests to zero or
  above the quota tier.

For a zero-eviction rollout, change `updateMode: Auto` → `Initial` (requests applied
at the pod's next natural restart). See `docs/operator/resource-governance.md`.
