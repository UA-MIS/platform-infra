# B4 consumer repoint — go/no-go and rollback

**DECIDED: D-087 — the repoint STAYS.** Team-lead signed off after weighing
the risk analysis below. Rationale (team-lead's own words): two live 429s
during light testing today make Tuesday rate-limiting near-certain, while
Harbor-down is lower-probability, well-alerted, build-only, and self-healing.
This document is kept (not deleted) as the record of that decision and the
risk it was made against — see "Decision" below for the full reasoning, and
"Known caveat" for one operational gap the decision doesn't resolve.

Originally split out of PR #442 (Harbor `dockerhub-proxy` infra) per
reviewer-readiness's B4-002 finding: the consumer repoint (shared CI job
container + 20 scaffolder Dockerfiles) turns a rate-limit annoyance into a
single point of failure across all tenant CI, with no fallback if Harbor is
unreachable at build time.

## What this PR does

Same content as the reverted `be4669e` commit on the infra PR: repoints
`.github/workflows/tenant-build.yaml`'s job container and 20 of 22 scaffolder
fragment Dockerfiles from Docker Hub directly to
`harbor.capstone.uamishub.com/dockerhub-proxy/library/<image>:<tag>`.

**Depends on #442 (the infra PR) merging first.** The `dockerhub-proxy`
project must exist and be healthy before any of these `FROM` lines can
resolve. Do not merge this before #442.

## The actual risk (why this needed its own decision)

A Docker Hub `FROM` line degrades gracefully in exactly one way today:
Docker Hub itself is extremely unlikely to be fully down, and even at the
anonymous rate limit a retry eventually succeeds. A single-registry `FROM`
line has **no such degradation** — if `harbor.capstone.uamishub.com` is
unreachable, misconfigured, or the `dockerhub-proxy` project is deleted,
**every tenant CI build fails immediately**, for every team, simultaneously.
Before this change, that same outage would have zero effect on builds (they
never touch Harbor for base images at all).

This is a real trade: fewer 429s from Docker Hub, in exchange for making
Harbor's uptime a hard dependency of the build pipeline, not just the push
target it already is. Harbor being unreachable already breaks the *push* step
today, so this argument is partially "the SPOF already exists, this extends
it earlier in the pipeline" — but it's still a strictly larger blast radius
(the deps/build stage now needs Harbor even for PR builds that never push),
so it is not risk-neutral.

## Options

| Option | What it means | Trade-off |
|---|---|---|
| **A. Merge as-is** | Every fragment + the CI container depend on Harbor for base images | Simplest; highest blast radius on a Harbor outage |
| **B. Add a documented fallback** | e.g. Kaniko/BuildKit multi-registry FROM fallback, or a CI-level retry that falls back to `docker.io` if the proxy 5xxs | Removes the SPOF; more moving parts, needs its own verification |
| **C. Hold indefinitely** | Keep base images on Docker Hub directly; treat B4 as infra-only (cache exists, opt-in per-consumer later) | Zero new risk; Docker Hub rate-limit exposure remains exactly as it is today |

No fallback mechanism is implemented in this PR — Option B remains a scoped,
unbuilt follow-up (see "Known caveat" and the backlog note below). This PR as
committed is Option A.

## Decision (D-087 — Option A, signed off by team-lead)

My original recommendation was Option C (hold). Team-lead's ruling was
Option A (merge as-is), on this reasoning:

- **The rate-limit side is no longer theoretical.** Two separate live Docker
  Hub 429s were hit during ordinary testing today (one during this task's own
  work, one during an unrelated FIX-9 race-replay test) — both from light,
  single-agent traffic. Scaled to ~20 teams' CI running concurrently on
  2026-08-19, rate-limiting is treated as near-certain, not a tail risk.
- **The Harbor-down side is comparatively contained.** Harbor already has to
  be up for every tenant's *push* step to work — this repoint only moves that
  same dependency earlier in the pipeline (deps/build stage, not just push).
  A Harbor outage is lower-probability than Docker Hub rate-limiting, is
  already alertable (ArgoCD/Harbor health monitoring), fails at *build* time
  (loud, visible in the CI log — not a silent runtime failure), and is
  self-healing the moment Harbor recovers (no stuck state, no manual cleanup).

Net: the risk this document flagged is real but was judged smaller than the
risk it was traded against. Option B (a retry/fallback wrapper) remains the
better long-term shape and is left as a backlog item, not a blocker for this
decision.

## Known caveat (does not block D-087, but must be tracked)

**Copy-at-scaffold means a future rollback of this template will NOT reach
already-scaffolded repos.** The tenant contract
(`platform-services/backstage/templates/_fragments/_contract/`) is copied
into each team's repo at scaffold time, not referenced live — this is the
same "copy-not-reference" pattern already flagged elsewhere in this platform
as the root cause of several past onboarding bugs (a template fix ships, but
repos scaffolded before the fix keep the old content forever unless someone
manually backports it). Concretely: if `dockerhub-proxy` is ever
decommissioned or this decision is later reversed, every repo scaffolded
*after* this PR merges keeps its proxied `FROM` lines and the shared CI job
container reference regardless of what the template says going forward —
they do not follow a template-level revert. A platform-level rollback of this
PR only changes what *new* scaffolds get; existing repos would need an
individual, per-repo fix (or a documented "if this ever needs to be undone,
here is the sed/PR-bot pass across live repos" runbook, which does not exist
today).

## Rollback (template level — see caveat above for its limits)

Single clean revert: `git revert <this-PR's-merge-commit>` restores every
`FROM` line and the CI container image to their pre-repoint (Docker Hub
direct) values **for future scaffolds**. No data migration, no platform-side
state to clean up — this is a pure pull-path change with no persistent side
effects at the platform layer. The `dockerhub-proxy` project itself (from
#442) is unaffected either way. Already-scaffolded repos are NOT touched by
this revert — see "Known caveat" above.

## Verification already done (carries over from the reverted commit)

- All 14 distinct base image tags used anywhere in the fragment tree
  confirmed pullable through the proxy via live `skopeo` pulls before any
  file was edited.
- Two real end-to-end `podman build` runs (multi-stage Node app,
  single-stage nginx) against the edited Dockerfiles with their actual
  skeleton source as build context — both built clean.
- Full grep audit of every remaining `FROM`/`ARG` line post-edit confirmed
  nothing was missed, double-prefixed, or wrongly touched.

None of that changes the SPOF analysis above — it proves the repoint
*works*, not that an unreachable Harbor is an acceptable failure mode this
close to go-live. That's the decision this document is for.
