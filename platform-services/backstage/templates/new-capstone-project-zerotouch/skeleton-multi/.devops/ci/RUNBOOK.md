# Phase-1 local CI loop — runbook (multi-component)

The local golden-path inner loop: **edit components → build → push → bump → ArgoCD syncs.**
This repo is **multi-component** (frontend + backend, declared in
[`../components.yaml`](../components.yaml)): the build produces **one image per
component** and the bump points every component at the new tag.
Everything is driven by [`../promotion.yaml`](../promotion.yaml) (the single
configured place, §4.1). Phase 2 replaces the local build/push with GitHub
Actions + Harbor but keeps this exact seam — only `registry` and the trigger change.

## Prerequisites

- The k3d cluster is up with the built-in registry (`make cluster-up` in
  `platform-infra`), and `k3d-registry.localhost` resolves to `127.0.0.1` on the
  host (cluster-up adds the `/etc/hosts` entry; otherwise:
  `echo '127.0.0.1 k3d-registry.localhost' | sudo tee -a /etc/hosts`).
- ArgoCD is installed and the `team-sample` env Applications exist (T3/T7).
- `docker`, `git`, `yq`, `go` on PATH.

## The loop

From your repo root:

```sh
# 1. EDIT — change your component code
$EDITOR backend/main.go frontend/main.go
( cd backend && go test ./... ) && ( cd frontend && go test ./... )   # keep tests green

# 2. BUILD + PUSH — builds EVERY component (one image each); tag from promotion.yaml
sh .devops/ci/build-and-push.sh dev      # prints IMAGE=... per component, then TAG/ENV

# 3. BUMP — write the new tag into ALL components in the dev overlay + commit (the signal)
COMMIT=1 sh .devops/ci/bump-image.sh dev <tag>

# 4. ArgoCD SYNCS — the dev Application sees the changed overlay and reconciles. Watch:
argocd app get <app>-dev                 # or the ArgoCD UI
kubectl -n <team>-dev rollout status deploy/<app>-frontend deploy/<app>-backend
```

## Per-environment promotion (from promotion.yaml)

Field names below match `promotion.yaml` (schema `apiVersion: platform.capstone/v1`).

| Env | trigger | tagConvention | resulting tag | gate |
| --- | --- | --- | --- | --- |
| preview | `pull_request` | `pull-<sha>` | `pull-<short-sha>` | auto |
| dev | `branch:main` | `git-describe` | `<git describe --tags>` | auto |
| staging | `tag:v*` | `semver` | `<X.Y.Z>` | auto |
| prod | `tag:v*` | `semver` | `<X.Y.Z>` | **manual** |

Examples (every component is built/bumped together — one tag for the whole repo):

```sh
SEMVER=1.4.0 sh .devops/ci/build-and-push.sh staging   # build+push each component :1.4.0
COMMIT=1 sh .devops/ci/bump-image.sh staging 1.4.0     # staging auto-syncs

SEMVER=1.4.0 sh .devops/ci/build-and-push.sh prod
COMMIT=1 sh .devops/ci/bump-image.sh prod 1.4.0        # prod overlay updated, but...
# ...prod has NO automated sync — a human approves the sync in ArgoCD (the gate, §4).
```

## How the seam works (for reviewers)

- `resolve-components.sh` reads `components.yaml` + the resolved `TAG`/`PUSH` and emits
  the per-component build **matrix** (one image each) — what the CI workflow fans out over.
- `build-and-push.sh <env>` reads `promotion.yaml`, resolves the env's `tagConvention`
  (`git-describe`/`semver`/`pull-<sha>`), then builds **each component's context** from
  `components.yaml` and pushes one image per component, printing `IMAGE=` per component.
- `bump-image.sh <env> <tag>` reads `promotion.yaml` for the env→overlay mapping and
  rewrites **every component's** `images[].newTag` in that overlay (all components share
  the one tag). With `COMMIT=1` it commits the change — **that commit is the signal ArgoCD
  watches.** No imperative `kubectl apply`; GitOps owns the cluster.
- To change a convention (e.g. "staging tracks a release branch, not a tag"),
  edit the one entry in `promotion.yaml`. The scripts and overlays follow.

---

## Phase 2 — the platform CI workflow (GitHub Actions + ARC + Kaniko + Harbor)

