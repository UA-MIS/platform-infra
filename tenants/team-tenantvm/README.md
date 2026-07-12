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
| `applicationset-preview.yaml` | LIVE ArgoCD `pullRequest` generator → one ephemeral `<team>-pr-<n>` preview App per open PR (auto-pruned on close) | §2.4, D-009 |

> **⚠ Preview previews are DRAFT — security review + cred provisioning gated.** The
> `pullRequest` generator (a) reuses PR #120's `argocd-repo-creds-uamis` GitHub-App
> secret to list PRs (seal the real values first), and (b) makes UNTRUSTED PR code
> build+push a `pull-<sha>` image (app repo CI) and deploy it. Before enabling for any
> live tenant the security review MUST resolve: per-PR guardrails via a platform-project
> guardrails App (the team AppProject can't create Quota/NetworkPolicy/RBAC); per-PR ESO
> SA→Vault binding; the `*.pr-*.<domain>` wildcard TLS; and the static `pr-1` collision
> (coordinate with the pr-1 removal). The ≤12h stale-preview TTL is the cohort-gc
> `preview-ttl` CronJob (PR #104). See the header of `applicationset-preview.yaml`.

> **No `promotion.yaml` here (ADR-008 / D-011).** The single trigger→target
> mapping lives canonically in the APP repo at `<appName>/.devops/promotion.yaml`
> (co-located with the CI scripts that also read it). `applicationset-envs.yaml`
> reads it over the existing app-repo source via a git-files generator — no copy
> in `platform-infra`, no drift. Read that file first to reason about deployment.

## Onboarding a team (the one-liner)

Replace three tokens everywhere — `tenantvm` (team slug, a DNS label),
`tenantvm` (the app repo name — `UA-MIS/<appName>`, NOT `<team>-app`), and
`2026-summer` (cohort, e.g. `2026-fall`):

```bash
TEAM=acme APPNAME=acme SEMESTER=2026-fall
cp -r tenants/_template tenants/team-$TEAM
grep -rl 'tenantvm\|tenantvm\|2026-summer' tenants/team-$TEAM \
  | xargs sed -i "s/tenantvm/$APPNAME/g; s/tenantvm/$TEAM/g; s/2026-summer/$SEMESTER/g"
git add tenants/team-$TEAM && git commit -m "onboard team $TEAM ($SEMESTER)"
```

(Substitute `tenantvm` BEFORE `tenantvm` so a `tenantvm`-prefixed appName isn't
half-replaced.) That's it — commit and push; ArgoCD does the rest. (`team-sample/`
in this repo is the Phase-1 worked example: `tenantvm=sample`,
`tenantvm=sample-app`, `2026-summer=2026-fall` — note the app repo `sample-app`
is NOT `sample`, which is exactly why repo refs key on `tenantvm`, not the team.)

## Tokens

| Token | Meaning | Example |
| --- | --- | --- |
| `tenantvm` | team slug — the AppProject name + namespace prefix + OIDC/Harbor key (D-026) | `sample` |
| `tenantvm` | the app repo name — `UA-MIS/<appName>` (repo == appName, #101); ArgoCD sources point here | `sample-app` |
| `2026-summer` | cohort label — the universal GC/report selector | `2026-fall` |
| `1` | preview/PR number (only in `namespaces/preview.yaml`) — substituted per preview | `1` |

## Why de-provisioning is one git operation

Every object carries `platform.capstone/semester`. Graduating a cohort =
`git rm -r tenants/team-*` for that semester and commit; ArgoCD prunes the
AppProjects, namespaces, and everything in them. (Imperative equivalent, for
reference only: `kubectl delete ns -l platform.capstone/semester=2026-spring`.)
