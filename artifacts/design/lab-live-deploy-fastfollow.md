# Lab CI/CD live-deploy fastfollow — scoping note (option B)

Status: SCOPING ONLY, not built, not scheduled. Written per team-lead's
direction during task #9 (D-106) to give faults 02/03 a concrete
cross-reference for their "activates once a lab deploy path exists" note.
Nothing in this document is authorized to build — it is the human's decision
to make, same as the two-tier tenant model it overlaps.

**Cross-repo reference note:** this note was authored alongside the broader
task #9 build in the orchestration workspace, which tracks several documents
not (yet) committed to this repo: `artifacts/design/lab-cicd-exercise-design.md`
(the full lab exercise design), `artifacts/design/architecture-two-tier-tenant-model.md`
plus ADR-038/ADR-039 (the pending tenant-model decision this note overlaps
with, STAGED FOR HUMAN APPROVAL), `artifacts/implementation/lab-cicd-proof.evidence.yaml`
(Phase 2 proof), and `artifacts/reviews/review-lab-cicd-exercise-phase1-2.md`
(the review that found the gap this note addresses). Paths below referencing
those live in that workspace, not this repo, as of this PR — flagging this
plainly rather than leaving silently-broken-looking links for a reader who
only has `platform-infra` checked out.

## The gap this would close

Task #9's Phase 2 proof (`artifacts/implementation/lab-cicd-proof.evidence.yaml`)
found that lab repos generated from `UA-MIS/lab-cicd-base` have no Harbor
project, robot credential, or ArgoCD Application/AppProject — by design,
because a lab team is explicitly **not** a capstone tenant
(`artifacts/design/lab-cicd-exercise-design.md` Sec2.2's rejected-options
table). D-106 added a baseline-green guard so CI still builds+tests cleanly
without one, but that also means the fault catalog's live-observability
faults can't function as designed today:

- **Fault 03** (staging/prod overlay swap) degrades gracefully — it's fully
  diagnosable at the git/`promotion.yaml` level, so it shipped in the
  initial roster with its live-ArgoCD verification steps clearly marked as
  the "once a deploy path exists" bonus, not the primary signal.
- **Fault 02** (Service/Ingress naming mismatch) does NOT degrade gracefully
  — deck-reviewer's review (`artifacts/reviews/review-lab-cicd-exercise-phase1-2.md`)
  proved it has **zero observable signal** without a live deploy: the patch
  keeps Service and Ingress mutually consistent by design (the milder,
  app-stays-up variant), so there's nothing to spot by comparing the two
  files, CI doesn't touch anything that fails, and `kubectl kustomize`
  renders all four overlays clean before and after the patch. It is HELD out
  of the initial roster entirely (not injectable today) — see
  `platform-infra/tools/lab-cicd/faults/02-break-observability/SYMPTOM.md`.
  This fastfollow is what reactivates it, unmodified.

## What "minimal" would mean

Not full tenant provisioning. The smallest slice that gives a lab repo a
real place to deploy to, without any of the things Sec2.2 explicitly ruled
out (no AppProject namespace-per-tenant sprawl, no Vault policy, no
`tenants/_claims/*` XR, no per-team RBAC/quota/netpol stack):

1. **One Harbor project per lab repo** (or one shared `lab-cicd` project
   with per-repo robot scoping, cheaper if Harbor's project-count at scale
   matters) with a push-scoped robot account — this alone is what would fix
   the D-106 guard's `exists=false` branch and let images actually land.
1a. **Fix the D-106 guard's existence check to be authenticated before
   relying on it here** (found in deck-reviewer's review, not yet fixed —
   tracked here as its own line item per that review). The current check is
   an anonymous `curl` against Harbor's project-get endpoint; live-verified
   both by the reviewer and independently by this note's author: a genuinely
   nonexistent project and a real, private, EXISTING project (e.g. `sample`)
   both return `401` to an anonymous caller (`dockerhub-proxy`, the one
   public project checked, correctly returns `200`). Every real tenant
   Harbor project observed is private, so a future lab-repo project almost
   certainly will be too — meaning the anonymous check would keep reporting
   "absent" forever even after item 1 above ships, silently reintroducing
   the no-push behavior it was supposed to retire. Fix: authenticate the
   check, most likely by reusing the same `harbor-push` robot credential the
   Kaniko step already expects to have mounted (`DOCKER_CONFIG_DIR`) rather
   than adding a second credential.
2. **One ArgoCD Application per environment per lab repo** (or a single
   generic ApplicationSet keyed on a `lab-cicd-*` repo-name pattern, mirroring
   `platform-infra/tenants/_template/applicationset-envs.yaml`'s existing
   git-`files:` generator over `promotion.yaml` — same mechanism, scoped
   narrower) so a pushed image actually gets deployed and is observable.
3. **A namespace per environment per lab repo** to deploy into — the one
   piece that most resembles real tenant infrastructure, and the one most
   worth scrutinizing for blast radius (quota, netpol, PSA) before building.

## The two-tier / three-claim tenant model overlap — why this isn't decided here

`artifacts/design/architecture-two-tier-tenant-model.md` (STAGED FOR HUMAN
APPROVAL, ADR-038/ADR-039, D-053) is mid-flight on the exact same substrate
this fastfollow would touch: what a "minimal tenant-like thing" looks like,
how `CapstoneTeam`/`CapstoneApp`/`CapstoneComponent` claims fan into
Harbor/ArgoCD/namespace resources, and — critically — ADR-039's own
recommendation is to defer that structural change until **after** semester
start specifically to avoid a 4-days-before-go-live risk window. Building a
parallel, lab-specific mini-tenant mechanism tonight would either (a)
duplicate infrastructure patterns the three-claim model is about to
formalize differently, creating two things to reconcile later, or (b)
implicitly pre-empt part of that pending decision by shipping a
lookalike ahead of the human's approval. Both are reasons to hold, not
reasons the idea is wrong.

## Recommendation (not a decision)

Once the two-tier/three-claim model's human approval lands and its
post-week-3 cutover is underway, revisit this as either:
- a deliberately-thin fourth claim kind / opt-in flag scoped specifically
  for ephemeral teaching repos (cheapest reuse of the new machinery once it
  exists), or
- the standalone minimal-Harbor-project + minimal-ArgoCD-Application slice
  above, if the tenant-model timeline doesn't align with when this is
  actually needed.

Either path (plus item 1a's authenticated-check fix, a prerequisite either
way) reactivates fault 02 and unblocks fault 03's live-verification bonus
steps, with zero further change to the fault catalog's `fault.patch` or
`ANSWER-KEY.md` content — only each fault's held/rescoped status and the
"not checkable at today's fidelity" caveats in `SYMPTOM.md`/`ANSWER-KEY.md`
would be reverted.

## Non-goals (explicit)

- Not proposing to make lab teams capstone tenants.
- Not proposing to build anything tonight or this task.
- Not proposing a specific claim-kind schema — that's the two-tier design's
  call, not this note's.
