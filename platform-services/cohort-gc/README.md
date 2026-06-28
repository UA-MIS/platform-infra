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
  deliberate destructive act. Run on demand:
  ```sh
  # 1) dry-run first (DRY_RUN defaults true) — set the slug, then trigger a one-off:
  kubectl -n cohort-gc create job cohort-cleanup-2026-fall --from=cronjob/cohort-cleanup
  # (set COHORT_SLUG in the CronJob env, or patch the one-off Job's env, before running)
  ```
- Selects every tenant Application + namespace with
  `platform.capstone/semester=<COHORT_SLUG>` (e.g. `2026-fall`), deletes the Apps
  then the namespaces.
- **⚠ GitOps source of truth is `git rm`, NOT this job.** The canonical graduate
  path is `git rm -r tenants/team-<…>` for that semester + commit → the `tenants`
  ApplicationSet prunes. If you `kubectl delete ns` WITHOUT removing the tenant dirs
  from git, the tenants ApplicationSet + tenant Apps (selfHeal) RECREATE the
  namespaces. This job deletes Apps+ns for FAST teardown; the `git rm` makes it
  DURABLE. Always do both.

## RBAC
`ServiceAccount cohort-gc` (ns `cohort-gc`) + a cluster-scoped `ClusterRole`:
`namespaces` (get/list/delete) + `applications.argoproj.io` (get/list/delete).
No workload create/patch, no secret access. Privileged maintenance identity —
keep it off tenant runners.

## Pod security
Both jobs run `runAsNonRoot:65532`, `readOnlyRootFilesystem:true`,
`drop:[ALL]`, seccomp `RuntimeDefault`, with an emptyDir at `/tmp` (`HOME=/tmp`)
because kubectl needs a writable cache/config dir (the harbor-onboarding
readOnlyRootFilesystem + /tmp lesson). Namespace enforces PSA `restricted`.

## Open items for review before go-live
- [ ] Flip `preview-ttl` `DRY_RUN` → `false` once the human confirms the selection
      logic on a real preview (none exist in v1 yet).
- [ ] Digest-pin `bitnami/kubectl:1.31.5` (advisory, matches the CI digest-pin posture).
- [ ] Confirm the ArgoCD Application CRD group is `argoproj.io` for `applications`
      in this cluster's Argo version (RBAC + kubectl calls assume it).
- [ ] Decide preview-TTL behavior under the live `pullRequest` generator (safety-net
      vs primary) — see §1.
- [ ] `bitnami/kubectl` `date -d`/`date -v` portability: the script tries GNU then
      BSD `date`; confirm the image's `date` supports `-d` (GNU coreutils — it does
      in bitnami/kubectl, which is Debian-based; the `-v` fallback is belt-and-suspenders).
