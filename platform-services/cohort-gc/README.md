# cohort-gc — preview-TTL + cohort-cleanup CronJobs (DRAFT)

> **STATUS: DRAFT for human review — do NOT merge as-is without the gotchas below
> resolved.** Both jobs default to `DRY_RUN=true`; cohort-cleanup is `suspend:true`.

Two platform garbage-collection jobs that lean on the universal tenant labels
(`platform.capstone/{team,semester,env}` — present on every tenant object, see
`tenants/_template/`). Deployed as `platform-svc-cohort-gc` via the
`platform-services` ApplicationSet (directory generator over `platform-services/*`).

## 1. preview-ttl (`preview-ttl-cronjob.yaml`)
- **Schedule:** hourly. Reaps preview namespaces (`platform.capstone/env=preview`,
  named `<team>-pr-<n>`) older than `TTL_HOURS` (default **12h**).
- **Deletes the ArgoCD Application first**, then the namespace. Deleting only the
  ns is futile while the owning App has `selfHeal:true` — the App's
  `resources-finalizer` cascades the ns. The appset names the App == the ns
  (`<team>-pr-<n>`), so the App name is the ns name.
- **⚠ Safety-net, not primary teardown:** when live previews come from the ArgoCD
  `pullRequest` generator (post-v1), THAT generator owns the lifecycle (deletes on
  PR-close). If the TTL deletes an App the generator still wants (PR open but
  preview > TTL), the ApplicationSet recreates it. So pair the TTL with a max-PR-age
  in the generator, or scope the job to orphaned Apps only. **v1 ships an EMPTY
  preview list generator → this job is a no-op guard today**; it becomes
  load-bearing when live PR previews are wired.

## 2. cohort-cleanup (`cohort-cleanup-cronjob.yaml`)
- **`suspend: true`** — never fires automatically. Graduating a cohort is a
  deliberate destructive act.
- **⚠ This job is a RESIDUE-SWEEPER, not the primary teardown.** Onboarding is now
  Crossplane `CapstoneTenant` claims (ADR-031): each tenant is ONE claim file at
  `tenants/_claims/<team>-<app>.yaml`, expanded by a reviewed-once Composition into
  the repo + Harbor + Vault + the whole k8s tenancy fence (AppProject, namespaces,
  quota/netpol/RBAC, env/preview ApplicationSets). **The GitOps source of truth is
  the CLAIM, not the Apps/namespaces this job deletes.**
- **Canonical, safe graduate order is CLAIM-FIRST:**
  1. `git rm tenants/_claims/<team>-<app>.yaml` per team + commit (whole semester =
     `git rm tenants/_claims/*` for that cohort).
  2. ArgoCD (`platform-crossplane-claims`) prunes the `CapstoneTenant` XR → Crossplane
     + the AppProject/namespace finalizers **deprovision the tenant declaratively**
     (repo, Harbor, Vault, ApplicationSets, namespaces — the controllers own it).
  3. **Only if** orphaned Apps/namespaces remain after the controllers settle, run
     this job to sweep residue:
     ```sh
     # dry-run first (DRY_RUN defaults true) — set the slug, then trigger a one-off:
     kubectl -n cohort-gc create job cohort-cleanup-2026-fall --from=cronjob/cohort-cleanup
     # (set COHORT_SLUG in the CronJob env, or patch the one-off Job's env, before running)
     ```
- It selects every tenant Application + namespace with
  `platform.capstone/semester=<COHORT_SLUG>` (e.g. `2026-fall`) and deletes the Apps
  then the namespaces.
- **⚠ Apply-fight guard (2026-07-10 incident discipline).** Never run this while a
  claim or its ApplicationSets are still live — imperative `kubectl delete` vs
  Crossplane/ApplicationSet reconcile is an apply-fight (the 2026-07-10 duplicate-claim
  cascade: delete-vs-recreate thrash → Cilium CPU pin → node saturation). The job's
  pre-flight **refuses to run** (exit 3) if a matching `CapstoneTenant` claim or parent
  `ApplicationSet` still exists for the cohort; in `DRY_RUN` it loudly warns instead of
  refusing so the operator can still preview the inventory. Remove the claim FIRST, let
  the controllers deprovision, THEN sweep.

## RBAC
`ServiceAccount cohort-gc` (ns `cohort-gc`) + a cluster-scoped `ClusterRole`:
`namespaces` (get/list/delete) + `applications.argoproj.io` (get/list/delete), plus
**read-only** `capstonetenants.platform.capstone.uamishub.com` (get/list) and
`applicationsets.argoproj.io` (get/list) for the orphan-before-delete pre-flight guard.
No delete on claims/appsets (those go via `git rm`), no workload create/patch, no
secret access. Privileged maintenance identity — keep it off tenant runners.

## Pod security
Both jobs run `runAsNonRoot:65532`, `readOnlyRootFilesystem:true`,
`drop:[ALL]`, seccomp `RuntimeDefault`, with an emptyDir at `/tmp` (`HOME=/tmp`)
because kubectl needs a writable cache/config dir (the harbor-onboarding
readOnlyRootFilesystem + /tmp lesson). Namespace enforces PSA `restricted`.

## Open items for review before go-live
- [ ] Flip `preview-ttl` `DRY_RUN` → `false` once the human confirms the selection
      logic on a real preview (none exist in v1 yet). **Kept `DRY_RUN=true` here.**
- [ ] Flip `cohort-cleanup` `suspend: true` → `false` (or run on-demand) only after the
      CLAIM-first order + apply-fight guard are validated. **Kept `suspend: true` here.**
- [x] Kubectl image is `registry.k8s.io/kubectl:v1.31.5@sha256:84f79685…` (official k8s
      registry, digest-pinned). Replaced `bitnami/kubectl:1.31.5` — the 2025 Bitnami
      catalog move + Docker Hub anon pull-rate limits (no Harbor proxy-cache) made the
      old `IfNotPresent` tag an ImagePullBackOff risk.
- [x] Teardown source-of-truth updated to Crossplane claims
      (`git rm tenants/_claims/<claim>.yaml`) — the stale `tenants/team-*` path no longer
      exists on `main` (onboarding is `CapstoneTenant` claims, ADR-031).
- [x] cohort-cleanup reframed CLAIM-FIRST + orphan-before-delete pre-flight guard added
      (refuses to sweep while a claim/ApplicationSet is live) — closes the apply-fight gap.
- [ ] Confirm the ArgoCD Application CRD group is `argoproj.io` for `applications`
      in this cluster's Argo version (RBAC + kubectl calls assume it — reviewer verified
      correct). Same for `applicationsets.argoproj.io` (guard read).
- [ ] Decide preview-TTL behavior under the live `pullRequest` generator (safety-net
      vs primary) — see §1.
- [x] `date` portability: fixed for BusyBox. The `alpine/k8s` image's BusyBox `date`
      supports NEITHER GNU `-d "-N hours"` NOR BSD `-v` (both exit 1 — dead on every run,
      even DRY_RUN). The cutoff now uses POSIX epoch arithmetic (`NOW - TTL_HOURS*3600`)
      and each ns timestamp is parsed with BusyBox strptime (`date -D '%Y-%m-%dT%H:%M:%S'
      -d "${TS%Z}"`). No GNU-only or BSD-only `date` flags remain.
