# Scaffold partial-failure robustness (idempotency / transactional onboarding)

**Status:** design proposal — DO NOT IMPLEMENT from this doc. Options + a recommendation
for a follow-up story.
**Scope:** the zero-touch scaffolder template
`platform-services/backstage/templates/new-capstone-project-zerotouch/template.yaml`
(and, by symmetry, the imperative `new-capstone-project/template.yaml`).
**Trigger:** an onboarding run created the app repo `UA-MIS/swami` and then a later step
failed, leaving the repo orphaned (created on GitHub, no tenant landed). The failing step
was the claim PR step crashing on the unsupported `autoMerge` input that PR #185 has since
removed — i.e. a **downstream** step failed **after** the irreversible repo creation.
**Related:** ADR-031 (§7 zero-touch onboarding), `docs/operator/crossplane-onboarding.md`,
`artifacts/design/self-contained-scaffolder.md`.

---

## 1. The problem

The template runs its steps sequentially and aborts on the first failure. The current
order (both templates) puts the one hard-irreversible external side effect **early**:

| # | Step (zerotouch) | Action | Side effect | Reversible? |
| --- | --- | --- | --- | --- |
| 1 | `fetch-skeleton[-multi]` | `fetch:template` | writes the scaffolder workspace | yes (in-workspace) |
| 2 | **`publish`** | **`publish:github`** | **creates `UA-MIS/<appName>` + pushes + branch protection** | **NO — orphan risk** |
| 3 | `register` | `catalog:register` | registers catalog-info | yes (idempotent-ish) |
| 4 | `emit-claim` | `capstone:emit-tenant-claim` | writes `./claim/tenants/_claims/<team>-<app>.yaml` (in-workspace) | yes (in-workspace) |
| 5 | `commit-claim` | `publish:github:pull-request` | opens the claim PR on `platform-infra` | mostly (close PR / delete branch) |

Because the Backstage scaffolder has **no native rollback / `onError` / `finally` hook**,
any failure in steps 3–5 leaves the step-2 repo created but the tenant unclaimed. Two
distinct failure classes both produce the orphan:

- **F-A (deterministic, pre-checkable): a bad or reserved name.** `emit-claim` re-validates
  the slugs and enforces the reserved-name denylist (`RESERVED_TEAMS` / `RESERVED_APPNAMES`
  in `emitTenantClaim.ts`), and the template's form patterns validate charset — but the
  **denylist runs only at step 4, after the repo already exists at step 2.** A user entering
  `team: platform` passes the form regex, creates the repo, then fails validation → orphan.
