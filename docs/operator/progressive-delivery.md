# Progressive delivery (Argo Rollouts, opt-in canary)

Every golden-path app still deploys as a plain `Deployment` — this is **additive**.
Argo Rollouts is a cluster-wide **platform capability** a team can opt into per app;
nothing existing changes.

## What's installed

`platform-argo-rollouts` (`applicationsets/argo-rollouts-app.yaml`) — the official
Argo Helm `argo-rollouts` chart, pinned **2.41.0** (app v1.9.0), same deploy pattern
as every other platform add-on (Harbor, VPA, Crossplane): a pinned Helm repo added to
the `platform` AppProject `sourceRepos` allowlist (`bootstrap/platform-appproject.yaml`
— **install-owned**, needs `make bootstrap`/`make bootstrap-reapply` + VERIFY after
merge, same as every prior chart-repo add) + a sync-wave-0 Application.

- Installs the `Rollout`/`AnalysisTemplate`/`ClusterAnalysisTemplate`/`AnalysisRun`/
  `Experiment` CRDs (chart default `installCRDs: true`) and the controller
  (`controller.replicas: 1` — one instance is enough for the 3-node homelab; a
  restart only pauses reconciliation, it never drops traffic).
- No dashboard (`dashboard.enabled: false`, chart default) — inspect a Rollout with
  `kubectl argo rollouts get rollout <name> -n <ns> --watch` (the
  [`kubectl-argo-rollouts`](https://argoproj.github.io/argo-rollouts/installation/#kubectl-plugin-installation)
  plugin) or plain `kubectl get rollout`. Publishing the dashboard behind
  Traefik+OIDC is a documented follow-up, not blocking.
- The controller only reconciles objects of `kind: Rollout`. A plain `Deployment`
  is completely unaffected whether or not the controller is installed or running.

## Tenant opt-in — the scaffolder toggle

The **live** golden-path scaffolder is the unified **"New Project"** wizard
(`platform-services/backstage/templates/new-project/template.yaml`, ADR-034 — the
only two registered templates are "New Project" and "New Capstone VM", see
`platform-services/backstage/catalog/all.yaml`). Its **"Progressive delivery
(canary)"** checkbox, default **off**, is wired through `capstone:compose-project`
into the ONE shared contract every fragment renders
(`platform-services/backstage/templates/_fragments/_contract/.devops/chart/base/
deployments.yaml`).

- **Off (default), or a frontend-backend/mobile project:** `deployments.yaml`
  renders `kind: Deployment` for every component — byte-for-byte the same
  manifests as before this change.
- **On, single-component "web" project only:** the one component's manifest
  renders `kind: Rollout` (`apiVersion: argoproj.io/v1alpha1`) with a **Basic
  Canary** strategy:

  ```yaml
  strategy:
    canary:
      steps:
        - setWeight: 25
        - pause: {}
        - setWeight: 50
        - pause: {}
        # (implicit 100% + rollout complete once the last pause is promoted)
  ```

  The gate is `values.single AND values.progressiveDelivery` (both must be true) —
  a frontend-backend or mobile project always gets plain Deployments even with the
  checkbox on, because there's no single obvious "one representative workload" to
  convert there yet (see the follow-up below). Every other file is untouched —
  `services.yaml`, `ingress.yaml`, `serviceaccount.yaml`, the overlays,
  `promotion.yaml`, and the CI scripts don't know or care whether a component is a
  `Deployment` or a `Rollout`. A `Rollout` is a drop-in replacement: same
  `replicas`/`selector`/`template` shape, same ReplicaSets underneath, same Service
  selecting on `app.kubernetes.io/name`.

Not offered for the frontend-backend/mobile layouts yet — extend the same
`{% if %}` in `_fragments/_contract/.devops/chart/base/deployments.yaml` (per
component, using each component's own `c.name`) if a multi-component team needs it.

> The template.yaml/skeleton files under `templates/new-capstone-project*/` are
> **legacy, retired, not registered** in the catalog (kept on disk only as a
> fallback — see the `all.yaml` comment). They do NOT carry this toggle; don't
> confuse them with the live `new-project` template above.

### Enabling it on an existing (already-scaffolded) app

The toggle only affects the scaffolder at create time. An existing team can opt in
by hand-editing their own `.devops/chart/base/deployments.yaml`: swap
`apiVersion: apps/v1` / `kind: Deployment` for `apiVersion: argoproj.io/v1alpha1` /
`kind: Rollout` on their component and add the `strategy.canary` block above (or
copy it from a fresh scaffold with the checkbox on). No platform-side change is
required — the controller already watches every namespace.

### Why "Basic Canary" (no traffic-routing plugin)

The platform's ingress is Traefik, which Argo Rollouts has no native
traffic-routing integration for (its plugins target Istio/SMI/Nginx/ALB/Traefik-
via-a-separate-plugin). Without a routing plugin, Argo Rollouts approximates each
`setWeight` by the **replica-count ratio** between the canary and stable
ReplicaSets, both selected by the one Service (`services.yaml` — unchanged). That's
weaker than exact traffic-percentage shaping, but it's a real, working canary
(new Pods created and observed before old ones are removed, and `pause: {}` gives
an operator a manual gate) with zero extra infrastructure — the right "simple
canary" for a first opt-in demo. Wiring a Traefik-native (or Gateway API) traffic
split is a documented follow-up, not blocking.

## Promoting / aborting a paused Rollout

```bash
# watch a Rollout's progress
kubectl argo rollouts get rollout <name> -n <team>-<env> --watch

# promote past the current pause (advance to the next step)
kubectl argo rollouts promote <name> -n <team>-<env>

# abort and roll back to the last stable ReplicaSet
kubectl argo rollouts abort <name> -n <team>-<env>
```

`pause: {}` (no `duration:`) pauses **indefinitely** until promoted — the canary
never auto-completes on its own. That's a deliberate default for a first opt-in:
add a `duration:` to auto-promote after a timeout once a team trusts the pattern.

## Tenancy / RBAC

`Rollout` (`argoproj.io`) is namespaced, tenancy-safe — same shape as `Deployment`.
It's whitelisted in both places a team's ArgoCD Application is allowed to manage
namespaced objects:

- `platform-services/crossplane/apis/composition.yaml` — the **live** zero-touch
  `CapstoneTenant` Composition's per-team AppProject (every tenant onboarded via
  the "New Project" wizard goes through this).
- `tenants/_template/appproject.yaml` — the older manual/fallback render-tenant
  path (`capstone:render-tenant`, OPERATIONS §4.4) still documented for VM
  workloads; kept in sync for consistency even though the wizard no longer uses it.

Whitelisting costs nothing for teams who never create a `Rollout` — ArgoCD only
enforces the allow list against resources actually present in an Application's
rendered manifests. A team can run a `Rollout` **instead of** a `Deployment` in its
own namespace; never a cluster-scoped object.

## Follow-ups (not in this change)

- Publish the `argo-rollouts` dashboard behind Traefik + OIDC.
- A Traefik-native (or Gateway API) traffic-routing plugin for exact
  percentage-based weighting instead of the replica-ratio approximation.
- Extend the canary opt-in to the frontend-backend (`skeleton-multi`) layout.
- `AnalysisTemplate`-driven automated promotion/rollback (metrics-gated canary)
  once observability (Track-3) has stable per-workload SLO queries to gate on.
