# ADR-034 — Unified "New Project" wizard with composable language fragments

- Status: Proposed (Phase A foundation; branch `feat/unified-project-wizard`, NOT merged)
- Date: 2026-06-28
- Supersedes (in intent): the per-stack Wave-2 templates `react-express`, `python-fastapi-api`,
  `dotnet-aspnet-api`, `react-static`, `nextjs-fullstack` (kept for now; migrated to fragments)
- Related: ADR-008 (promotion contract), ADR-030 (ESO/Vault secrets), ADR-031 (Crossplane
  zero-touch onboarding / CapstoneTenant XR), ADR-033 / #146 (auto-DB), the multi-component
  contract (`platform.capstone/v1` components.yaml), #149 (vm-app), #137 (stack survey)

## Context

The IDP grew one scaffolder template per stack (`react-express`, `python-fastapi-api`,
`dotnet-aspnet-api`, `react-static`, `nextjs-fullstack`, plus the generic
`new-capstone-project`). Each one **embeds its own full copy** of the `.devops/` + `.github/`
golden-path contract in its skeleton. That is exactly the failure mode the v1 retro flagged
as **the** bug generator: *copy-not-reference*. A contract fix (a Dockerfile lesson, a CI
tweak, an overlay change) must be hand-applied to N skeletons and drifts the moment one is
missed. It also does not scale: the team wants to offer *dozens* of language/framework
choices, and a template-per-combo is N×M (every frontend × every backend × DB option).

We want ONE "New Project" wizard with branching choices — **project type** (web / mobile),
for web **single vs frontend+backend**, then **pick a frontend / pick a backend**, then a
**database** choice — assembled at scaffold time from **composable fragments** (one starter
per language/framework), over **one shared contract**. VM workloads keep their proven
dedicated path (#149).

## Decision

### D1 (strategic) — A metadata-driven composition engine, not pre-baked combos

Adopt a custom scaffolder action **`capstone:compose-project`** that, at scaffold time:

1. reads each chosen fragment's **`fragment.yaml`** metadata,
2. computes the `.devops/components.yaml` component model (1 entry for single, 2 for
   frontend+backend, backend + mobile-artifact for mobile),
3. renders each chosen fragment's `skeleton/` into its component dir (`app/`, or
   `frontend/`+`backend/`, or `backend/`+`mobile/`),
4. renders the **ONE shared contract** (`_fragments/_contract/`) ONCE with the computed
   component list, and
5. sets the tenant **`database`** flag (none|mysql) from the wizard DB choice + `needsDB`.

The pure routing/DB logic lives in **`composePlan.js`** — a dependency-free module the
action, the offline dry-render harness, and the unit tests all import (one source, no drift).

**Why an action that READS `fragment.yaml` at runtime (the load-bearing choice):** it makes
the fan-out free. A new fragment is *just* a directory + a `fragment.yaml`; the wizard/engine
need no code change to support it (only the wizard's visible choice list is regenerated, a
one-line paste — see `gen-wizard-enums.py`). The engine adapts to each fragment's declared
port/path/DB/build-type. This is what turns "dozens of fragments" from N×M templates into
O(N) drop-in dirs.

