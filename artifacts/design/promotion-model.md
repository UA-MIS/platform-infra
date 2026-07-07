# Promotion model redesign — click-to-promote prod

**Status:** STAGED — option (a) is implemented on this branch but NOT merged (see
PR). Presented here for review; human approval requested before merge (this
changes prod's ArgoCD sync behavior — see §5).

**Source:** `artifacts/planning/post-demo-hardening-backlog.md` § "Promotion
model redesign — click-to-promote prod" (logged 2026-07-03).

## 1. The problem

`promotion.yaml` (`platform-services/backstage/templates/_fragments/_contract/.devops/promotion.yaml`)
gave prod the same trigger as staging:

```yaml
staging: { trigger: "tag:v*", tagConvention: "semver", gate: auto }
prod:    { trigger: "tag:v*", tagConvention: "semver", gate: manual }
```

`trigger` is read by the app repo's CI (`resolve-image.sh`) to decide what a
git event resolves to; the actual overlay-write is a separate, currently-manual
step (`bump-image.sh <env> <tag>`, per `.devops/ci/RUNBOOK.md`). Because
staging and prod share the identical trigger/tagConvention, the RUNBOOK's own
worked examples show them bumped back-to-back for every release tag:

```sh
COMMIT=1 sh .devops/ci/bump-image.sh staging 1.4.0
COMMIT=1 sh .devops/ci/bump-image.sh prod 1.4.0
```

That conflates "I want this build in staging for QA" with "I want this build
in prod." Every semver tag makes prod's *desired* git state = the latest tag,
so prod either (a) drifts OutOfSync the moment someone bumps it out of habit,
or (b) if nobody bumps it, silently lags with no clean way to say "yes,
staging's current build is good — ship it" without re-deriving a tag or
hand-editing the overlay.

**User's vision (from ADO release-pipeline experience):** a human clicks a
**gate** → whatever is currently running in staging is promoted to prod,
*without editing code*. The click is the approval; nothing else changes.

## 2. Options considered

| | (a) `workflow_dispatch` Action | (b) Backstage promote button | (c) Kargo (Akuity) |
|---|---|---|---|
| **Mechanism** | GitHub Action, human clicks "Run workflow," reads staging's live tag, writes+commits it to prod's overlay | A Backstage `scaffolder`/custom action or entity-page button that does the same write, surfaced in The Process UI | Dedicated CD control-plane: `Warehouse` (freight source) → `Freight` (bundled artifact) → `Stage` (promotion pipeline with steps: `git-clone`, `kustomize-set-image`, `git-commit`, `git-push`, `argocd-update`); manual `Freight` approval per Stage |
| **New infra** | None — reuses the existing ARC runners + `harbor-push`-adjacent write path | None new, but needs a Backstage action registered + RBAC on who can click it | A new **control plane**: Kargo controller + CRDs (`Project`/`Warehouse`/`Stage`/`Freight`/`Promotion`) running in-cluster, its own UI, its own git-write identity |
| **Effort** | Small — one script (`promote.sh`, ~90 lines, reuses `bump-image.sh`) + one workflow. Implemented on this branch. | Medium — needs a Backstage custom action or `scaffolder-backend` plugin, entity-page affordance, and auth wiring so only the right people can click it | Large — install + operate a new platform component, model 4 envs as Warehouses/Stages, migrate every tenant's promotion instead of editing one shared template file |
| **UX** | GitHub Actions "Run workflow" form (env dropdown) — familiar to anyone who's used Actions, but lives outside Backstage/The Process | Best fit to "The Process is the one pane of glass" — click a button on the app's Backstage page, no context-switch to GitHub | Best fit to the literal ADO mental model: a pipeline view with named stages and a promote button per stage, richer approval/verification (`AnalysisRun`) support |
| **Fit to the ADO flow** | Good — "click Run, review the diff, done." Closest single-file, single-PR change to the requirement. | Good, and closer to "one portal" — but a UI feature request, blocked on Backstage plugin work not yet scoped | Best — Kargo's Freight model is *literally* "what's running in Stage N, promote it to Stage N+1," including verification gates and rollback, which is exactly the ADO shape, but it's a new system to learn/run/secure |
| **Blast radius if wrong** | Low — a bad promotion is one git commit, revertable; workflow only ever writes the target overlay's `images[].newTag` | Low, same write, plus a new Backstage RBAC surface to get right | Medium — a new control-plane identity with git-write + cluster-read across every tenant Project; more to secure per `security-review` |
| **Per-tenant rollout** | One shared file in `_fragments/_contract` (already the single-source-of-truth pattern this platform uses) | Same file + a Backstage plugin shared across all tenants | Requires a `Project`/`Warehouse`/`Stage` set PER TENANT — a new onboarding step (fits the Crossplane zero-touch onboarding track, but is new surface area) |

## 3. Recommendation

**Ship (a) now** (this PR) — it directly satisfies "a human clicks a gate,
whatever's in staging goes to prod, no code edit," with no new infrastructure
and a small, testable diff. It is not mutually exclusive with (b): once (a)'s
script exists, a Backstage button is just a thinner UI in front of the same
`promote.sh` write path — genuinely a follow-up, not a redo.

**Evaluate (c) Kargo later**, if/when: promotions need verification steps
(smoke test before prod, not just "the human trusts staging"), teams want a
visual pipeline instead of a GitHub Actions form, or rollback-to-previous-Freight
becomes a recurring need. Given the platform is still mid-hardening (Vault DR,
observability, reusable-CI — see the roadmap in `artifacts/planning/`), adding
a whole second control plane now is premature; (a) buys the actual UX the user
asked for at near-zero cost and doesn't foreclose (c) later — Kargo can adopt
existing ArgoCD `Application`s without a rewrite of the chart/overlay layout
this platform already has.

**Not recommended standalone:** (b) before (a) — it's strictly more effort for
the same mechanism (a) already provides; do it as a UI wrapper around (a)'s
script once/if The Process wants a promote button, not as the first cut.

## 4. What's implemented on this branch (option a)

Scoped to the `_fragments/_contract` skeleton (the platform template every new
app repo renders from) and the tenant env `ApplicationSet` template:

- **`promotion.yaml`** — prod's `trigger` changed from `"tag:v*"` to
  `"manual:promote-to-prod"` (no git event writes prod's overlay anymore).
  prod's `gate` changed from `manual` to `auto` (§5 explains why).
- **`.devops/ci/promote.sh`** (new) — reads the tag currently live in
  `<from>`'s overlay (refusing to promote if that overlay's components
  disagree on a tag — a hand-edited/partial state), then hands off to the
  existing `bump-image.sh` to write + `COMMIT=1` commit it into `<to>`'s
  overlay. Unit-tested: `.devops/ci/promote.test.sh` (9 assertions: happy
  path, dry-run-doesn't-commit, `COMMIT=1` produces the `[skip ci]` commit,
  `from == to` is refused, a mismatched source overlay is refused).
- **`.github/workflows/promote-to-prod.yaml`** (new) — `workflow_dispatch`
  with `from`/`to` choice inputs (default `staging` → `prod`), runs
  `promote.sh` with `COMMIT=1`, pushes to `main`. The human clicking "Run
  workflow" *is* the gate; the workflow does the bump. No code edit.
- **`tenants/_template/applicationset-envs.yaml`** — comment-only update; the
  templatePatch logic was already fully data-driven off `promotion.yaml`'s
  `gate` field, so the `gate: auto` change above required no template-code
  change, just a note explaining why prod is now `auto`.
- **`.devops/ci/RUNBOOK.md`, `.devops/README.md`** — updated to document the
  new prod row/flow and `promote.sh` instead of the old manual
  `bump-image.sh prod <tag>` example.

## 5. Design decision flagged for review: prod's ArgoCD gate is now `auto`

The backlog note asks for "prod stays Synced/green normally, OutOfSync only
on a deliberate promotion" — that describes a **transient** OutOfSync window
(commit → next ArgoCD reconcile → back to Synced), not the old behavior where
prod sat OutOfSync indefinitely until someone remembered to click "Sync" in
the ArgoCD UI. Getting that requires prod's `gate` to be `auto`: the human
approval now happens at "click Run workflow," and ArgoCD becomes a pure
executor of the already-approved git state, same as staging/dev today.

**Trade-off being made explicit:** this removes the second manual
click-to-sync in ArgoCD that the old `gate: manual` gave prod as a
defense-in-depth backstop (commit lands, but a human still has to
separately approve the sync). With this change, a compromised or buggy
promote-to-prod run reaches the cluster on ArgoCD's next reconcile with no
second human checkpoint. Given the workflow only ever (1) reads an
already-built, already-live staging tag and (2) writes that exact string
into prod's overlay — it cannot introduce a *new* image, only re-point to one
already running in staging — the residual risk is small, but it is a real
change in prod's blast-radius shape and should be confirmed at PR review, not
assumed. If the reviewer prefers to keep the second click, flip prod's `gate`
back to `manual` — everything else in this PR (the script, the workflow, the
decoupling from `tag:v*`) is unaffected either way.

## 6. Known adjacent gap (not fixed here, flagged for the human)

`promote.sh staging prod` promotes whatever tag is **currently written** in
staging's overlay `kustomization.yaml`. Today, nothing auto-writes that file
either — `build-and-push.yaml`'s only CI-triggered job is `bump-dev` (on push to
`main`); staging's overlay is bumped by the same manual
`COMMIT=1 bump-image.sh staging <tag>` step the old RUNBOOK documented. That
means "promote to prod" is trustworthy only if a human first ran that manual
staging bump after pushing a release tag — a real but pre-existing two-step
manual flow, not something this PR introduces or worsens. Auto-bumping
staging (a `bump-staging` job mirroring `bump-dev`, gated on `refs/tags/v*`)
would close the loop end-to-end and is a natural fast-follow, tracked
alongside the reusable-CI/script-centralization work already on the roadmap
(`artifacts/planning/post-demo-hardening-backlog.md`) rather than folded into
this already-staged change.

## 7. Not touched (by design, to keep this PR minimal)

- `resolve-image.sh` still labels a fresh `refs/tags/vX.Y.Z` push as
  `ENV=prod` — but only to read the (shared) `registry`/`app`/`tagConvention`
  metadata for the image staging pins; it never writes prod's overlay. The
  label is now stale/cosmetic and could be renamed to `staging` for clarity
  in a follow-up; left alone here since it's shared, unit-tested
  (`resolve-image.test.sh`) machinery with no functional dependency on the
  literal string.
- The other 10 already-rendered per-template copies of `promotion.yaml` /
  the CI scripts (`react-static`, `dotnet-aspnet-api`, `nextjs-fullstack`,
  etc.) are **physically duplicated**, not generated from `_fragments/_contract`
  — a known "copy-not-reference" issue (see the v1 retro). This PR updates
  the canonical `_fragments/_contract` source only; propagating to existing
  template copies is out of scope here and is exactly the kind of drift the
  in-flight reusable-CI/script-centralization effort is meant to eliminate.
