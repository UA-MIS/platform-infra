# platform-services/vpa-policies

The curated allowlist of **active** VPA right-sizing objects, synced by
`applicationsets/vpa-platform-policies-app.yaml` (directory-source app,
sync-wave 1 — after the VPA CRDs from `platform-vpa`, wave 0).

Every object here is `updateMode: Auto` + `controlledValues: RequestsOnly`: VPA
sets right-sized **requests** (never touches limits) for a **stateless,
single-eviction-safe controller**. Pre-k8s-1.33 Auto applies by evicting the pod,
so this file is the ONLY place Auto VPAs live and the allowlist is deliberately
short.

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
