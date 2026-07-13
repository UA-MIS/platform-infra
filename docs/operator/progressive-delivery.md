# Progressive delivery (Argo Rollouts) — env-based prod canary

Progressive delivery is now an **env-based platform default (ADR-037)**, not a wizard
toggle. Every scaffolded app gets it automatically, in exactly one place:

- **dev / staging / preview** deploy a plain rolling-update **`Deployment`** — fast,
  no canary, no "why is my rollout paused?" confusion.
- **prod** deploys a **single-component web** project as an auto-completing Argo
  Rollouts **canary** (`Rollout`): 25% → pause 30s → 50% → pause 30s → 100%.

There is nothing for a team to choose — the old "Progressive delivery (canary)"
checkbox has been removed from the "New Project" wizard.

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

## How the env-based policy is wired (the chart)

It is decided entirely in the ONE shared contract every fragment renders
(`platform-services/backstage/templates/_fragments/_contract/.devops/chart`), so it
needs **no Backstage rebuild** — the chart is read at scaffold time:

- **`base/deployments.yaml`** — ALWAYS a plain `Deployment` per component. This is
  what dev / staging / preview deploy, byte-for-byte a rolling update.
- **`overlays/prod/rollout.yaml`** — the auto-completing canary `Rollout` (below).
  Rendered only for a single-component web project (`values.single`).
- **`overlays/prod/kustomization.yaml`** — for a single-component project it
  references `rollout.yaml` **and** `$patch: delete`s the base `Deployment` of the
  same name, so prod runs the `Rollout` **instead of** the Deployment. The same one
  `Service` (selecting on `app.kubernetes.io/name` + `component`, no
  `rollouts-pod-template-hash`) routes traffic to the Rollout's stable + canary
  ReplicaSets, so nothing else changes. dev / staging / preview never reference
  `rollout.yaml`.
