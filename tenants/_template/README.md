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
> mapping lives canonically in the APP repo at `<appName>/.devops/promotion.yaml`
> (co-located with the CI scripts that also read it). `applicationset-envs.yaml`
> reads it over the existing app-repo source via a git-files generator — no copy
> in `platform-infra`, no drift. Read that file first to reason about deployment.

## Onboarding a team (the one-liner)

Replace three tokens everywhere — `__TEAM__` (team slug, a DNS label),
`__APPNAME__` (the app repo name — `UA-MIS/<appName>`, NOT `<team>-app`), and
`__SEMESTER__` (cohort, e.g. `2026-fall`):

```bash
TEAM=acme APPNAME=acme SEMESTER=2026-fall
cp -r tenants/_template tenants/team-$TEAM
grep -rl '__TEAM__\|__APPNAME__\|__SEMESTER__' tenants/team-$TEAM \
  | xargs sed -i "s/__APPNAME__/$APPNAME/g; s/__TEAM__/$TEAM/g; s/__SEMESTER__/$SEMESTER/g"
git add tenants/team-$TEAM && git commit -m "onboard team $TEAM ($SEMESTER)"
```

(Substitute `__APPNAME__` BEFORE `__TEAM__` so a `__TEAM__`-prefixed appName isn't
half-replaced.) That's it — commit and push; ArgoCD does the rest. (`team-sample/`
in this repo is the Phase-1 worked example: `__TEAM__=sample`,
`__APPNAME__=sample-app`, `__SEMESTER__=2026-fall` — note the app repo `sample-app`
is NOT `sample`, which is exactly why repo refs key on `__APPNAME__`, not the team.)

## Tokens

| Token | Meaning | Example |
| --- | --- | --- |
| `__TEAM__` | team slug — the AppProject name + namespace prefix + OIDC/Harbor key (D-026) | `sample` |
| `__APPNAME__` | the app repo name — `UA-MIS/<appName>` (repo == appName, #101); ArgoCD sources point here | `sample-app` |
| `__SEMESTER__` | cohort label — the universal GC/report selector | `2026-fall` |
| `__PRNUM__` | preview/PR number (only in `namespaces/preview.yaml`) — substituted per preview | `1` |

## Why de-provisioning is one git operation

Every object carries `platform.capstone/semester`. Graduating a cohort =
`git rm -r tenants/team-*` for that semester and commit; ArgoCD prunes the
AppProjects, namespaces, and everything in them. (Imperative equivalent, for
reference only: `kubectl delete ns -l platform.capstone/semester=2026-spring`.)
