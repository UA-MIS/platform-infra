# Crossplane stale-Managed-Resource prune

A scheduled, **default-dry-run** CronJob that reclaims apiserver memory and clears
teardown residue by deleting **orphaned Crossplane Managed Resources (MRs)** — the
composed resources left behind by torn-down / failed / churned tenants (the
`swami`/`computa` leftovers, the 2026-07-10 duplicate-claim wreckage, orphaned Harbor
robots / Vault roles / DatabaseRoles / provider-kubernetes `Object`s).

The apiserver caches every object and every Crossplane provider watches all of its
MRs, so stale MRs cost real memory. Removing an orphaned MR (a) frees that cache/watch
overhead and (b) — because the delete goes through the provider's normal finalizer —
tells the provider to delete the external resource too (the Harbor robot, Vault
policy, DB schema), finishing the teardown.

## What it does NOT do

- It never deletes a **`CapstoneTenant` XR** (those are the git-committed onboarding
  ledger in `tenants/_claims/` — a human/GitOps action, never this job).
- It never touches a **live tenant's** MRs — even if an MR is failing (`computa`'s
  Harbor Project is `Ready=False` today; because `computa-computa` is live, it is left
  alone).
- It never **force-removes finalizers** — the RBAC grants no `patch`/`update`, so it
  structurally cannot. Stuck deletions are reported, not forced (forcing would abandon
  the provider's external cleanup and re-create the exact residue we're clearing).

## Schedule

`0 4 * * 0` — **weekly, Sunday 04:00 UTC** (`spec.schedule` in `cronjob.yaml`, the
knob). Rare by design: reclaiming stale MRs is not urgent, and churn is the actual
risk this cluster has been bitten by (the 07-10 incident was claim churn). Run it more
often only if teardown residue accumulates faster than weekly.

## Orphan-detection logic (exact)

For each composed-MR kind the Composition renders, the script reads three fields:
`crossplane.io/composite` label, the `CapstoneTenant` ownerReference name, and
`deletionTimestamp`. An MR is pruned **only** when ALL of these hold:

1. It carries a `crossplane.io/composite` label **and/or** a `CapstoneTenant`
   ownerReference (else it isn't a CapstoneTenant composite → never touched).
2. If both are present they **agree** (same tenant name). A mismatch → `SKIP(conflict)`.
3. That owning tenant name is **NOT** in the live set
   (`kubectl get capstonetenants`) → the owner XR no longer exists.
4. **Shared-team guard**: the owner XR name does not map to a **team a different live
   tenant still uses**. XR names are `<team>-<app>`; if an orphan named `<liveteam>-*`
   (or exactly `<liveteam>`) is found while that team is still live via another
   tenant, it is `SKIP(shared-team)` — deleting it could cascade-delete a shared
   namespace / Harbor project / Vault policy out from under the live tenant. This
   mirrors the 07-10 incident runbook ("orphan-before-delete / don't prune shared").

Conservative / false-negative-safe: when any check is ambiguous, it SKIPs and logs
rather than deletes. **Abort guard**: if the `CapstoneTenant` CRD is missing or the
tenant list can't be read, the job aborts (it never concludes "everything is
orphaned"). An MR already `deletionTimestamp`'d longer than `STUCK_THRESHOLD_HOURS`
(default 24h) is additionally flagged `STUCK-DELETING` (a blocked provider finalizer).

### Kinds in scope (1:1 with the Composition's composed resources)

`objects.kubernetes.crossplane.io`, `projects.project.harbor.crossplane.io`,
`robotaccounts.robotaccount.harbor.crossplane.io`, `policies.vault.vault.upbound.io`,
`authbackendroles.kubernetes.vault.upbound.io`,
`databases`/`users`/`grants.mysql.sql.crossplane.io`,
`roles`/`databases`/`grants.postgresql.sql.crossplane.io`.

## DRY_RUN default (safe to merge)

`cronjob.yaml` ships `env DRY_RUN="1"`. In dry-run the job lists every orphan as
`WOULD-PRUNE <kind>/<name>: owner CapstoneTenant '<xr>' no longer exists` and prints a
per-kind summary, but **calls no `kubectl delete`** — merging this changes zero live
state. It stays a no-op until a human deliberately flips the switch.

## RBAC scope

A dedicated `crossplane-mr-prune` ServiceAccount bound to a hand-curated ClusterRole
(`rbac.yaml`) — **never cluster-admin, never `*`**:

- `get`/`list` on `capstonetenants` + `customresourcedefinitions` (build the live set;
  abort guard).
- `get`/`list`/`delete` on **exactly** the composed-MR kinds above — no `create`,
  `update`, or `patch` **anywhere** (so it can only read and delete, never mint,
  mutate, or strip a finalizer), and no `managed`-category wildcard (which would grant
  delete over hundreds of unrelated `*.vault.upbound.io` / `*.sql.crossplane.io` CRDs).

## Review the dry-run, then enforce

1. **Read a dry-run.** Wait for a scheduled run, or trigger one on demand:
   ```
   kubectl -n crossplane-system create job --from=cronjob/crossplane-mr-prune mr-prune-dryrun
   kubectl -n crossplane-system logs job/mr-prune-dryrun
   ```
   Confirm the `WOULD-PRUNE` lines and the `TOTAL … would-prune=N` summary name only
   MRs of tenants you know are gone. Investigate any `SKIP(conflict)` /
   `SKIP(shared-team)` before enforcing.
2. **Enforce.** In git, set `DRY_RUN: "0"` in `cronjob.yaml` and merge. The next run
   (or an on-demand `create job --from=…`) deletes the orphans and logs
   `PRUNE …` + `TOTAL … deleted=N`. Provider finalizers then clean up the external
   Harbor/Vault/DB resources.
3. **Roll back** anytime by setting `DRY_RUN` back to `"1"`.

## Limitation

This prunes MRs **still present** in the cluster (the ones costing apiserver memory).
An external resource whose MR is **already gone** (deleted with `Orphan` policy, or
GC'd while its provider was down) is invisible to a k8s-native prune and needs the
provider-specific cleanup (Harbor/Vault API) — out of scope here, tracked separately.