- **F-B (nondeterministic / downstream): a later step crashes.** GitHub API/network blip,
  App-permission gap, a plugin-schema rejection (the swami case: the `autoMerge` input,
  #185), or a branch-name collision on a re-run. The repo is already created → orphan.

Compounding it, the orphan **blocks the retry**: `publish:github` errors with "repository
already exists" on a second run of the same `appName`, so a student cannot simply re-submit —
an org admin must delete the repo first. The app name is effectively "taken" until then.

**Cost asymmetry (drives the recommendation).** An orphaned **repo** is expensive to clean:
manual admin delete/transfer, name blocked meanwhile. An orphaned **claim PR** is cheap: it
never merged, so Crossplane never acted — close the PR / delete the branch, or `git rm` if
merged. The design should push the expensive, irreversible effect as late and as re-runnable
as possible.

---

## 2. Options

### Option 1 — Reorder: all deterministic validation before any side effect
Move the pure, in-workspace `emit-claim` (which carries the slug + reserved-name checks)
**ahead of** `publish`. F-A then fails with **zero** side effects. Nearly free (emit-claim
already runs; it just moves up). Does **not** address F-B on its own (a downstream crash
after publish still orphans). This is a necessary-but-insufficient piece.

### Option 2 — Idempotent, re-runnable pipeline (skip-if-exists)
Make each externally-effecting step safe to re-run so that after **any** failure the
student/operator just re-submits the same form and the run converges:

- `publish:github` → a `skip-if-exists` variant (a small custom `capstone:ensure-repo`
  action, or a `github:repo:get` pre-check that short-circuits publish when the repo already
  exists). Backstage `publish:github` has **no** native skip flag; it hard-fails on an
  existing repo, so this needs a thin wrapper. On a re-run the repo already exists → step is
  a no-op → the pipeline proceeds to land the claim.
- `commit-claim` (`publish:github:pull-request`) is **already** re-runnable: `branchName` is
  deterministic (`claim-<team>-<app>`), and the action updates the existing branch/PR rather
  than failing. No change needed beyond confirming this.

After this, F-B self-heals on retry (publish no-ops, claim PR retries), and no admin
delete is required. Small, localized change; preserves the proven downstream order and the
`register` step's dependency on `steps.publish.output`.

### Option 3 — Reorder so repo creation is the LAST external effect (claim-first)
Land the (cheap, reversible) claim PR **before** creating the (expensive, irreversible)
repo: `fetch → emit-claim → commit-claim → publish → register`. If anything before `publish`
fails, the only residue is an unmerged claim PR (trivially closed); no repo orphan ever.
Requires decoupling the claim PR body from `steps.publish.output.remoteUrl` — construct the
deterministic URL `https://github.com/UA-MIS/<appName>` inline (owner is fixed, repo name =
appName), which the template already relies on everywhere else. Caveat: a reviewer could
merge the claim before the repo exists, so Crossplane starts wiring a not-yet-created repo —
mitigated by the 1-click human merge happening only after the scaffold reports success, and
by provider-github tolerating an absent repo until it appears.

### Option 4 — Cleanup-on-failure (compensating delete)
A finalizer that deletes the freshly-created repo if a later step fails (saga-style
compensation). Backstage has no `finally`/`onError` step, so this can't be expressed in the
template; it needs either a custom orchestration wrapper or an out-of-band reaper (below).
Also risky: auto-deleting a repo that may already contain a student's first push is
destructive. Rejected as the primary mechanism.

### Option 5 — Orphan reaper (backstop, not primary)
A scheduled report/job that lists `UA-MIS/*` repos scaffolded by The Process with **no**
matching `tenants/_claims/<team>-<app>.yaml` on `platform-infra main` **and** no open claim
PR, older than N minutes → surface to an operator (or auto-delete only if the repo is still
the empty scaffold). Catches residue when nobody re-runs. Complements, does not replace, 1–3.

---

## 3. Recommendation

Adopt **Option 1 + Option 2** as the primary fix, with **Option 5** as a backstop.

**Recommended step order (zerotouch template):**

```
fetch-skeleton[-multi]        # in-workspace, reversible
emit-claim                    # pure validate + render (slug + reserved-name denylist) — MOVED UP
publish  (skip-if-exists)     # the only hard-irreversible effect; now idempotent on re-run
register
commit-claim                  # deterministic branch → already re-runnable
```

Why this combination:

- **Kills F-A at zero cost.** A bad/reserved name now fails at `emit-claim` **before** any
  repo is created (Option 1). This is the fail-closed guarantee the denylist was written for,
  finally enforced ahead of the side effect.
- **Makes F-B self-healing (the actual swami failure).** With `publish` skip-if-exists and
  the already-deterministic claim PR branch, re-submitting the same form after *any*
  downstream crash converges: publish no-ops on the existing repo, the claim PR is
  (re)opened, done. No org-admin repo deletion, no blocked name. This directly fixes the
  class of failure that orphaned swami (a downstream step crash post-publish).
- **Minimal, low-risk surface.** One step reordered + one thin `capstone:ensure-repo`
  wrapper action. It preserves the proven downstream order and the `register` →
  `steps.publish.output` dependency, so no URL rework and no change to the Crossplane
  contract. Full saga/2-phase-commit (Option 4) and the claim-first reorder (Option 3) are
  larger changes for marginal additional safety; documented as alternatives.
- **Backstop.** Add the Option 5 reaper as a separate, lower-priority follow-up so that runs
  which are never retried don't accumulate silent orphans.

**Explicitly deferred:** Option 3 (claim-first reorder) — revisit only if Option 2's
skip-if-exists proves insufficient; Option 4 (auto-delete compensation) — rejected as
primary (destructive, and unexpressible without a custom orchestrator).

---

## 4. Implementation notes for the follow-up story (not built here)

- New action `capstone:ensure-repo` (or a `skipIfExists: true` option on a wrapper around
  `publish:github`) in
  `platform-services/backstage/app/plugins/scaffolder-backend-module-capstone/` — mirrors the
  existing custom-action pattern (`emitTenantClaim.ts`); needs a unit test and a Backstage
  **image rebuild + redeploy** (same gate noted in the template header for
  `capstone:emit-tenant-claim`).
- Reordering `emit-claim` above `publish` is a pure template edit (no image rebuild), but
  ships most cleanly with the ensure-repo action in the same rebuild.
- Apply the same reorder to the imperative `new-capstone-project/template.yaml` (its
  `harbor-onboard` / `render-tenant` steps sit after `publish` with the identical exposure).
- Reaper (Option 5): a CronJob or a GitHub Action on `platform-infra`; read-only report
  first (list orphans), auto-delete gated behind an explicit opt-in and an "empty scaffold"
  check.
- Confirm on the installed plugin version that `publish:github:pull-request` updates an
  existing `branchName` (re-run safety) rather than erroring — validate before relying on it.
