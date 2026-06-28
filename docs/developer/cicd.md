# CI/CD pipeline

Your repo ships with a complete build-and-deploy pipeline. You don't write it, you don't
maintain it, and you almost never look at it — but understanding what it does makes the
platform predictable. This page explains the pipeline and the **deploy model** (how code
becomes a running app in each environment).

## The one-line mental model

> **A git event picks an environment. The pipeline builds an image, tags it, and points
> the right environment at that tag. ArgoCD does the rest.**

| You do this | The platform deploys to | How |
| --- | --- | --- |
| Open a pull request | **preview** (`<app>.pr-N.…`) | per-PR ephemeral namespace |
| Merge to `main` | **dev** (`<app>.dev.…`) | auto |
| Push a tag `vX.Y.Z` | **staging** (`<app>.staging.…`) | auto |
| Push a tag `vX.Y.Z` + click Approve | **prod** (`<app>.…`) | manual gate |

You never run `kubectl`, never log into a registry, never touch the cluster. Push code,
watch it deploy.

## The thin caller + the central reusable workflow

Your repo's `.github/workflows/build-and-push.yaml` is a **thin caller** — about 30 lines.
The real ~250-line pipeline lives **once**, centrally, in the platform repo, and your repo
references it at a pinned major tag:

```yaml
# .github/workflows/build-and-push.yaml (in YOUR repo)
jobs:
  ci:
    permissions:
      contents: write          # lets the pipeline bump your dev overlay tag
    secrets: inherit
    uses: UA-MIS/platform-infra/.github/workflows/tenant-build.yaml@v1
    with:
      runner: ${{ vars.RUNNER_SCALE_SET || 'ua-mis-kaniko' }}
```

Why this matters to you: **CI fixes reach you automatically.** `@v1` is a rolling tag the
platform team moves forward as the pipeline improves; you don't re-copy a fixed workflow into
your repo. (This is the deliberate cure for the old model where every CI bug had to be
re-fixed in every team repo by hand.)

The triggers (`on:`) live in *your* caller — a reusable workflow can't own its own triggers:

```yaml
on:
  push:
    branches: [main]      # -> dev
    tags: ["v*.*.*"]      # -> staging (+ prod, gated)
  pull_request:           # -> preview
  workflow_dispatch:      # -> manual re-run
```

## What the pipeline actually runs (three jobs)

The reusable workflow is three jobs:

1. **`resolve`** (runs once) — reads `.devops/promotion.yaml`, maps the git event to an
   **environment** and the **one image tag** all components share, and (for multi-component
   repos) reads `.devops/components.yaml` to emit a per-component build matrix.
2. **`build-and-push`** (a matrix, one leg per component) — builds your image **rootless
   with Kaniko** (no Docker daemon, no privileged access) from the component's
   `context`/`dockerfile`, and pushes it to **your team's own Harbor project**. The push is
   authenticated by a least-privilege `harbor-push` robot the runner injects for you — not a
   secret you manage.
3. **`bump-dev`** (runs once, only on push-to-`main`) — rewrites your **dev overlay**'s image
   tag to the tag it just built, commits it with `[skip ci]`, and pushes to `main`. That
   commit is the GitOps signal: ArgoCD sees the new tag and rolls dev to it.

```
PR / merge / tag ─► resolve ─► build-and-push (Kaniko ─► Harbor) ─► bump-dev ─► ArgoCD syncs
                    (env+tag)   (per component, one image each)     (dev only)
```

## How an environment gets its version: `promotion.yaml`

Everything above is configured in **one file**, `.devops/promotion.yaml` — the single source
of truth for trigger → environment → tag → gate. You rarely edit it; reviewers look here first.

