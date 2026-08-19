# lab-cicd — MIS 521 Lab CI/CD teaching exercise tooling

Design: `artifacts/design/lab-cicd-exercise-design.md`.
Decision record: `artifacts/context/decision-log.md` (D-062 onward — grep
`D-062` through the highest entry for the full build/prove trail).
Both live in the orchestration workspace this tooling was built from, not
in this repo — see `artifacts/design/lab-live-deploy-fastfollow.md`
(committed alongside this directory) for the same cross-repo note in full.

This directory holds the automation for the lab exercise described in that
design: students in GitHub Teams each get a repo instantiated from
`UA-MIS/lab-cicd-base` (a frozen fork of `UA-MIS/sample-app`), with GitHub
team `521` (course staff) as `admin` and the creating team as `maintain`.
Course staff then deliver deliberate faults as reviewed PRs for teams to
diagnose and fix.

**Nothing in this directory ever mutates the cluster.** Every script here
only calls the GitHub API (`gh api`) and plain `git`. Fault injection is a
git patch delivered as a PR; there is no platform-infra or Kubernetes
manipulation anywhere in this flow.

## Files

| Path | Purpose |
| --- | --- |
| `provision-team-repo.sh` | Generate one team's repo from `lab-cicd-base`, poll for readiness, grant `521=admin` / `<team>=maintain`, optionally apply branch protection. |
| `protection.json` | Branch protection body for `main` (PR + CODEOWNERS review required, `enforce_admins: false` so `521`'s repo-admin can `--admin`-merge fault PRs). |
| `inject-fault.sh` | Deliver one `faults/<id>/fault.patch` to a live team repo as a PR (default: auto-merged with `--admin`). |
| `faults/<NN-name>/fault.patch` | A `git apply`-able unified diff introducing exactly one fault. |
| `faults/<NN-name>/SYMPTOM.md` | What the team should observe — hand this to students, not the patch. |
| `faults/<NN-name>/ANSWER-KEY.md` | Course-staff-only: the bug, the concept it teaches, the fix, and how to verify recovery. |

## Provisioning a real team's repo (one command)

```sh
# team-slug must already be a real GitHub Team in UA-MIS.
./provision-team-repo.sh <team-slug>
# or, to control the generated repo name:
./provision-team-repo.sh <team-slug> lab-cicd-<team-slug>
```

Idempotent: safe to re-run against a team/repo that's already provisioned
(the generate call's 422 "already exists" is treated as already-done, not a
hard failure; the permission grants are naturally idempotent PUTs).

## Delivering a fault

```sh
./inject-fault.sh lab-cicd-<team-slug> 01-strip-autodeploy
# review the diff first, without merging:
AUTO_MERGE=0 ./inject-fault.sh lab-cicd-<team-slug> 03-rewire-environment
```

Recommend staggering which fault goes to which team (don't inject the same
fault into every team at the same time) so teams can't just compare diffs.

## The fault catalog

**Initial roster: faults 01 and 03.** Both are fully git/CI-observable today
and verified end-to-end in Phase 2
(`artifacts/implementation/lab-cicd-proof.evidence.yaml`).

1. **`01-strip-autodeploy`** — removes the `push: branches: [main]` trigger
   from the CI workflow. Merges to `main` silently stop deploying; teaches
   cross-referencing `promotion.yaml`'s declared contract against the
   workflow file that's supposed to implement it.
2. **`03-rewire-environment`** — swaps the `staging`/`prod` `overlay:` paths
   in `.devops/promotion.yaml`. Both environments stay green in ArgoCD, but
   each is running the other's manifests. Teaches that a promotion pipeline
   can be structurally valid YAML while being semantically wrong, and that a
   manual approval gate only catches what the approver actually checks.

**Held (not in the initial roster): `02-break-observability`.** Renames the
k8s `Service` object (keeping the Ingress backend reference and pod selector
in sync, so the app keeps serving 200s) so the Traefik-derived metrics
identifier no longer matches the Golden Signals dashboard's assumed naming.
This fault's whole symptom is live (a dashboard going quiet while the app
stays healthy) — it produces **no observable signal at all** without a real
deployed app and a real dashboard watching it, which lab repos don't have
today (see `artifacts/design/lab-live-deploy-fastfollow.md`). The patch,
`SYMPTOM.md`, and `ANSWER-KEY.md` are complete and correct; do not inject it
until that fastfollow lands — see `faults/02-break-observability/SYMPTOM.md`
for the full "why held" writeup.

Both shipped faults are pure in-repo git patches against files that live
entirely inside a `lab-cicd-base`-derived repo — no platform-infra or
cluster changes are needed to inject or answer either of them (design doc
Sec2.5's own framing).

## Authoring a new fault

1. `mkdir faults/NN-short-name`
2. Make the change in a scratch clone of `lab-cicd-base`, then
   `git diff > faults/NN-short-name/fault.patch`. Revert the scratch clone
   afterward — the patch is the deliverable, not a checked-in mutated repo.
3. Write `SYMPTOM.md` (what a team observes — no diff, no spoilers) and
   `ANSWER-KEY.md` (the bug, the concept, the fix, how to verify recovery).
4. Verify the patch applies cleanly against a fresh clone of
   `UA-MIS/lab-cicd-base`: `git apply --check faults/NN-short-name/fault.patch`.
5. Add one line to the fault-catalog table above.