Phase 2 replaces the LOCAL `build-and-push.sh` (docker → k3d registry) with a
GitHub Actions workflow that runs on the platform's self-hosted ARC runners and
pushes to **Harbor** — **the same seam** (`promotion.yaml` stays the single source
of truth; only `registry` and the trigger change, exactly as designed).

### The workflow — `.github/workflows/build-and-push.yaml`

Platform-managed (part of the immutable `.devops` contract). Triggers and outputs:

| Trigger | Resolved env | Image tag (per component) | Pushed? |
| --- | --- | --- | --- |
| `push` to `main` | dev | `:<git-describe>` (mutable) | yes |
| `push` tag `vX.Y.Z` | prod (+staging) | `:X.Y.Z` (**immutable**) | yes |
| `pull_request` | preview | `pull-<head-sha>` | yes (into the fenced `<team>-pr-<n>` ns) |

The workflow runs three jobs: **resolve** (one tag + the per-component build matrix via
`resolve-components.sh`), **build-and-push** (a MATRIX — one Kaniko build per component),
and **bump-dev** (one commit bumping every component's dev tag). One image is built and
pushed PER component (`<registry>/<app>-<component>:<tag>`).

- **runs-on: `ua-mis-kaniko`** — the ARC `gha-runner-scale-set` name (the scale-set
  model selects runners by set name). CI ↔ workflow contract with the platform
  (`platform-services/arc/README.md`).
- **Kaniko** rootless build (no docker daemon/socket; the runners are
  `containerMode: kubernetes`, non-root). Each matrix leg runs `actions/checkout` on the
  node runner pod, then a `uses: docker://` Kaniko STEP builds that component from its
  `context`/`dockerfile` (`--context=dir://$GITHUB_WORKSPACE/<context>
  --dockerfile=<dockerfile>`) over the shared `_work` volume, and pushes to Harbor.
- **Push credential**: the per-team Harbor **PUSH** robot secret **`harbor-push`**
  (dockerconfigjson, least-privilege: pull+push on the team's OWN Harbor project
  only), provisioned by the platform (`make harbor-push-robot NAME=<name>`) and
  injected into the build pod at **`/kaniko/.docker/config.json`** (Kaniko's default
  `DOCKER_CONFIG` dir) by the runner's container-hook template. The workflow needs
  no cred-handling step — Kaniko finds it. The workflow REFUSES to push if the cred
  is absent (no unauthenticated push).
- **No Trivy** in the workflow — **Harbor scans on push** (D-028); we don't dup it.

### The tag IS the promotion mechanism (D-030 prod-gate)

One `vX.Y.Z` git tag builds ONE **immutable** `:X.Y.Z` image that BOTH the staging
and prod overlays pin — staging auto-syncs it, **prod is the manual gate** (§4).
`main` pushes build a **mutable** `:<short-sha>` dev image. There is no second
promotion artifact: the git tag names both the image and (via `bump-image.sh`) the
manifest revision. The trigger→env→tag mapping is computed by
`.devops/ci/resolve-image.sh` (reads `promotion.yaml`) and unit-tested by
`.devops/ci/resolve-image.test.sh` — the SAME resolver, no drift.

### How the per-team `<name>` / `<app>` are injected

No per-team edit of the workflow. The image ref `harbor.<domain>/<name>/<app>:<tag>`
is composed entirely from `promotion.yaml`:

- `registry:` carries the Harbor host + the team's project slug — `<name>` (D-026:
  AppProject = GitHub Team slug = OIDC group suffix = **Harbor project** = `<name>`).
- `app:` is `<app>` (the image name).

Both are seeded at onboarding from the four fields a student sets in
`app-metadata.yaml` (`team` → `<name>`, `app-name` → `<app>`). So onboarding a team
(`__TEAM__`/`__SEMESTER__` substitution + `app-metadata.yaml`) is the only input;
the workflow and resolver read `promotion.yaml` and need zero per-team changes.

### Cutover from the Phase-1 local loop

`registry` flips from `k3d-registry.localhost:5000` to
`harbor.<domain>/<name>` in `promotion.yaml`; the four overlay `newName`s and the
namespace PULL robot (`make harbor-robot`) move with it. After cutover the local
`build-and-push.sh` is Phase-1 legacy — the Actions workflow is the build path.
