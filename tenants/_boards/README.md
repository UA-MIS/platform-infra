# `tenants/_boards/` — one sprint board per TEAM

Each file here declares **one team's sprint board**. The file is the whole
declaration: drop a file in, the team gets a board; `git rm` it, the board goes
away.

    tenants/_boards/<team-slug>.yaml

## Why a separate directory instead of a field on the tenant claim (D-186)

A `CapstoneTenant` claim is keyed on **`<team>-<app>`** — it is a claim for a
*project*. The board is keyed on the **team**, and the owner's requirement is
explicit: *one board per TEAM, not per app; a team creating a second project
reuses the existing board.*

Putting `agileBoard: true` on the claim would mean two claims for one team both
rendering board resources with the same team-keyed names — two Crossplane
reconcile loops fighting over one object, every 30–60s. That is not a
hypothetical: it is the duplicate-tenant-claim incident of 2026-07-10 (two claims
for one team → NetworkPolicy apply-fight → Cilium CPU pin), and it is the same
dual-owner anti-pattern `platform-services/dex/configmap.yaml` calls out.

A file whose **name is the team slug** cannot double-provision. A second project
either finds the file already there (no-op) or does not. Idempotency is a
property of the filesystem, not of a guard somebody has to remember to write.

## Schema

```yaml
team: swami                       # REQUIRED. GitHub Team slug. Also the filename.
repos: UA-MIS/swami               # REQUIRED. Comma-separated; the repo(s) the board tracks.
title: Swami Board                # optional; defaults to "<team> Board"
accent: "#9e1b32"                 # optional; defaults to Crimson
```

`host` is **not** a field. It is derived: `<team>-agile.capstone.uamishub.com`.
Deriving it is what keeps the Dex redirect URI, the Ingress host and `APP_URL`
from ever disagreeing — a class of failure that shows up as an opaque OIDC error
at sign-in rather than at startup.

## What consumes this directory

| Consumer | What it does |
|---|---|
| `applicationsets/agile-boards-appset.yaml` | git-files generator → one ArgoCD Application per file → renders `platform-services/agile-boards/chart` into the `agile` namespace (shared with the maintainers' board) |
| `.github/workflows/dex-board-clients.yaml` | regenerates the team `redirectURIs` on the EXISTING `agile-board` Dex client from these files and opens a PR (Dex has no wildcard redirect URIs) |
| `make validate` | step 6/6 fails if the Dex ConfigMap has drifted from this directory |

Files beginning with `_` are examples, not live boards (same convention as
`tenants/_claims/`).

## Prod only

There is one board per team and it is **production**. No dev/staging board
instances: a sprint board holds the team's real plan of record, and a second copy
of it is not a test environment, it is a second source of truth.
