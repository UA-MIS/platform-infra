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
homepage: mis521-vm-handover      # optional; seeds the board's homepage. See below.
```

`host` is **not** a field. It is derived: `<team>-agile.capstone.uamishub.com`.
Deriving it is what keeps the Dex redirect URI, the Ingress host and `APP_URL`
from ever disagreeing — a class of failure that shows up as an opaque OIDC error
at sign-in rather than at startup.

### `homepage` — seeding the board's homepage

The board's landing page is a **living README**: markdown the team writes and
edits in the browser, stored in Postgres with revision history. `homepage` names
a document the platform ships, which that page starts out as:

    homepage: mis521-vm-handover
      -> platform-services/agile-boards/chart/files/homepage/mis521-vm-handover.md

Omit the key and the board shows the app's built-in starter text — which is what
every board did before this existed, and what most boards should keep doing. It
is **optional and must stay optional**: most files here set nothing.

Three properties are worth knowing before using it.

**It is a SEED, not a broadcast.** The app reads it only when the homepage has
never been edited (no `home` row in `board_pages` for that instance). So it
cannot overwrite a team's own writing — which is what makes it safe to add to a
live board — but equally, changing the document does **not** update a board
somebody has already edited. If you need to reach a team that has edited theirs,
tell them; do not expect this to do it.

**The team can edit it, and their edit wins.** That is intended. This is a
reference sheet they are meant to correct as they learn the machine, not a
read-only notice; the previous text stays in the page's revision history.

**The document is written ONCE and rendered per team.** It may contain
`__TEAM__` — the placeholder convention this repo already uses — and the chart
substitutes that board's own slug at render time.
That is the entire reason it is a document name here and not the markdown
itself: a document naming one team's hostnames, copied to three boards, would
send a student to another team's VM — where they would be refused by *that*
team's GitHub-team check and read the refusal as their own account being broken.
One source, three renders, no copies to keep in step.

Markdown support is the app's: GFM tables, fenced code, blockquotes, headings and
lists all render. Raw HTML and images are stripped by the sanitiser. Note that
the renderer sets `breaks: true`, so a hard-wrapped source line becomes a visible
line break — write paragraphs as single lines.

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
