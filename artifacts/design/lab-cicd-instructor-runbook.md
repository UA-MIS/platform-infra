# MIS 521 Lab CI/CD Exercise — Instructor Runbook

**Audience:** the course instructor/TA (human keyboard), operating as a
member of the `521` GitHub team. Every step below is a real, org-mutating
GitHub API call — run these deliberately, one team at a time, against your
own real course roster. This runbook does not create any team repos itself;
provisioning real student repos is explicitly the instructor's own action
(see "Do NOT" note at the end).

**What exists already, permanently, before you run anything here:**

- `UA-MIS/lab-cicd-base` — the GitHub template repo every team's repo is
  generated from (`is_template: true`, forked from `UA-MIS/sample-app`,
  `CODEOWNERS` names `@UA-MIS/521`).
- The real `521` GitHub team (course staff — you're likely already a
  member/maintainer if you're reading this; `admin` on `lab-cicd-base` and
  on every repo `provision-team-repo.sh` provisions).
- `platform-infra/tools/lab-cicd/` — the two scripts and fault catalog this
  runbook drives.

## Prerequisites (one-time, per machine you run this from)

1. `gh auth status` — confirm you're logged in with a token that has
   `repo`, `read:org`, and org-owner-equivalent access (team-repo permission
   grants and `POST /orgs/{org}/teams` both worked in practice with a token
   whose *listed* scopes didn't include classic `admin:org` — GitHub
   appears to permit this for an org-owner-authenticated token regardless;
   if a call below is denied on scope grounds, it will say so explicitly —
   don't work around a denial, it means your token genuinely lacks
   authorization).
2. Clone `platform-infra` and `cd tools/lab-cicd/`.
3. Confirm the student's GitHub Team already exists in `UA-MIS`
   (`gh api orgs/UA-MIS/teams/<team-slug>`) — `provision-team-repo.sh`
   deliberately fails loud rather than silently creating one, matching the
   Backstage scaffolder's own "team must pre-exist" contract. If it doesn't
   exist yet:
   ```sh
   gh api orgs/UA-MIS/teams -X POST -f name='<team-slug>' -f privacy='closed'
   ```

## Provisioning one real team's repo (the one command)

```sh
./provision-team-repo.sh <team-slug>
```

This does, in order: generate `lab-cicd-<team-slug>` from `lab-cicd-base` →
poll until GitHub's copy is actually readable (~1-4s in practice, see
`artifacts/implementation/lab-cicd-proof.evidence.yaml` in the orchestration
workspace for the timed Phase 2 proof) → grant `521=admin` +
`<team-slug>=maintain` → best-effort branch protection (skips gracefully
with a warning if your org plan doesn't support it on a private repo — this
is not a failure, see the script's own comment on that step).

Verify it landed before moving on:
```sh
gh api repos/UA-MIS/lab-cicd-<team-slug>   # confirm the repo exists
gh api orgs/UA-MIS/teams/521/repos/UA-MIS/lab-cicd-<team-slug> \
  -H "Accept: application/vnd.github.v3.repository+json" -q '.permissions'
  # expect admin:true
gh api orgs/UA-MIS/teams/<team-slug>/repos/UA-MIS/lab-cicd-<team-slug> \
  -H "Accept: application/vnd.github.v3.repository+json" -q '.permissions'
  # expect admin:false, maintain:true
```

Safe to re-run against the same `<team-slug>` — the generate call's "already
exists" response and the permission grants are both idempotent.

## Delivering a fault to a team

**Initial roster: `01-strip-autodeploy` and `03-rewire-environment` only.**
`02-break-observability` is held — see
`tools/lab-cicd/faults/02-break-observability/SYMPTOM.md` for why (it needs
a live deploy path that doesn't exist yet;
`artifacts/design/lab-live-deploy-fastfollow.md` scopes what that would
take).

```sh
./inject-fault.sh lab-cicd-<team-slug> 01-strip-autodeploy
```

This clones the team's repo, applies the fault as a patch on a generically
named branch, opens a PR with a plain cover-story title/body (never names
the fault — that's deliberate, see the script's own header comment), and
(default) merges it immediately via `521`'s admin bypass. The team's
diagnosis work starts from the merged state.

To review the diff yourself before it lands: `AUTO_MERGE=0 ./inject-fault.sh ...`
then `gh pr merge --admin` manually once satisfied.

**Recommend staggering** — don't inject the same fault into every team on
the same day; makes comparing diffs across teams trivially easy and
undercuts the exercise.

**Keep your own tracking outside any repo.** The script logs
`fault=<id> delivered to <repo>` to its own stderr — that's your
instructor-side record of what went where. Nothing in the delivered
commit/PR/branch text says which fault it is, on purpose.

## Grading / verifying a team's fix

Point the team at `tools/lab-cicd/faults/<fault-id>/ANSWER-KEY.md` (or grade
against it yourself without handing it over) — it has the concept, the
correct fix, and concrete "verifying recovery" steps scoped to what's
actually checkable at this exercise's current fidelity (git/CI, not a live
deploy — see the "Live version" callouts in each `ANSWER-KEY.md` for what
would additionally be checkable once the fastfollow lands).

## Troubleshooting

- **`provision-team-repo.sh` exits with "team does not exist"** — create
  the GitHub Team first (see Prerequisites §3); this script never creates
  teams for you.
- **Branch protection warning during provisioning** — expected on this
  org's current plan for private repos; does not affect the permission
  grants, which already landed by that point in the script.
- **`inject-fault.sh` refuses with a `git apply --check` failure** — the
  team's repo has drifted from `lab-cicd-base` in a way that conflicts with
  the fault's patch (e.g. they already edited the same lines). Don't force
  it; either pick a different fault for that team or hand-resolve.

## Tearing down a throwaway/test repo (not a real student's work)

```sh
gh api repos/UA-MIS/<repo> -X DELETE
```

For a REAL team's repo at end of semester, prefer archiving over deleting
(`gh api repos/UA-MIS/<repo> -X PATCH -F archived=true`) unless you have a
specific reason to remove it entirely — matches the platform's existing
never-delete-real-work convention elsewhere.

## Do NOT

- **Do not bulk-provision the whole class roster with a loop over this
  script without reading each result.** Verify each grant before moving to
  the next team — cheap insurance against a partial failure going unnoticed
  across 20 teams.
- **Real class repos are yours to create, not this task's.** No repo for
  any real course team was created while building this tooling — only a
  throwaway proof team (created and fully torn down,
  `artifacts/implementation/lab-cicd-proof.evidence.yaml`) and the
  permanent `lab-cicd-base` template itself.
