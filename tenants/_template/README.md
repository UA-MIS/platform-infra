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
> mapping lives canonically in the APP repo at `team-<name>-app/.devops/promotion.yaml`
> (co-located with the CI scripts that also read it). `applicationset-envs.yaml`
> reads it over the existing app-repo source via a git-files generator — no copy
> in `platform-infra`, no drift. Read that file first to reason about deployment.

## Onboarding a team (the one-liner)

Replace two tokens everywhere — `__TEAM__` (team slug, a DNS label) and
`__SEMESTER__` (cohort, e.g. `2026-fall`):

```bash
TEAM=acme SEMESTER=2026-fall
cp -r tenants/_template tenants/team-$TEAM
grep -rl '__TEAM__\|__SEMESTER__' tenants/team-$TEAM \
  | xargs sed -i "s/__TEAM__/$TEAM/g; s/__SEMESTER__/$SEMESTER/g"
git add tenants/team-$TEAM && git commit -m "onboard team $TEAM ($SEMESTER)"
```

That's it — commit and push; ArgoCD does the rest. (`team-sample/` in this repo
is the Phase-1 worked example: `__TEAM__=sample`, `__SEMESTER__=2026-fall`.)

## Tokens

| Token | Meaning | Example |
| --- | --- | --- |
| `__TEAM__` | team slug — also the AppProject name, namespace prefix, repo name | `sample` |
| `__SEMESTER__` | cohort label — the universal GC/report selector | `2026-fall` |
| `__PRNUM__` | preview/PR number (only in `namespaces/preview.yaml`) — substituted per preview | `1` |

## Why de-provisioning is one git operation

Every object carries `platform.capstone/semester`. Graduating a cohort =
`git rm -r tenants/team-*` for that semester and commit; ArgoCD prunes the
AppProjects, namespaces, and everything in them. (Imperative equivalent, for
reference only: `kubectl delete ns -l platform.capstone/semester=2026-spring`.)
