# Fragment First-Run Build Matrix

**Author:** DevOps · **Date:** 2026-07-03 · **Branch:** `qa/fragment-build-matrix`

## What this is

The green-out-of-box CI gate (`green-check.py`, #195) only asserts a Dockerfile / build
workflow **is present** — it never actually builds it. This is the missing QA pass: a **real
first-run build** of every container/static wizard fragment, composed exactly as the live
`capstone:compose-project` scaffolder action assembles it (via `compose_lib.py` — the same
engine the gate build-reads, no drift), plus a YAML validation of the four mobile fragments'
artifact build workflows.

### Method (per fragment)

1. Compose the fragment with `compose_lib.scenario_for()` — the simplest valid wizard
   selection (single where the fragment allows it; a pure frontend is paired with the proven
   `backend/express`; DB-using stacks composed with `database=host-mysql` so the
   DATABASE_URL-wired overlays are exercised). This yields the real assembled repo:
   app skeleton + the shared `_contract` `.devops`.
2. `docker build` the component's rendered Dockerfile with **build context = the component
   dir** (exactly what tenant CI / Kaniko consumes).
3. Static sanity check: app binds the fragment's `defaultPort`, serves `healthPath`, and
   (if `needsDB`) reads `DATABASE_URL`.

Builder: `podman 5.8.3` (docker-CLI-emulated), `node 26`, on the platform dev host.

## Summary

- **Container/static fragments: 22.** First-try green: **21/22 (95%)**. After fix: **22/22 (100%)**.
- **1 FAIL, fixed:** `backend/dotnet-aspnet` — test sources globbed into the app build. Fixed in
  this PR and re-built green.
- **Mobile fragments: 4** (android-kotlin, flutter, ios-swift, react-native) — no Docker;
  `.mobile-ci/build.yaml` workflows validated as well-formed GitHub Actions YAML. All 4 pass.
- **Human attention required: none.** Every red was a deterministic fragment bug with a
  contained fix.
- `nextjs` (previously real-build-verified in #201) was **re-confirmed** green here (75s).

## Container / static build matrix

| Fragment | Build (first-try) | After fix | Port | healthPath | DB-wired | Build time | Notes |
|---|---|---|---|---|---|---|---|
| backend/django | ✅ PASS | ✅ | 8080 | /healthz | yes | 8s | gunicorn, PyMySQL (pure-python) |
| backend/dotnet-aspnet | ❌ FAIL | ✅ **FIXED** | 8080 | /healthz | yes | 36s→ok | test `.cs` globbed into app build — see Fixes |
| backend/express | ✅ PASS | ✅ | 8080 | /healthz | yes | 18s | tsc → node, mysql2 |
| backend/fastapi | ✅ PASS | ✅ | 8080 | /healthz | yes | 4s | uvicorn, PyMySQL |
| backend/flask | ✅ PASS | ✅ | 8080 | /healthz | yes | 5s | gunicorn |
| backend/go | ✅ PASS | ✅ | 8080 | /healthz | yes | 3s | static bin → distroless |
| backend/laravel | ✅ PASS | ✅ | 8080 | /healthz | yes | 28s | composer, pdo_mysql compiled via apt-over-HTTPS |
| backend/nestjs | ✅ PASS | ✅ | 8080 | /healthz | yes | 48s | nest build |
| backend/node-bare | ✅ PASS | ✅ | 8080 | /healthz | yes | 9s | bare http, mysql2 |
| backend/rails | ✅ PASS | ✅ | 8080 | /healthz | yes | 5s | puma, Trilogy native ext |
| backend/rust-axum | ✅ PASS | ✅ | 8080 | /healthz | yes | 37s | cargo --locked → distroless/cc |
| backend/spring-boot | ✅ PASS | ✅ | 8080 | /healthz | yes | 55s | maven fat-jar → temurin JRE |
| blank/bring-your-own | ✅ PASS | ✅ | 8080 | /healthz | yes | 2s | placeholder Go bin, FROM scratch |
| frontend/angular | ✅ PASS | ✅ | 8080 | /healthz | n/a | 21s | ng build → nginx (dist/app/browser) |
| frontend/react | ✅ PASS | ✅ | 8080 | /healthz | n/a | 19s | vite → nginx |
| frontend/solid | ✅ PASS | ✅ | 8080 | /healthz | n/a | 6s | vite → nginx |
| frontend/vue | ✅ PASS | ✅ | 8080 | /healthz | n/a | 6s | vite → nginx |
| fullstack/nextjs | ✅ PASS | ✅ | 3000 | /healthz | yes | 75s | standalone output + prisma (re-confirms #201) |
| fullstack/nuxt | ✅ PASS | ✅ | 8080 | /healthz | yes | 50s | nuxi build → node .output |
| fullstack/sveltekit | ✅ PASS | ✅ | 8080 | /healthz | yes | 50s | adapter-node |
| static/bare-html | ✅ PASS | ✅ | 8080 | /healthz | n/a | 3s | nginx multi-page |
| static/react-static | ✅ PASS | ✅ | 8080 | /healthz | n/a | 16s | vite SPA → nginx |

Notes:
- **Port**: backends/fullstack read `$PORT` (chart injects it); frontends/static are nginx and
  `listen ${{ values.port }}` renders to the `defaultPort` (verified rendered = `listen 8080`).
  `nextjs` is the one non-8080 default (3000) — wired consistently through its chart.
- **healthPath**: every fragment serves `/healthz` (backends DB-independent; nginx returns
  `200 'ok'`). Verified in source/nginx.conf for all 22.
- **DB-wired**: every `needsDB` fragment reads `DATABASE_URL` from env and degrades cleanly
  when unset (verified by source grep across all 13 DB fragments).
- Build times are on a warm layer cache; first cold pull of a base image adds a minute or two.

## Mobile artifact-workflow validation (4 fragments, no Docker)

Mobile fragments build a `.apk`/`.ipa` via `skeleton/.mobile-ci/build.yaml`, not a container,
so the equivalent of a Dockerfile build is a workflow-YAML validation.

| Fragment | Workflow | YAML | Triggers | Jobs |
|---|---|---|---|---|
| mobile/android-kotlin | .mobile-ci/build.yaml | ✅ valid | push, pull_request, workflow_dispatch | android |
| mobile/flutter | .mobile-ci/build.yaml | ✅ valid | push, pull_request, workflow_dispatch | android, ios |
| mobile/ios-swift | .mobile-ci/build.yaml | ✅ valid | push, pull_request, workflow_dispatch | ios |
| mobile/react-native | .mobile-ci/build.yaml | ✅ valid | push, pull_request, workflow_dispatch | android, ios |

(actionlint was not available on the host; validation is a YAML-parse + structural check of
`name` / `on` / `jobs`. All four render and parse cleanly.)

## Fixes applied in this PR

### `backend/dotnet-aspnet` — test sources globbed into the app build (was ❌ FAIL)

**Symptom:** `dotnet publish App.csproj` failed with `CS0246: 'Xunit' could not be found`,
compiling `tests/HealthControllerTests.cs` + `tests/WidgetsControllerTests.cs` into the API
assembly.

**Root cause:** the skeleton assumes the test project is a **sibling** `../tests`, but in the
flattened fragment skeleton `App.csproj` sits at the **root** and `tests/` is a **subfolder**.
Two guards both encoded the wrong `../tests` path and therefore missed:
- `.dockerignore` had `../tests/` (matches nothing at context root) → the test project was
  copied into the build context.
- `App.csproj` had `<Compile Remove="../tests/**/*.cs" />` → resolved to `/tests` (above the
  project root), so the Web SDK's default `**/*.cs` glob still pulled in `tests/*.cs`, which
  reference Xunit (not a dependency of the API project).

**Fix** (2 files, `../tests` → `tests`):
- `skeleton/.dockerignore`: `../tests/` → `tests/` (test project never enters the image context).
- `skeleton/App.csproj`: `Compile Remove="tests/**/*.cs"` (+ `Content`/`None` Remove) so a
  local `dotnet publish` outside Docker is correct too.

Re-composed and re-built after the fix → **green**.
