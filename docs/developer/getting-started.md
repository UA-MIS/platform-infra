# Getting started

Welcome. This guide takes you from "I have a capstone team" to "my app is running on the
platform with a real URL" — without ever touching Kubernetes, a registry, or the cluster. You
write code; the platform does the operations.

## What you get

When you create a project, the platform gives your team:

- A **GitHub repo** under `UA-MIS/<your-app>`, pre-wired with a working build-and-deploy
  pipeline.
- **Four environments** per app: **preview** (one per pull request), **dev**, **staging**, and
  **prod** — with a click-to-approve gate in front of prod.
- A **stable URL** for each environment.
- **Single sign-on** with your GitHub identity across every platform tool.
- **Isolation**: your own namespaces, quotas, and registry project — no other team can see or
  touch your stuff.

You only ever edit two things: your **code** (`app/`, or `frontend/` + `backend/`) and the four
fields in `.devops/app-metadata.yaml`. Everything else is platform-managed.

## Step 1 — Create your project in The Process

The Process (the platform's developer portal, Backstage) has a golden-path template called
**New Capstone Project**. Open it and fill in a short form:

| Field | What to enter |
| --- | --- |
| **App name** | A short slug — lowercase letters, digits, hyphens only (e.g. `acme-shop`). Becomes your repo name, your Kubernetes workload names, and your URL `acme-shop.capstone.uamishub.com`, so it must be a valid DNS label (≤ 30 chars). |
| **Team slug** | Your team's canonical slug — **must equal your GitHub Team slug**. The platform keys your namespaces, RBAC, Harbor project, and SSO group on this one value. |
| **Season / Year** | Your cohort, e.g. Fall 2026. |
| **Container port** | The port your app listens on (default 8080). |
| **Description** | One line, shown in the catalog. |
| **App layout** | **Single component** (default) or **Frontend + backend** (two services in one repo — see [Multi-component](multi-component.md)). |

Click create. In a few seconds The Process:

1. **Creates `UA-MIS/<app-name>`** — a private repo pre-loaded with a starter app, the
   `.devops/` deploy contract, and the CI workflow. Your team gets push access; you own this
   repo.
2. **Creates your team's Harbor project** (your private image registry) so your very first
   build can push.
3. **Registers your app in the catalog** so it shows up in The Process immediately.
4. **Opens a platform onboarding pull request** against `UA-MIS/platform-infra` that requests
   your team's namespaces, RBAC, and quotas.

!!! note "One thing is gated — by design"
    Your repo builds **previews immediately**, but **dev / staging / prod deploys wait** until a
    platform reviewer **merges** that onboarding PR (and runs a couple of one-time Harbor robot
    steps listed in the PR). This is the platform's grant model: a student can *request*
    namespaces/RBAC, but a reviewer's merge is what *grants* them — no one silently mints cluster
    access. Ping the platform team if the PR is waiting. *(The platform team is moving toward
    fully automatic, no-PR onboarding via Crossplane; until that cutover lands, the merge is the
    gate.)*

## Step 2 — Clone and write your code

```bash
git clone https://github.com/UA-MIS/<your-app>.git
cd <your-app>
```

Your repo looks like this (single-component layout):

```
<your-app>/
├── app/                       # YOUR code (starter app + Dockerfile) — edit freely
│   ├── Dockerfile
│   └── main.go ...
├── .devops/                   # platform-managed deploy contract — do not edit
│   ├── app-metadata.yaml      #   the ONLY .devops file you set values in
│   ├── promotion.yaml         #   trigger -> env -> tag -> gate (see CI/CD)
│   ├── chart/                 #   kustomize base + dev/staging/prod/preview overlays
│   └── ci/                    #   build/bump scripts (read by CI)
├── .github/workflows/         # platform-managed CI (thin caller -> central @v1 workflow)
├── catalog-info.yaml          # registers the app in The Process catalog
├── docs/ + mkdocs.yml         # your TechDocs (edit docs/index.md)
└── README.md
```

(A **frontend + backend** repo has `frontend/` and `backend/` instead of `app/`, plus a
`.devops/components.yaml` — see [Multi-component](multi-component.md).)

The starter app builds and runs as-is. Replace it with your own code, keeping the Dockerfile so
the platform can build an image. The only `.devops/` file you may set values in is
`app-metadata.yaml` (team, semester, app-name, port).

## Step 3 — Ship it

The deploy model is pure git. You never run a deploy command.

```bash
# Open a PR  -> a PREVIEW environment is built automatically, with its own URL.
git checkout -b my-feature
# ... edit app/ ...
git commit -am "add feature"; git push -u origin my-feature
gh pr create

# Merge to main -> DEV deploys automatically.
gh pr merge

# Tag a release -> STAGING deploys automatically; PROD waits on a manual approval.
git tag v1.0.0 && git push origin v1.0.0
```

| Git action | Environment | Gate |
| --- | --- | --- |
| Open a PR | preview (`<app>.pr-N.…`) | auto, torn down on PR close |
| Merge to `main` | dev (`<app>.dev.…`) | auto |
| Push tag `vX.Y.Z` | staging (`<app>.staging.…`) | auto |
| Push tag `vX.Y.Z` | prod (`<app>.…`) | **manual** — a PM clicks Approve |

Full details, including how images are built and tagged, are in [CI/CD](cicd.md).

## <a id="find-your-app"></a>Step 4 — Find your app (URLs, logs, dashboards)

- **URL.** Each environment is at a predictable host:
    - prod: `https://<app-name>.capstone.uamishub.com`
    - dev / staging: `https://<app-name>.dev.capstone.uamishub.com` /
      `…staging.capstone.uamishub.com`
    - preview: `https://<app-name>.pr-<N>.capstone.uamishub.com`
- **Build status & logs.** The **Actions** tab of your GitHub repo (the `resolve` →
  `build-and-push` → `bump-dev` run).
- **Your app in the catalog.** The Process → search your app name. The catalog entity links to
  the repo, the source, and the app's TechDocs.
- **Runtime logs & dashboards.** The platform runs Grafana + Loki (logs) and Prometheus
  (metrics). Ask the platform team for the Grafana URL and how your team's namespace dashboards
  and log views are scoped; the operator observability guide covers the details.

## Step 5 — Add secrets (when you need them)

Don't put API keys or passwords in your repo. Use the **Secrets** tab in The Process — values
go into Vault, never into git, and the platform injects them into your pods at runtime. A
brand-new app deploys fine with no secrets at all. See [Secrets](secrets.md).

## Quick reference — what you edit vs. what you don't

| You edit | Platform owns (don't edit) |
| --- | --- |
| `app/` (or `frontend/`+`backend/`) — your code | `.devops/chart/`, `.devops/ci/`, `.devops/promotion.yaml` |
| `.devops/app-metadata.yaml` — the four fields | `.github/workflows/` — the CI caller |
| `.devops/components.yaml` (multi-component) | `catalog-info.yaml` plumbing (you may edit links) |
| `docs/` — your TechDocs | the deploy/registry/secrets machinery |

If you think something platform-managed needs to change, **open an issue with the platform
team** rather than editing it — fixes ship centrally and reach every team.

## Where to go next

- [CI/CD pipeline](cicd.md) — how a git event becomes a running deploy.
- [Secrets](secrets.md) — names in git, values in Vault.
- [Multi-component apps](multi-component.md) — frontend + backend in one repo.
- The [Overview](../index.md) — the big picture of how the platform is built.
