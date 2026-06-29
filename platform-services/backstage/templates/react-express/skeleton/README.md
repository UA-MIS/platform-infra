# ${{ values.appName }}

${{ values.description }}

A UA-MIS capstone **React (Vite) + Node/Express** webapp, scaffolded by **The Process**
(the developer portal) onto the platform golden path. This is the **multi-component**
layout: a React frontend and an Express backend living in ONE repo, deployed as two
workloads behind one ingress — no need to split into two repos. The two components are
fully independent (the framework even lets them be different languages); here they are a
TypeScript SPA and a TypeScript API.

## Repo layout — the `.devops/` contract

```
${{ values.appName }}/
├── frontend/   ←  YOU EDIT THIS.   Vite + React + TypeScript SPA (Tailwind). Served at "/".
├── backend/    ←  YOU EDIT THIS.   Node/Express + TypeScript API (MySQL). Served at "/api".
└── .devops/    ←  DO NOT EDIT.     Platform-managed deployment template.
                                    (.devops/components.yaml declares your components.)
```

Cohort: **${{ values.semesterDisplay }}**.

You own `frontend/` + `backend/`. The platform owns `.devops/`. The components your repo
deploys are declared in **`.devops/components.yaml`** (already filled in: a `frontend` and
a `backend`); the team/cohort values live in `.devops/app-metadata.yaml`:

```yaml
team: ${{ values.team }}
semester: ${{ values.semester }}   # cohort slug (${{ values.semesterDisplay }})
app-name: ${{ values.appName }}
port: ${{ values.port }}
```

Everything else — two Deployments, two Services, one path-routing Ingress, namespaces,
the ingress host, quotas, RBAC, network policy, CI (one image built per component) — is
derived from those files by the platform.

## The golden path

| You do | The platform does |
| --- | --- |
| Open a PR | Builds a **preview** environment (both components) |
| Merge to `main` | Auto-deploys **dev** (both components) |
| Tag `vX.Y.Z` | Auto-deploys **staging** |
| Approve the gate | Promotes to **prod** (manual gate) |

Your app will be reachable at `https://${{ values.appName }}.<env>.<platform-domain>`
(prod drops the `<env>` segment). On that one host, the Ingress routes:

| Path | Component |
| --- | --- |
| `/api` | `backend` (Express API) |
| `/` (everything else) | `frontend` (React SPA) |

## The components

**`frontend/`** — a Vite + React + TypeScript SPA styled with Tailwind v4. The page calls
the backend at the relative path `/api` (health + a sample items list), proving the
`/` → frontend, `/api` → backend split works end to end. Its Dockerfile builds the static
bundle and serves it with nginx (multi-stage, non-root, read-only-rootfs-safe).

Local dev:

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173 (proxies /api to :${{ values.port }})
```

**`backend/`** — a Node/Express + TypeScript JSON API under `/api`, talking to MySQL via
`mysql2` and the `DATABASE_URL` connection string. Routes: `GET /api/health` plus a sample
`items` CRUD (`GET/POST/PUT/DELETE /api/items`). `GET /healthz` is the platform probe and
stays green even with no database. Its Dockerfile is an independent multi-stage Node build
(non-root, listens on `$PORT`).

Local dev:

```bash
cd backend && npm install && npm run dev     # http://localhost:${{ values.port }}
```

| Route | Behavior |
| --- | --- |
| `GET /healthz` | `200 ok` — platform probe; independent of the database. |
| `GET /api/health` | `200` JSON: `status`, `db` (`up`/`down`/`unconfigured`), `time`. |
| `GET /api/items` | List items. `503` until `DATABASE_URL` is set. |
| `POST /api/items` | Create `{ "name": "..." }`. |
| `PUT /api/items/:id` | Update. |
| `DELETE /api/items/:id` | Delete. |

## Database — `DATABASE_URL` (MySQL)

The backend reads its MySQL connection string from the **`DATABASE_URL`** env var. The
platform injects it from your app's per-env secret — **you never put credentials in git**.

1. Open the **Secrets** tab on your component in The Process.
2. Add a key **`DATABASE_URL`** with your connection string
   (`mysql://user:pass@host:3306/dbname`) and pick the target env(s).
3. The Process writes it to your team's Vault path and opens a PR adding the
   `ExternalSecret` entry; merge it and ESO materializes the value, which the chart injects
   into the backend container as `DATABASE_URL`.

Until then the API returns `503` on the data routes and `db: unconfigured` on
`/api/health` — the app still deploys and `/healthz` stays green (zero-config). The sample
`items` table is created automatically on first connect; see
`backend/migrations/README.md` for moving to real migrations.

## Other secrets

Any other secret follows the same Secrets-tab flow (one `ExternalSecret` / one Kubernetes
Secret `${{ values.appName }}-secret` per env; all keys share the Vault object
`tenants/${{ values.team }}/<env>/app`). Secrets are **write-only** — to change one, set it
again. See `.devops/secrets/README.md`.

## Switching a base image to Debian/Ubuntu (apt) — read before you do

The starter Dockerfiles use **Alpine** Node/nginx bases and only `npm` (over HTTPS), so
they need no `apt`/`apk` and build first-try on the platform runners. If you switch a build
or runtime stage to a Debian-family base (`node:*-slim`, `debian:*-slim`, …) and run
`apt-get`, your CI build will fail on the platform runners unless you use the bootstrap
block documented in `docs/index.md`. Two platform facts cause it: the runner egress allows
external **:443 only** (Debian apt defaults to `http://…` :80 and is blocked), and slim
Debian bases ship **no `ca-certificates`** (the first HTTPS fetch can't verify the cert).
Staying on the Alpine bases avoids both.
