# Phase-1 local CI loop — runbook

The local golden-path inner loop: **edit app → build → push → bump → ArgoCD syncs.**
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

From the `team-sample-app/` repo root:

```sh
# 1. EDIT — change app code
$EDITOR app/main.go
make test                       # keep tests green (required, no exceptions)

# 2. BUILD + PUSH — image tag computed from promotion.yaml for the env
make app-build ENV=dev          # -> k3d-registry.localhost:5000/sample:<short-sha>
                                # prints  IMAGE=...  TAG=<sha>  ENV=dev

# 3. BUMP — write the new tag into the dev overlay and commit (the GitOps signal)
make bump ENV=dev TAG=<sha> COMMIT=1
#   (or do build+push+bump+commit in one shot:)
make deploy ENV=dev

# 4. ArgoCD SYNCS — the dev Application sees the changed overlay and reconciles.
#    Watch it:
argocd app get sample-dev          # or the ArgoCD UI
kubectl -n sample-dev rollout status deploy/sample
```

## Per-environment promotion (from promotion.yaml)

Field names below match `promotion.yaml` (schema `apiVersion: platform.capstone/v1`).

| Env | trigger | tagConvention | resulting tag | gate |
| --- | --- | --- | --- | --- |
| preview | `pull_request` | `pull-<sha>` | `pull-<short-sha>` | auto |
| dev | `branch:main` | `sha-<short>` | `<short-sha>` | auto |
| staging | `tag:v*` | `semver` | `<X.Y.Z>` | auto |
| prod | `tag:v*` | `semver` | `<X.Y.Z>` | **manual** |

Examples:

```sh
SEMVER=1.4.0 make app-build ENV=staging      # build+push sample:1.4.0
make bump ENV=staging TAG=1.4.0 COMMIT=1     # staging auto-syncs

SEMVER=1.4.0 make app-build ENV=prod
make bump ENV=prod TAG=1.4.0 COMMIT=1        # prod overlay updated, but...
# ...prod has NO automated sync — a human approves the sync in ArgoCD (the gate, §4).
```

## How the seam works (for reviewers)

- `build-and-push.sh <env>` reads `promotion.yaml`, resolves the env's
  `tagConvention` (`sha-<short>`/`semver`/`pull-<sha>`), builds `app/`, pushes to
  the registry, prints `IMAGE=`/`TAG=`.
- `bump-image.sh <env> <tag>` reads `promotion.yaml` for the env→overlay mapping
  and rewrites that overlay's `images[].newTag` (and keeps `newName` aligned to
  the registry). With `COMMIT=1` it commits the change — **that commit is the
  signal ArgoCD watches.** No imperative `kubectl apply`; GitOps owns the cluster.
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

| Trigger | Resolved env | Image tag | Pushed? |
| --- | --- | --- | --- |
| `push` to `main` | dev | `:<short-sha>` (mutable) | yes |
| `push` tag `vX.Y.Z` | prod (+staging) | `:X.Y.Z` (**immutable**) | yes |
| `pull_request` | preview | `pull-<sha>` | **no** (build-only validation) |

- **runs-on: `ua-mis-kaniko`** — the ARC `gha-runner-scale-set` name (the scale-set
  model selects runners by set name). CI ↔ workflow contract with the platform
  (`platform-services/arc/README.md`).
- **Kaniko** rootless build (no docker daemon/socket; the runners are
  `containerMode: kubernetes`, non-root). Kaniko fetches THIS commit of the repo
  as its build context over https (no `actions/checkout` in the no-node Kaniko
  image), builds `app/` (`--context-sub-path=app`), and pushes to Harbor.
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
