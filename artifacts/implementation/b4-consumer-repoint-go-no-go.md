# B4 consumer repoint — go/no-go and rollback

Split out of PR #442 (Harbor `dockerhub-proxy` infra) per reviewer-readiness's
B4-002 finding: the consumer repoint (shared CI job container +
20 scaffolder Dockerfiles) turns a rate-limit annoyance into a single point of
failure across all tenant CI, with no fallback if Harbor is unreachable at
build time. That risk deserves its own explicit decision, not a bundled
merge — this document is that decision surface.

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

No fallback mechanism is implemented in this PR — Option B is scoped but not
built. This PR as committed is Option A.

## Recommendation

Given classes start 2026-08-19 and Harbor has already shown one real
provider-level surprise this session (the async-reconcile misread that caused
B4-001), the safer default is **C now, B later**: hold this PR, ship #442
(infra only) for the semester start, and revisit the repoint — likely with a
retry/fallback wrapper — once there's a normal week to verify it properly
rather than four days before go-live.

This is a recommendation, not a unilateral call — flagged to the orchestrator
per the reviewer's request. Whoever approves this PR is making the go/no-go
decision; this document exists so that decision is explicit rather than
implicit in a merge click.

## Rollback (if merged and then reverted)

Single clean revert: `git revert <this-PR's-merge-commit>` restores every
`FROM` line and the CI container image to their pre-repoint (Docker Hub
direct) values. No data migration, no state to clean up — this is a pure
pull-path change with no persistent side effects. The `dockerhub-proxy`
project itself (from #442) is unaffected either way and can stay live
whether or not this PR merges.

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
