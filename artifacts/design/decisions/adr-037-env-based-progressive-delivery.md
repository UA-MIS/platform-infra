# ADR-037 — Env-Based Progressive Delivery (prod canary by default)

- **Status:** Accepted (implemented — supersedes the opt-in "Progressive delivery (canary)" wizard toggle)
- **Date:** 2026-07-12
- **Deciders:** platform owner (ccsmith33)
- **Related:** ADR-034 (unified project wizard), ADR-008 (promotion model dev→staging→prod), #351 (auto-completing canary), #340 (JSON6902 replicas patch vs Rollout GVK), #346 (PDB / anti-affinity for replicas>1), docs/operator/progressive-delivery.md

---

## 1. Context

Progressive delivery shipped as an opt-in **wizard toggle** (`progressiveDelivery`,
single-component web only): when checked, the shared contract's
`base/deployments.yaml` rendered the one workload as an Argo Rollouts `Rollout`
(auto-completing canary) instead of a `Deployment`, in **every** env. That had two
problems:

1. **It was a choice students shouldn't have to make.** The canary is a platform
   best-practice; leaving it off by default meant most tenants never got it.
2. **A canary in dev/staging/preview is friction, not value.** Those envs want a fast
   rolling update; a paused "Suspended" Rollout in a throwaway preview is confusing and
   slow. The canary's value is in **prod**, where a bad promote should roll out
   gradually behind a health gate.

## 2. Decision

Make progressive delivery an **env-based platform default**, and **remove the wizard
toggle**:

- **dev / staging / preview** → plain rolling-update **`Deployment`** (from
  `base/deployments.yaml`).
- **prod** → a single-component web project deploys as the #351 auto-completing canary
  **`Rollout`** (setWeight 25 → pause 30s → 50 → pause 30s → 100), via the prod overlay.

The prod overlay (`overlays/prod`) `$patch: delete`s the base `Deployment` and adds
`rollout.yaml` (same container spec, same Service selector so traffic routes). The
`values.progressiveDelivery` flag is removed from the wizard `template.yaml`, the
compose engine (`composeProject.ts`, accepted-but-ignored for back-compat — no
rebuild needed), and all chart templates. Multi-component (frontend-backend / mobile)
projects stay plain Deployments in every env — the Basic Canary's single-Service
weight approximation is a single-component pattern.

The #340 replicas patch targets the `argoproj.io/Rollout` GVK in prod and `Deployment`
elsewhere; the #346 PDB + soft pod-antiAffinity stay tied to **replicas > 1** (staging=2,
prod=3), independent of the Deployment-vs-Rollout choice.

Existing tenants are unaffected — this is a scaffolder-contract change read at create
time (new-tenants-forward).

## 3. Consequences

- Every new single-component web tenant gets a real prod canary with zero configuration;
  dev/staging/preview stay fast.
- One fewer wizard field; one fewer thing to explain.
- The prod canary catches **crash / failed-health-check** regressions (a bad image never
  passes readiness → the Rollout stalls, never promotes). It does **not** yet catch
  *behavioral* regressions (elevated error rate / latency on healthy-but-wrong pods).

## 4. Next (follow-up — the powerful upgrade)

Add a **metrics-gated `AnalysisTemplate`** to the prod canary: Prometheus **SLO
queries** (error rate, p95 latency) evaluated at each canary step that **auto-abort** a
regressing canary and **auto-promote** only a healthy one. The `AnalysisTemplate` CRD is
already installed with the Argo Rollouts controller; what's missing is stable
per-workload SLO queries from observability (Track-3). This is what makes the prod
canary *truly* powerful — it turns "did it crash?" into "did it get worse?". Tracked as
a follow-up in `docs/operator/progressive-delivery.md`; not wired into the default chart
yet (depends on Track-3 SLOs).