```yaml
apiVersion: platform.capstone/v1
registry: harbor.capstone.uamishub.com/<team>   # your Harbor project
app: <appName>
environments:
  dev:
    trigger: "branch:main"      # merge to main
    tagConvention: "git-describe"   # e.g. v1.0.0-5-gabc123 (readable, monotonic)
    overlay: ".devops/chart/overlays/dev"
    gate: auto
  staging:
    trigger: "tag:v*"           # push a vX.Y.Z tag
    tagConvention: "semver"     # e.g. 1.2.0
    overlay: ".devops/chart/overlays/staging"
    gate: auto
  prod:
    trigger: "tag:v*"           # SAME tag as staging
    tagConvention: "semver"
    overlay: ".devops/chart/overlays/prod"
    gate: manual                # <- the prod gate: ArgoCD will not auto-sync
  preview:
    trigger: "pull_request"
    tagConvention: "pull-<sha>"
    overlay: ".devops/chart/overlays/preview"
    gate: auto
```

### The deploy model, environment by environment

- **dev — merge to `main`.** The image is tagged with `git describe` (e.g.
  `v1.0.0-5-gabc123`: 5 commits past tag `v1.0.0`), so dev tags are readable and increase over
  time. The pipeline bumps the dev overlay automatically; ArgoCD auto-syncs. This is your
  fast inner loop.
- **staging — push a release tag `vX.Y.Z`.** The image is tagged with the **immutable**
  semver (e.g. `1.2.0`). Staging auto-deploys it. Use this to validate a release candidate.
- **prod — the *same* `vX.Y.Z` tag, behind a manual gate.** Pushing the tag also builds the
  prod-targeted deploy, but prod is `gate: manual`: **ArgoCD will not sync it until a human
  approves.** A project manager clicks **Approve** (in the GitHub Environment / ArgoCD) — no
  CLI, no kubectl. Prod always runs an immutable, reviewed version, never a moving `main`.
- **preview — open a PR.** Each PR builds an image tagged `pull-<short-sha>` and deploys it
  into an **ephemeral, fully fenced** `<team>-pr-<N>` namespace, so reviewers get a live URL
  for the change. PR builds push **untrusted** code, so they're bounded to your own Harbor
  project, a disjoint tag (it can never overwrite dev/staging/prod), and the throwaway PR
  namespace. The namespace is torn down when the PR closes.

## Image tags — the 12-character gotcha

When the pipeline tags an image with a git SHA (the `git-describe` suffix or `pull-<sha>`), it
uses a **12-character** short SHA — **not** the 7-character form GitHub and `git log` show by
default. If you ever read a tag back (for example to confirm what's deployed, or in an operator
bump), match the **12-char** tag the build log printed, or you'll chase an `ImagePullBackOff`
for a tag that doesn't exist. The build log is the source of truth for the exact pushed tag.

## Where your build runs

Builds run on **self-hosted ARC runners inside the cluster** (`runs-on: ua-mis-kaniko`, or your
team's own scale set if `vars.RUNNER_SCALE_SET` is set) — not GitHub-hosted minutes. The
runners are `containerMode: kubernetes`, so each Kaniko build runs in its own pod with the
Harbor push credential injected by the platform. You don't configure any of this.

## Finding your build

- **Build status & logs:** the **Actions** tab of your GitHub repo. Each push/PR/tag shows the
  `resolve` → `build-and-push` → `bump-dev` run.
- **What deployed:** after a merge, look for the `[skip ci]` "bump dev overlay" commit on
  `main` — its tag is what dev is running.
- **Runtime status, URLs, logs, dashboards:** see
  [Getting started → Finding your app](getting-started.md#find-your-app) and the operator
  observability guide.

## What you may and may not edit

| File | Edit? |
| --- | --- |
| `app/` (or `frontend/` + `backend/`) — your code | **Yes** — this is your app |
| `.devops/app-metadata.yaml` — the four fields | **Yes** — name/team/port/semester |
| `.devops/components.yaml` (multi-component) | **Yes, carefully** — see [Multi-component](multi-component.md) |
| `.devops/chart/`, `.devops/ci/`, `.devops/promotion.yaml`, `.github/` | **No** — platform-managed |

`.devops/` and `.github/` are the platform contract. If something there needs to change, open
an issue with the platform team rather than editing it (changes are reviewed/reverted, and the
`@v1` model means a real fix benefits everyone).
