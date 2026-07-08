# ${{ values.appName }}

A UA-MIS capstone project (frontend + backend), scaffolded by **The Process** (the
developer portal) onto the platform golden path. This is the **multi-component** layout:
a separate frontend and backend living in ONE repo, deployed as two workloads behind one
ingress — no need to split into two repos.

## Repo layout — the `.devops/` contract

```
${{ values.appName }}/
├── frontend/   ←  YOU EDIT THIS.   Frontend component code + Dockerfile (served at "/").
├── backend/    ←  YOU EDIT THIS.   Backend component code + Dockerfile (served at "/api").
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
| `/api` | `backend` |
| `/` (everything else) | `frontend` |

## The components

Both starters are standard-library-only Go services (build first-try on the platform —
Go-on-scratch, no apt). Replace them with your real stack (e.g. a React/node frontend);
the platform contract only needs each container to serve its routes on the declared port.

**`frontend/`** — serves a page at `/` whose JavaScript calls `/api/hello`, proving the
`/` → frontend, `/api` → backend split works end to end.

| Route | Behavior |
| --- | --- |
| `GET /healthz` | `200 ok` — probe (hit directly, uniform across components). |
| `GET /` | `200` HTML page that fetches `/api/hello`. |

**`backend/`** — a JSON API under `/api`.

| Route | Behavior |
| --- | --- |
| `GET /healthz` | `200 ok` — probe. |
| `GET /api/hello` | `200` JSON proving it read `APP_SECRET` (bool + length + sha256 prefix) **without** echoing the value. |

Run the tests: `cd backend && go test ./...` and `cd frontend && go test ./...`.

## Adding / changing a component

Edit **`.devops/components.yaml`** AND the chart together — see
`.devops/README.md` → *"Adding a component"*. For the common frontend + backend case the
scaffold already wired everything; you usually only edit `frontend/` and `backend/`.
