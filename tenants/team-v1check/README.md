# tenants/_template — the canonical team blueprint

Copy this directory to onboard a team. The `tenants-appset` git generator
(`applicationsets/tenants-appset.yaml`) detects the new directory and ArgoCD
reconciles the team's AppProject, namespaces (quota/limitrange/netpol/RBAC), and
ApplicationSets. **No imperative `kubectl`, no cluster-admin action.**

## What's here

| File | Purpose | Architecture ref |
| --- | --- | --- |
| `appproject.yaml` | the tenancy fence inside ArgoCD (source repos, destination namespaces, resource whitelists, team RBAC role) | §2.2, §3.3 |
| `namespaces/dev.yaml` | `<team>-dev` Namespace + Quota + LimitRange + default-deny NetworkPolicy + allowances + team Role/RoleBinding | §3.1–§3.4 |
| `namespaces/staging.yaml` | same, `<team>-staging` | §3 |
| `namespaces/prod.yaml` | same, `<team>-prod`, higher quota ceiling | §3.2 |
| `namespaces/preview.yaml` | `<team>-pr-<n>` guardrails (half quota), applied per preview | §3.2, §2.4 |
| `applicationset-envs.yaml` | matrix (env list × git-files read of the app repo's `promotion.yaml`) → dev/staging/prod Apps; per-env `gate` drives sync policy (prod manual-gated) | §2.3, §4, ADR-008 |
| `applicationset-preview.yaml` | git-branch stand-in → ephemeral preview Apps (PR-generator seam) | §2.4, D-009 |

> **No `promotion.yaml` here (ADR-008 / D-011).** The single trigger→target
> mapping lives canonically in the APP repo at `team-<name>-app/.devops/promotion.yaml`
> (co-located with the CI scripts that also read it). `applicationset-envs.yaml`
> reads it over the existing app-repo source via a git-files generator — no copy
> in `platform-infra`, no drift. Read that file first to reason about deployment.

## Onboarding a team (the one-liner)

Replace two tokens everywhere — `v1check` (team slug, a DNS label) and
`2026-summer` (cohort, e.g. `2026-fall`):

```bash
TEAM=acme SEMESTER=2026-fall
cp -r tenants/_template tenants/team-$TEAM
grep -rl 'v1check\|2026-summer' tenants/team-$TEAM \
  | xargs sed -i "s/v1check/$TEAM/g; s/2026-summer/$SEMESTER/g"
git add tenants/team-$TEAM && git commit -m "onboard team $TEAM ($SEMESTER)"
```

That's it — commit and push; ArgoCD does the rest. (`team-sample/` in this repo
is the Phase-1 worked example: `v1check=sample`, `2026-summer=2026-fall`.)

## Tokens

| Token | Meaning | Example |
| --- | --- | --- |
| `v1check` | team slug — also the AppProject name, namespace prefix, repo name | `sample` |
| `2026-summer` | cohort label — the universal GC/report selector | `2026-fall` |
| `__PRNUM__` | preview/PR number (only in `namespaces/preview.yaml`) — substituted per preview | `1` |

## Why de-provisioning is one git operation

Every object carries `platform.capstone/semester`. Graduating a cohort =
`git rm -r tenants/team-*` for that semester and commit; ArgoCD prunes the
AppProjects, namespaces, and everything in them. (Imperative equivalent, for
reference only: `kubectl delete ns -l platform.capstone/semester=2026-spring`.)
