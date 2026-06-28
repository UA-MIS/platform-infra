# ${{ values.appName }}

${{ values.description }}

Scaffolded by **The Process** onto the UA-MIS capstone platform golden path. This is the
**React (Vite) + Node/Express** layout: a TypeScript SPA and a TypeScript API in one repo,
deployed as two workloads behind one ingress (`/` → frontend, `/api` → backend).

## Quick start

1. Clone this repo and edit `frontend/` + `backend/` (your code). Leave `.devops/` alone.
2. Run locally:
   - `cd backend && npm install && npm run dev` (API on `:${{ values.port }}`).
   - `cd frontend && npm install && npm run dev` (SPA on `:5173`, proxies `/api`).
3. Open a pull request — a **preview** environment is built automatically (both components).
4. Merge to `main` — **dev** auto-deploys.
5. Tag `vX.Y.Z` — **staging** auto-deploys; **prod** waits on the manual gate.

The components are declared in `.devops/components.yaml` (a `frontend` and a `backend`);
the CI builds one image per component.

## Deployment targets

| Environment | URL |
| --- | --- |
| dev | `https://${{ values.appName }}.dev.<platform-domain>` |
| staging | `https://${{ values.appName }}.staging.<platform-domain>` |
| prod | `https://${{ values.appName }}.<platform-domain>` |

## The `.devops/` contract

The platform owns everything under `.devops/`. Your knobs are the team/cohort fields in
`.devops/app-metadata.yaml` (`team`, `semester`, `app-name`, `port`) and the component
list in `.devops/components.yaml` (each component's build context, image, port, and
ingress path).

## Database

The backend connects to MySQL via the `DATABASE_URL` env var. **Do not** put credentials
in git — open the **Secrets** tab on your component in The Process, add a key
`DATABASE_URL` with your connection string, and merge the PR it opens. The External Secrets
Operator materializes it from your team's Vault path and the chart injects it into the
backend container. The API degrades gracefully (`503` on data routes, `db: unconfigured` on
`/api/health`) until it is set, and `/healthz` stays green. See
`backend/migrations/README.md` for schema/migrations.

## Other secrets

Other secrets follow the same flow (External Secrets Operator + Vault). One
`ExternalSecret` / one Kubernetes Secret `${{ values.appName }}-secret` per env; all keys
share the Vault object `tenants/${{ values.team }}/<env>/app`. Secrets are **write-only**
(set again to change). See `.devops/secrets/README.md`.

## Switching to a Debian/Ubuntu base image (apt) — read before you do

The starter Dockerfiles use **Alpine** Node/nginx bases and only `npm` over HTTPS, so they
need no `apt`/`apk` and build first-try on the platform runners. If you switch a build or
runtime stage to a Debian-family base (`node:*-slim`, `python:*-slim`, `debian:*-slim`, …)
and run `apt-get`, your CI build will fail on the platform runners **unless** you adapt apt
to the platform. Two platform facts cause it:

- The CI runner's egress allows external **:443 only** (no external :80) — Debian apt
  defaults to `http://…` (:80) and is blocked, so you must rewrite apt sources to HTTPS.
- Slim Debian bases ship **no `ca-certificates`** bundle, so the first HTTPS fetch can't
  verify the cert — bootstrap with peer-verify off for that one fetch to install
  `ca-certificates`, then verify normally afterward.

Copy this proven block (the exact pattern the platform's own images use) into any
Debian-base stage that runs apt:

```dockerfile
FROM node:24-trixie-slim AS build      # or python:3-slim, debian:trixie-slim, …
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    apt-get -o Acquire::https::Verify-Peer=false update && \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
    apt-get update && \
    apt-get install -y --no-install-recommends <your-packages-here> && \
    rm -rf /var/lib/apt/lists/*
```

> Today the runner netpol is inert (flannel) on the live cluster, so a build without this
> may pass right now — but it will break the moment `platform-netpol-runners` is enforced
> (Cilium). Staying on Alpine + npm avoids the issue entirely.

> Base images are pulled from Docker Hub today. At cohort scale this can hit Docker Hub
> rate limits; when the platform's pull-through cache is available, prefer pulling your base
> via the platform Harbor proxy (the platform team will announce the `FROM` host).
