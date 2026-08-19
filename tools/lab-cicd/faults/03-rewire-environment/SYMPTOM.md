# Fault 03 — staging and prod's overlay mapping is crossed

## What you'll observe

A PR lands on `main` from course staff. Nothing about the merge itself looks
alarming — CI still builds and tests cleanly, this fault doesn't touch
anything CI-visible.

The defect is only visible by reading `.devops/promotion.yaml` carefully:
the `staging` block's `overlay:` path and the `prod` block's `overlay:` path
have been swapped. Both blocks are still well-formed — each has a `trigger`,
a `tagConvention`, an `overlay`, and a `gate` — so at a glance the file looks
fine. It's only wrong if you check that `staging.overlay` actually points at
`.devops/chart/overlays/staging` (not `.../overlays/prod`) and vice versa.

## Where to look

- `git diff` (or `git log -p`) on the fault-delivery commit/PR: which one
  file changed, and what exactly moved?
- `.devops/promotion.yaml` — for each environment, does the `overlay:` path
  actually match the environment's own name? Read the file's own header
  comment first; it tells you this file is the canonical source of truth and
  to look here first.
- `.devops/chart/overlays/staging/` vs `.devops/chart/overlays/prod/` — what
  actually differs between these two directories, and which one does
  `promotion.yaml` currently point each environment at?

This fault is entirely readable from `promotion.yaml` alone once you know to
check it carefully — the whole point is that a promotion contract can look
plausible at a glance (two paths, two envs) while actually being crossed.

## About the live version of this fault

The original design for this fault (see
`artifacts/design/lab-cicd-exercise-design.md` Sec2.5) describes a live
symptom: a release tag actually deploys the wrong overlay's manifests into
each environment (wrong replica count, wrong Ingress host), and a human
clicking through the `prod` manual gate unknowingly approves promoting the
wrong config. **That live behavior does not activate for lab repos today**
— lab repos aren't provisioned with a live deploy path (no Harbor project,
no ArgoCD Application; see
`artifacts/design/lab-live-deploy-fastfollow.md`), so there is no live
`staging`/`prod` namespace or ArgoCD Application to actually observe running
the wrong config yet. The git/manifest-level diagnosis above is the current,
honest scope of this fault. It will activate automatically, with zero
changes to this fault, once a live per-team deploy path exists.
