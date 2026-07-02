# ${{ values.appName }}

${{ values.description }}

A **static single-page app** (Vite + React + TypeScript + Tailwind, served by nginx —
no backend, no database), scaffolded by **The Process** onto the UA-MIS capstone
platform golden path.

## Quick start

```bash
cd app
npm install      # first time (also generates package-lock.json — commit it)
npm run dev      # local dev server with hot reload (http://localhost:5173)
npm run build    # production build -> app/dist (what the container serves)
```

You own `app/`. The platform owns `.devops/`. The **only** values you declare are the
four fields in `.devops/app-metadata.yaml` (already filled in for you):

```yaml
team: ${{ values.team }}
semester: ${{ values.semester }}   # cohort slug (${{ values.semesterDisplay }})
app-name: ${{ values.appName }}
port: ${{ values.port }}
```

## Repo layout

```
${{ values.appName }}/
├── app/        ←  YOU EDIT THIS.   Your SPA (Vite/React/TS) + Dockerfile + nginx.conf.
│   ├── src/        components + pages (React Router client-side routing)
│   ├── Dockerfile  multi-stage: node build -> nginx (static dist/, non-root)
│   └── nginx.conf  SPA fallback routing + /healthz
└── .devops/    ←  DO NOT EDIT.     Platform-managed deployment template.
```

## The golden path

| You do | The platform does |
| --- | --- |
| Open a PR | Builds a **preview** environment |
| Merge to `main` | Auto-deploys **dev** |
| Tag `vX.Y.Z` | Auto-deploys **staging** |
| Approve the gate | Promotes to **prod** (manual gate) |

Your app will be reachable at
`https://${{ values.appName }}.<env>.<platform-domain>` (prod drops the `<env>`
segment: `https://${{ values.appName }}.<platform-domain>`).

## How it deploys (the Dockerfile)

`app/Dockerfile` is a **known-good multi-stage build**:

1. **Build stage** (`node:22-alpine`) runs `npm ci`/`npm install` then `vite build`,
   producing the static site in `dist/`.
2. **Runtime stage** (`nginx:1.27-alpine`) serves `dist/` — no Node in the final image.
   It runs **non-root** (UID 65532) under a **read-only root filesystem**, listens on
   the `port` from `app-metadata.yaml`, answers `GET /healthz` with `200 ok` (the
   platform probes), and falls back to `index.html` for client-side routes (deep links
   / hard refresh work).

You should not need to touch the Dockerfile or `nginx.conf` for a normal SPA.

## Routing (SPA fallback)

This app uses client-side routing (React Router). nginx is configured with
`try_files $uri $uri/ /index.html`, so a hard refresh on a route like `/about` still
serves the app instead of a 404. The in-app `*` route renders a friendly 404.

## Configuration / "secrets"

A static SPA has **no server-side secrets** — everything shipped to the browser is
public. Bake build-time config into the bundle with Vite env vars: create
`app/.env` with `VITE_`-prefixed keys (e.g. `VITE_API_BASE_URL=...`) and read them via
`import.meta.env.VITE_API_BASE_URL`. These are **public** (visible in the bundle); never
put a real secret in them. (The platform's Vault/ESO wiring still exists per-team for
backend services, but a static SPA does not consume it at runtime.)

## Switching the base image / adding `apt` packages — read before you do

If you change the build/runtime base to a Debian-family image (`node:*-slim`,
`debian:*-slim`, …) and run `apt-get`, the CI build will fail on the platform runners
unless you rewrite apt sources to HTTPS and bootstrap `ca-certificates` (the runner
egress allows external **:443 only**, and slim bases ship no CA bundle). The Alpine
bases shipped here use `apk` over HTTPS and need none of this. See `.devops/README.md`.
