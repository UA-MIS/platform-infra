# Fault 02 — HELD (not in the initial roster)

**Status: HELD.** Do not inject this fault yet — see below. This is not a
placeholder for a future fault; the patch, the concept, and the answer key
are all real and correct — the file exists, it just isn't ready to hand a
team.

## Why this is held

This fault's whole point (see `ANSWER-KEY.md`) is a *live* symptom: the app
stays healthy, but a Grafana dashboard goes quiet because the renamed
Service no longer matches what the dashboard's query expects. That symptom
only exists once traffic is actually flowing through a real deployed app and
a real dashboard is actually watching it.

Lab repos don't have that today (D-106: no Harbor project, no ArgoCD
Application — see `artifacts/design/lab-live-deploy-fastfollow.md`). Without
a live deploy, this fault produces **no observable signal at all**:

- `fault.patch` renames the Service and updates the Ingress backend to
  match, so the two stay mutually consistent — there is nothing to spot by
  comparing them (confirmed by review: diffing the two files post-fault
  shows them agreeing, not disagreeing).
- CI (build+test) doesn't touch either file's content in a way that fails.
- `kubectl kustomize` renders all four overlays clean, exit 0, both before
  and after the patch — kustomize doesn't cross-validate that an Ingress
  backend's Service name actually resolves to a live Service, so there's no
  build-time signal either.

A team handed this fault today would look for a discrepancy, find none, and
correctly conclude nothing's wrong — which defeats the exercise. That's a
real gap in the fault, not a wording problem in this file, which is why it's
held rather than rescoped like faults 01/03 were.

## What ships instead

The initial roster is **faults 01 and 03 only** — both fully git/CI
observable today, both verified end-to-end in Phase 2
(`artifacts/implementation/lab-cicd-proof.evidence.yaml`). This fault
reactivates automatically, with no changes needed to `fault.patch` or
`ANSWER-KEY.md`, once a live per-team deploy path exists — see
`artifacts/design/lab-live-deploy-fastfollow.md`.