**Rejected alternative — pure conditional `fetch:template` (no custom action).** It avoids a
one-time Backstage backend rebuild and the project rightly prizes "no image rebuild". But it
cannot read `fragment.yaml`, so every fragment's port/path/kind/needsDB would have to be
hard-coded into the wizard form (O(N) wizard edits per fragment) and would drift from
`fragment.yaml`. That defeats the fan-out goal. We pay the one-time rebuild once;
**thereafter dozens of fragments need zero rebuild**, which is the right trade. (The proven
`fetch:template`/`copyWithoutTemplating` rendering semantics are preserved — the action uses
nunjucks with Backstage's `${{ }}` syntax and ships `.github/**` + `.devops/ci/**` verbatim.)

### D2 — ONE shared contract, referenced not copied (`_fragments/_contract/`)

The `.devops/` (chart base + 4 overlays + `ci/` scripts + `promotion.yaml` + `components.yaml`)
and `.github/` CI workflow + `catalog-info.yaml` + `mkdocs`/docs live ONCE in
`_fragments/_contract/`. Every project renders from this single source. Fixing the contract
is a one-file change for all stacks — the copy-not-reference fix.

The unified contract **always uses the component model** (a `components.yaml` + a chart that
loops over components), even for a single-component app (a 1-element list: `name: app`,
`path: /`). This removes the legacy single/multi skeleton split (one contract, not two). The
chart keys DB wiring on the per-component `needsDb` (not `kind`), and **excludes
`buildType: mobile-artifact` components** from Deployment/Service/Ingress.

### D3 — The fragment contract (`fragment.yaml`) — see "Fragment contract" below

### D4 — Mobile is a distinct build-artifact category

A mobile fragment produces a signed **.ipa/.apk via a build workflow**, NOT a k8s Deployment.
It has no Dockerfile and no pod/Service/Ingress; its backend is a normal backend fragment,
deployed the usual way. The engine excludes mobile components from the chart and installs
their build workflow instead.

### D5 — VM stays the dedicated "New VM" button

`projectType` is `web | mobile`. KubeVirt VM workloads (#149, `vm-app`) remain their own
top-level template — a VM is a fundamentally different workload than a container, the
`vm-app` template already nails it, and folding it into the container compose engine adds
risk with no benefit. (A future `vm` projectType could defer to it; out of scope for Phase A.)

### D6 — Database wiring (integrates ADR-033 / #146)

The wizard offers, when a `needsDB` stack is chosen: `host-mysql` (auto-provisioned),
`host-postgres` / `bring-your-own` (you set `DATABASE_URL` via the Secrets tab), or `none`.
The engine resolves `database: mysql` **only** for `host-mysql` AND a DB-using component
(never provisions an unused DB), writes it to `.devops/app-metadata.yaml`, and conditionally
wires the `DATABASE_URL` ExternalSecret (`dbWired`) into each overlay. The app reads
`DATABASE_URL` (mysql URI) and degrades cleanly when unset (zero-config). Provisioning is the
CapstoneTenant `database` field (ADR-033 enum `none|mysql`); `host-postgres` is offered as
BYO until the Composition adds Postgres.

## Fragment contract (VERBATIM — this is the fan-out spec)

### Directory layout

```
platform-services/backstage/templates/
  _fragments/
    _contract/                         # the ONE shared contract (rendered once per project)
      .devops/ {app-metadata.yaml, components.yaml, promotion.yaml,
                chart/base/*, chart/overlays/{dev,staging,prod,preview}/*, ci/*}
      .github/workflows/build-and-push.yaml      # shipped VERBATIM (copyWithoutTemplating)
      catalog-info.yaml  mkdocs.yml  docs/
    <category>/<id>/                   # category ∈ frontend|backend|static|fullstack|mobile
      fragment.yaml                    # the metadata contract (below)
      skeleton/                        # the starter app code; build context = skeleton ROOT
        Dockerfile                     # (mobile: NO Dockerfile; a .mobile-ci/ workflow instead)
        ...app source...
    _tools/ {dry-render.py, gen-wizard-enums.py}
  new-project/template.yaml            # the unified wizard
```

The compose engine renders **`<fragment>/skeleton/**`** into the component's target dir
(`app/`, `frontend/`, `backend/`, or `mobile/`). `fragment.yaml` itself is NOT copied.

### `fragment.yaml` schema (`platform.capstone/fragment.v1`)

```yaml
apiVersion: platform.capstone/fragment.v1
id: <kebab>                 # unique within category; equals the dir name
displayName: <string>       # shown in the wizard enumNames
category: frontend|backend|static|fullstack|mobile
language: <string>          # typescript | python | csharp | swift | kotlin | dart ...
framework: <string>         # react | express | fastapi | aspnet | nextjs | none (bare)
slots:                      # which wizard slots it can fill
  - single|frontend|backend|mobile
defaultPort: 8080           # container port (PORT env + Service/Ingress target); wizard default
ingressPath: "/" | "/api"   # path WHEN composed as a non-root component (backends "/api")
needsDB: true|false         # reads DATABASE_URL? -> drives the wizard DB question + chart wiring
buildType: container|static|mobile-artifact   # mobile-artifact = NO k8s workload
dockerfile: Dockerfile      # path within skeleton/ (mobile: "" ; use buildWorkflow)
healthPath: /healthz        # probe path the container serves (container/static builds)
notes: >-                   # free text for humans + fan-out builders
  ...
# mobile-only extra fields:
# buildWorkflow: .mobile-ci/build.yaml   # path within skeleton/ to the artifact build workflow
# artifact: app.ipa                      # the produced artifact (documentation)
```

### Wiring conventions (load-bearing — fan-out builders MUST follow)

- **Slot → component:** the engine assigns the component name + ingress path by SLOT, not by
  the fragment: `single` → `name: app`, `path: /`; FE+BE → `frontend` (`/`) + `backend`
  (its `ingressPath`, i.e. `/api`); mobile → `backend` (`/`) + `mobile` (no path, not deployed).
  The fragment's `kind` (from category) and `needsDb` flow into `components.yaml`.
- **Frontend → backend:** a frontend fragment calls its backend over the SAME origin via a
  relative `/api/...` URL (never a hardcoded host). The ingress routes `/` → frontend,
  `/api` → backend (longest-prefix). Local dev: proxy `/api` (e.g. Vite proxy).
- **A backend fragment MUST expose:** a **DB-independent `GET /healthz`** (200 — the chart
  probes hit this; it must stay green with no DB), and its API under **`/api/...`** (so the
  `/api` ingress route reaches it). It MUST read its DB from the **`DATABASE_URL`** env (a
  `mysql://` URI) and degrade cleanly (clear 503) when unset (zero-config). NEVER hardcode creds.
- **Ports:** every container listens on the **`PORT`** env (the chart sets it from the
  component `port`). Default 8080. nginx-served frontends/static listen on `${{ values.port }}`.
- **No `.devops/`/`.github/` inside a fragment** — the contract is shared from `_contract/`.
- **Fragment code IS nunjucks-rendered** at compose time: it may use `${{ values.appName }}`,
  `${{ values.description }}`, `${{ values.port }}`. Shell `${VAR}` and JS `${x}` are SAFE
  (only the 3-char `${{ ... }}` form is substituted). `.devops/ci/**`, `.github/**`, and
  `**/.mobile-ci/**` are shipped VERBATIM (never templated).
- **A mobile fragment** sets `buildType: mobile-artifact`, `dockerfile: ""`, a
  `buildWorkflow:` under `skeleton/.mobile-ci/`, and is ALWAYS composed with a backend
  fragment (its API). It is recorded in `components.yaml` but the chart never deploys it.

### Adding a fragment (the fan-out)

1. `mkdir -p _fragments/<category>/<id>/skeleton` and add the starter app + Dockerfile
   (mobile: a `.mobile-ci/` build workflow instead of a Dockerfile).
2. Write `_fragments/<category>/<id>/fragment.yaml` per the schema above.
3. `python3 _fragments/_tools/gen-wizard-enums.py` and paste the regenerated enum/enumNames
   into `new-project/template.yaml`.
No engine code change — `capstone:compose-project` reads `fragment.yaml` at scaffold time.

## Components model emitted (`components.yaml`, `platform.capstone/v1`)

Per component: `name, kind, context, dockerfile, image (=<appName>-<name>), port, path,
needsDb, buildType`. Consumed by `ci/resolve-components.sh` (CI build matrix) and the chart
(`deployments`/`services`/`ingress` loop). `needsDb` gates the optional `DATABASE_URL` env;
`buildType: mobile-artifact` is skipped by the chart loops.

## Seed fragments (Phase A — converted from the proven Wave-2 templates)

| fragment | from | category | needsDB | slots |
| --- | --- | --- | --- | --- |
| `frontend/react` | react-express (frontend) | frontend | no | frontend |
| `backend/express` | react-express (backend) | backend | yes | backend, single |
| `backend/fastapi` | python-fastapi-api | backend | yes | backend, single |
| `backend/dotnet-aspnet` | dotnet-aspnet-api | backend | yes | backend, single |
| `static/react-static` | react-static | static | no | single |
| `mobile/_EXAMPLE` | — (contract example) | mobile | no | mobile |

(`nextjs-fullstack` is the natural next fragment — `fullstack/nextjs`, slot `single`,
needsDB — added during fan-out.)

## Validation performed (Phase A)

- `composePlan.test.cjs` — 7 unit tests, run under `node --test`, all pass (single/FE+BE/
  static/mobile/BYO/db-none/slot-misuse).
- `dry-render.py` — assembles real output trees from the fragments + contract and runs
  **`kubectl kustomize`** on all 4 overlays:
  - single (FastAPI + host-mysql): 1 component `app` at `/`, `database=mysql`, DATABASE_URL
    wired, all overlays build OK;
  - frontend+backend (React + Express + host-mysql): `frontend /` + `backend /api`,
    `database=mysql`, DATABASE_URL wired, all overlays build OK;
  - static (react-static): 1 component, no DB, no DATABASE_URL, all overlays build OK.
  No leftover `${{ }}` in rendered output (except the verbatim `ci/`+`.github/`).
- `template.yaml` + all `fragment.yaml` + the contract workflow parse (pyyaml).
- `actionlint` on the contract workflow: clean (exit 0).
- `composeProject.test.ts` (jest) ships for the user's CI (mocks the UrlReader); not run in
  Phase A (no Backstage node_modules in the worktree).

## Consequences

- **One-time cost:** shipping `capstone:compose-project` needs a Backstage backend image
  rebuild (new deps: `nunjucks`, `yaml`). Paid once; fan-out thereafter is rebuild-free.
- The legacy per-stack templates remain until migrated; the wizard is additive.
- `database → CapstoneTenant` is recorded in `app-metadata.yaml`; passing it into the
  onboarding claim is the explicit integration seam with #146/ADR-033 (the `database` field
  on the XR/`emit-tenant-claim`).
- The wizard's visible choice lists are generated (not dynamic) — a deliberate low-risk
  choice over a custom frontend field extension (a possible future enhancement).
