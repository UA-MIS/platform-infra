# ADR-062 — The `v1` staleness predicate: unblessed work, not tag age

**Status:** proposed (implements D-202 §6.3 with a deviation)
**Date:** 2026-08-27
**Amends:** ADR-061 §3, `tenant-ci-reuse-design.md` §6.3
**Relates to:** board #184, D-202, PR #584

## Context

D-202 §6.3 and ADR-061 §3 specify the alert as:

> Alert when `v1` is older than 7 days while `main` has moved.

The intent is right and is the design's best idea: because `v1` only advances on a
green canary run, **a tag that stops moving is itself the alarm**. The deviation
here is only in the predicate, not in that insight.

## The specified predicate fires always

`main has moved` is not a proxy for "the pipeline changed". Measured on this
repository, from the current `v1` tag (2026-07-13) to `main` at the time of
writing:

```
commits to main since the tag ............................ 224
  ...of which are unrelated image bumps (ci: bump image) .. 14
  ...of which touch .github/workflows/tenant-build.yaml .... 5
```

`main` carries a continuous stream of `ci: bump image … [skip ci]` commits and
ordinary platform work. It has "moved" 224 times while the reusable pipeline
changed 5 times. So the specified predicate is satisfied on essentially every day
since the tag was cut, whether or not anything relevant happened.

**A permanently-red alert is not a stricter alert; it is a disabled one.** It is
the false positive that trains people to stop reading the alert — which is the
same failure this design exists to prevent one layer down. The 7-day figure is
written as *"say, 7 days"*, which reads as provisional, so this is treated as
sharpening the design rather than contradicting it.

## Decision

Alert on **unblessed work**, in two parts:

```
commits_behind = commits touching .github/workflows/tenant-build.yaml
                 that are newer than the commit the v1 tag points at

ALERT when   commits_behind > 0
       AND   age(OLDEST unblessed commit) >= 3 days
```

**Part 1 — path-scoped, not `main`-scoped.** `commits_behind == 0` means the tag
names the current pipeline, *however old the tag is*. A quiet fortnight no longer
reads as a fault. `commits_behind > 0` means changes exist that the canary has not
blessed: either it is red, or it is not running. That is unambiguous in both
directions, which raw age is not — age produces a false positive on a quiet
fortnight, and a false negative when a canary breaks on day one of one (the case
we actually care about, because the tag would not have moved anyway).

**Part 2 — the grace period keys on the OLDEST unblessed commit.** Three days:
long enough that a change merged on Friday does not page on Saturday, short
enough that a red canary is caught within a working-day cycle. Both raw numbers
are printed so the threshold can be retuned without re-reading the code.

## Why "oldest" is load-bearing, and the bug that proves it

The first implementation keyed the grace period on the **newest** unblessed
commit. Run against the real repository it printed:

```
commits to .github/workflows/tenant-build.yaml newer than the tag: 5
OK: no unblessed changes to the reusable workflow.
```

Those two lines are directly adjacent in the output. The alert could never fire,
because while changes keep landing the newest one is always fresh — so a canary
red for a month reads as healthy, and the check silently becomes decorative.

The question the alert asks is *"how long has work been waiting to be blessed?"*
The answer is the age of the oldest thing still waiting, not the newest. **Do not
"simplify" this back to `behind[0]`.** It looks equivalent, reads more naturally,
and disables the check.

This was caught only by running it. It is recorded here because a future reader
optimising the expression will otherwise reintroduce it, and because the failure
is silent — the check keeps passing, which is indistinguishable from health.

## Status on first run

The implemented predicate fires immediately and correctly:

```
tag v1 -> 25fe22d66c42, tagged 2026-07-13 (44d)
commits behind: 5   (two of them the fail-closed CI fixes #578/#581)
ALERT: oldest unblessed change has waited 11d (grace 3d)
```

So `v1` currently names a pipeline missing yesterday's fail-closed fixes, and any
tenant pinned `@v1` would run without them.

## Consequences

- The alert is quiet when the tag is genuinely current, which is what makes it
  worth reading when it is not.
- It depends on the reusable workflow's **path**. If the pipeline is renamed or
  split, `REUSABLE` in `hack/ci-fleet-drift-report.py` must move with it, or
  `commits_behind` silently becomes 0 — a stale-path failure that reads as
  health. This is the residual risk of the design and is called out rather than
  hidden.
- ADR-059's canary is not yet live, so `v1` is currently a manually-moved tag.
  The predicate is correct in both worlds: today it reports a tag nobody has
  advanced; after ADR-059 it reports a canary that has stopped advancing it.

## Note on where this file lives

ADR-059/060/061 and `tenant-ci-reuse-design.md` live in the **workspace**
`artifacts/` tree, which is **untracked** — the direct cause of the initial
confusion on #584, where a worktree checkout of `platform-infra` contained none
of them. This ADR is placed in `platform-infra`'s tracked
`artifacts/design/decisions/` instead, so that it versions with the code it
governs and is reviewable in the PR that implements it. A pointer stub is left in
the workspace series next to ADR-061.

**Worth its own item:** an approved design and three ADRs that can be edited with
no diff, no history and no review is a weak substrate for decisions of this
weight, and it is the same shape as the other silent-record problems recorded
today.
