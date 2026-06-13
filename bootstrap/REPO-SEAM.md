# The repoURL seam — one swappable git base

ArgoCD syncs the platform from `https://github.com/UA-MIS/platform-infra` and
each team's app from `https://github.com/UA-MIS/<team>-app` (GITHUB_ORG=UA-MIS,
D-007). These URLs are hardcoded in the manifests (`bootstrap/`,
`applicationsets/`, `tenants/`) because they are their real, permanent home.

For a **local T9 run before those repos are pushed to UA-MIS**, you can re-point
every repoURL at an alternate host in one shot — the same spirit as the
`PLATFORM_DOMAIN` / `REGISTRY` one-variable swaps (§6).

## Swap procedure

1. Set the base in the active target's values file:

   ```
   # clusters/local-k3d/values.env
   GIT_BASE_URL=http://gitea.127.0.0.1.sslip.io/capstone     # example local mirror
   ```

2. Rewrite the manifests:

   ```bash
   make set-repo-base        # rewrites platform-infra + <team>-app URLs to GIT_BASE_URL
   make show-repo-base       # verify what's now wired in
   ```

3. `make bootstrap` — ArgoCD now syncs from the local base.

To go back to the real org: set `GIT_BASE_URL=https://github.com/UA-MIS` and run
`make set-repo-base` again. The rewrite is idempotent and reversible.

## What `set-repo-base` touches

Every `repoURL:` / `sourceRepos:` entry ending in `platform-infra`, `*-app`, or
`sample-app` across `bootstrap/`, `applicationsets/`, and `tenants/`. It rewrites
only the host+org portion, preserving the repo name and any `.git` suffix.

> **Decision point (T9, with the human):** push `platform-infra` + `sample-app`
> to UA-MIS and sync from there (default), OR use a local mirror via this seam.
> Either way it's a one-variable change — no manifest edits.
