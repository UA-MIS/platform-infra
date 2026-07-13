# cohort-gc — preview-TTL + cohort-cleanup CronJobs (DRAFT)

> **STATUS: DRAFT for human review — do NOT merge as-is without the gotchas below
> resolved.** Both jobs default to `DRY_RUN=true`; cohort-cleanup is `suspend:true`.

Two platform garbage-collection jobs that lean on the universal tenant labels
(`platform.capstone/{team,semester,env}` — present on every tenant object, see
`tenants/_template/`). Deployed as `platform-svc-cohort-gc` via the
`platform-services` ApplicationSet (directory generator over `platform-services/*`).

## 1. preview-ttl (`preview-ttl-cronjob.yaml`) — the 12h HARD-DEATH enforcer
- **Schedule:** hourly. A preview HARD-DIES at `TTL_HOURS` (default **12h**) measured
  from CREATION, **even if the PR is still open**. It scans preview Applications
  (`platform.capstone/env=preview`, named `<team>-pr-<n>`) and acts on any whose App
  `creationTimestamp` is older than the cutoff.
- **Removes the `preview` LABEL from the PR — it does NOT `kubectl delete` the App.**
  The appset's `pullRequest` generator creates a preview IFF the PR carries the
  `preview` label. Deleting the App is futile (`selfHeal`/`prune` + generator recreate
  it within ~120s while the PR is open); removing the label removes the generator's
  INPUT, so the element is dropped, `prune:true` tears the App+ns down, and it does
  **not** come back. That is what makes 12h a hard cap instead of "lives while the PR
  is open".
- **App → PR mapping:** PR number = the trailing digits of the App name (`<team>-pr-<n>`);
  repo = `spec.source.repoURL` (`https://github.com/UA-MIS/<appName>` → `UA-MIS/<appName>`).
- **Revival = re-run CI.** `.github/workflows/tenant-build.yaml` re-adds the `preview`
  label on every PR-triggered run, so re-running the CI job re-creates the preview with
  a FRESH 12h window. (A mid-life push also re-asserts the label but does not reset the
  live App's `creationTimestamp`, so a push does not extend the 12h — the cap is per
  creation/revival, by design.)
- **GitHub auth:** a CronJob has no per-repo `GITHUB_TOKEN`, and the label strip spans
  every tenant repo, so it mints a `ua-mis-backstage` GitHub App **installation token**
  (hand-rolled RS256 JWT → `/app/installations/<id>/access_tokens`; the `alpine/k8s`
  image ships NO openssl CLI — verified live — so the signature is python3-ctypes →
  the image's `libcrypto.so.3`, plus curl+jq). It **reuses** the already-sealed App creds in the `argocd`
  secret `argocd-repo-creds-uamis` (the same App+secret the generator uses to list PRs)
  via a scoped, single-secret cross-namespace read (see RBAC). **⚠ The App installation
  must have `Pull requests: Write`** (label management); it is provisioned with `Read`
  for the generator's list — grant write or the strip fails LOUD (403 → exit 13; the
  token itself still mints fine with `Read`, so the failure is at the label DELETE).

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
Plus a **namespaced `Role`+`RoleBinding` in the `argocd` namespace**
(`cohort-gc-read-gh-app`) granting `get` on **exactly one** secret
(`argocd-repo-creds-uamis`, via `resourceNames`) — the GitHub App creds preview-ttl
mints its installation token from. No blanket secret read, no delete on claims/appsets
(those go via `git rm`), no workload create/patch. Privileged maintenance identity —
keep it off tenant runners.

## Pod security
Both jobs run `runAsNonRoot:65532`, `readOnlyRootFilesystem:true`,
`drop:[ALL]`, seccomp `RuntimeDefault`, with an emptyDir at `/tmp` (`HOME=/tmp`)
because kubectl needs a writable cache/config dir (the harbor-onboarding
readOnlyRootFilesystem + /tmp lesson). Namespace enforces PSA `restricted`.

## Open items for review before go-live
- [ ] **Grant `Pull requests: Write` on the `ua-mis-backstage` App installation**
      (currently `Read` for the generator's PR list). Without it preview-ttl mints the
      token fine but the label-strip `DELETE .../labels/preview` returns 403 and the job
      exits LOUD — the preview would not hard-die. This is the one external prerequisite.
- [x] ~~Confirm the `alpine/k8s:1.31.5` image ships the `openssl` CLI~~ — verified live:
      it does NOT (preflight exited 10 on the first smoke run). The RS256 sign now uses
      python3-ctypes → the image's `libcrypto.so.3` (signature verified against
      `openssl dgst -verify` both locally and from inside the image on-cluster). The job
      preflights `python3/curl/jq/kubectl/base64` + a libcrypto load and exits 10 if any
      is missing, so a regression stays loud.
- [ ] Flip `preview-ttl` `DRY_RUN` → `false` once the human confirms the label-strip
      selection on a real >12h preview. **`DRY_RUN=false` (ENFORCING) is set here** — dry-run
      first by patching the CronJob env if you want to observe a cycle before enforcing.
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
- [x] preview-TTL behavior under the live `pullRequest` generator DECIDED: it is the
      PRIMARY 12h hard-death, enforced by stripping the `preview` label (which the
      generator requires) rather than deleting the App (futile — recreated). See §1.
- [x] `date` portability: fixed for BusyBox. The `alpine/k8s` image's BusyBox `date`
      supports NEITHER GNU `-d "-N hours"` NOR BSD `-v` (both exit 1 — dead on every run,
      even DRY_RUN). The cutoff now uses POSIX epoch arithmetic (`NOW - TTL_HOURS*3600`)
      and each ns timestamp is parsed with BusyBox strptime (`date -D '%Y-%m-%dT%H:%M:%S'
      -d "${TS%Z}"`). No GNU-only or BSD-only `date` flags remain.