- The per-component replicas patch (#340) targets the `argoproj.io/Rollout` GVK in
  prod (the builtin kustomize `replicas:` transformer errors on a Rollout) and the
  `Deployment` everywhere else; the prod/staging **PDB** (#346) and soft
  pod-antiAffinity are HA features tied to **replicas > 1** (staging = 2, prod = 3),
  independent of the Deployment-vs-Rollout choice.

**Multi-component (frontend-backend / mobile) projects stay plain Deployments in
EVERY env, prod included.** The Basic Canary approximates traffic weight via one
Service's stable/canary ReplicaSet ratio, which is a single-component pattern — see
the follow-up below to extend it.

### The prod canary (auto-completes, no human, no plugin)

`overlays/prod/rollout.yaml` renders a `Rollout` (`apiVersion:
argoproj.io/v1alpha1`) with a **Basic Canary** strategy that **auto-completes**:

```yaml
strategy:
  canary:
    steps:
      - setWeight: 25
      - pause: { duration: 30s }
      - setWeight: 50
      - pause: { duration: 30s }
      - setWeight: 100
      # rollout completes at 100%, then scales the old ReplicaSet to 0 after
      # scaleDownDelaySeconds (default 30s — not overridden).
```

The pauses are **timed** (`duration: 30s`), so each prod image bump (the
promote-to-prod gate) steps 25% → 50% → 100% and promotes on its own — the old
revision's ReplicaSet is scaled to 0 automatically once it reaches 100%. Nothing
parks at a canary step waiting for a human. The **first-ever** prod deploy on a fresh
tenant skips the steps entirely (Argo Rollouts has no prior stable revision to canary
against) and comes up straight at 100%, so a brand-new app is never stuck at an
initial rollout.

You can still watch it if you have the plugin:

```bash
# watch a Rollout's progress (optional; needs the kubectl-argo-rollouts plugin)
kubectl argo rollouts get rollout <name> -n <team>-prod --watch

# or plain kubectl, no plugin:
kubectl get rollout <name> -n <team>-prod -w
```

### Why "Basic Canary" (no traffic-routing plugin)

The platform's ingress is Traefik, which Argo Rollouts has no native traffic-routing
integration for. Without a routing plugin, Argo Rollouts approximates each `setWeight`
by the **replica-count ratio** between the canary and stable ReplicaSets, both
selected by the one Service (`base/services.yaml` — unchanged). That's weaker than
exact traffic-percentage shaping, but it's a real, working canary (new Pods created
and observed before old ones are removed, and the timed pauses give a real,
observable rollout window) with zero extra infrastructure. Wiring a Traefik-native
(or Gateway API) traffic split is a documented follow-up, not blocking.

## Existing tenants are unaffected (new-tenants-forward)

This is a change to the scaffolder's shared contract, read at **create time**.
Already-scaffolded tenant repos keep whatever chart they were created with — nothing
in a running cluster changes on merge. Only projects scaffolded **after** this lands
get the env-based prod canary. An existing single-component team can adopt it by hand,
in their own repo, by copying `overlays/prod/rollout.yaml` from a fresh scaffold and
adding the `rollout.yaml` resource + the base-`Deployment` `$patch: delete` to their
`overlays/prod/kustomization.yaml`. No platform-side change is required — the
controller already watches every namespace.

## Opting into a MANUAL hold gate (per team, prod)

If a team wants a human approval gate on a step (hold the canary until someone
promotes it), replace a timed pause with a **bare** `pause: {}` (no `duration:`),
which pauses **indefinitely** until promoted, in their own
`overlays/prod/rollout.yaml`:

```yaml
      steps:
        - setWeight: 25
        - pause: {}            # HOLD here until an operator promotes
        - setWeight: 50
        - pause: { duration: 30s }
        - setWeight: 100
```

Then install the [`kubectl-argo-rollouts`](https://argoproj.github.io/argo-rollouts/installation/#kubectl-plugin-installation)
plugin and drive it by hand:

```bash
kubectl argo rollouts promote <name> -n <team>-prod   # advance past the indefinite pause
kubectl argo rollouts abort   <name> -n <team>-prod   # roll back to the last stable ReplicaSet
```

Because the plugin is **not** installed on the platform by default, a bare
`pause: {}` that no one promotes will park the Rollout forever — that is why the
shipped default is fully automatic and this hold gate is strictly opt-in per team.

## NEXT: metrics-gated canary (`AnalysisTemplate`) — ADR-037

The prod canary today catches **crash / failed-health-check** regressions (a bad
image never passes readiness, so the Rollout stalls and never promotes). The powerful
next step is a metrics-gated **`AnalysisTemplate`** (the CRD is already installed):
Prometheus **SLO queries** (error rate, p95 latency) evaluated at each canary step
that **auto-abort** a canary showing an error-rate/latency regression and **auto-promote**
only a healthy one — catching *behavioral* regressions a health check can't see. That
needs stable per-workload SLO queries from observability (Track-3) and is tracked as
ADR-037's follow-up (see `artifacts/design/decisions/adr-037-*`). Not wired into the
default chart yet.

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

Whitelisting costs nothing for teams whose prod is a plain `Deployment` (multi-component,
or any env that isn't prod) — ArgoCD only enforces the allow list against resources
actually present in an Application's rendered manifests. A team runs a `Rollout`
**instead of** a `Deployment` in its own prod namespace; never a cluster-scoped object.

## Follow-ups (not in this change)

- **`AnalysisTemplate`-driven metrics-gated canary** (auto-promote/abort on Prometheus
  SLOs) once observability (Track-3) has stable per-workload SLO queries — ADR-037.
- Publish the `argo-rollouts` dashboard behind Traefik + OIDC.
- A Traefik-native (or Gateway API) traffic-routing plugin for exact
  percentage-based weighting instead of the replica-ratio approximation.
- Extend the prod canary to the frontend-backend (multi-component) layout
  (per-component Rollouts behind each component's own Service).
