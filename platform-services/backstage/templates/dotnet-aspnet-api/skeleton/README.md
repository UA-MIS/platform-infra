# ${{ values.appName }}

A UA-MIS capstone **C# ASP.NET Core (.NET 8) Web API**, scaffolded by **The Process**
(the developer portal) onto the platform golden path.

## Repo layout — the `.devops/` contract

```
${{ values.appName }}/
├── app/        ←  YOU EDIT THIS.   Your ASP.NET Core Web API + Dockerfile.
├── tests/      ←  YOU EDIT THIS.   xUnit unit tests (`dotnet test tests`).
└── .devops/    ←  DO NOT EDIT.     Platform-managed deployment template.
```

Cohort: **${{ values.semesterDisplay }}**.

You own `app/` and `tests/`. The platform owns `.devops/`. The **only** values you
declare are the four fields in `.devops/app-metadata.yaml` (already filled in for you):

```yaml
team: ${{ values.team }}
semester: ${{ values.semester }}   # cohort slug (${{ values.semesterDisplay }})
app-name: ${{ values.appName }}
port: ${{ values.port }}
```

Everything else — Deployment, Service, Ingress, namespaces, the ingress host, quotas,
RBAC, network policy, CI — is derived from those values by the platform.

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

## The app (`app/`)

A minimal ASP.NET Core Web API with EF Core on MySQL (Pomelo) to start from:

| Route | Behavior |
| --- | --- |
| `GET /healthz` | `200 ok` — DB-independent liveness/readiness probe (the `.devops` chart probes this). |
| `GET /api/health` | `200` JSON — app name + whether the database is reachable. |
| `GET /api/widgets` | List sample widgets (EF Core / MySQL). |
| `GET /api/widgets/{id}` | Get one widget. |
| `POST /api/widgets` | Create a widget (`{ "name": "...", "description": "..." }`). |
| `PUT /api/widgets/{id}` | Update a widget. |
| `DELETE /api/widgets/{id}` | Delete a widget. |

Run it locally:

```bash
cd app
dotnet run            # serves on http://localhost:${{ values.port }}
# GET http://localhost:${{ values.port }}/api/health
```

Run the tests:

```bash
dotnet test tests
```

Replace `Widget` (`app/Models/Widget.cs`), `AppDbContext`, and the controllers with
your own. See `app/Migrations/README.md` for switching to real EF Core migrations.

## Database — MySQL via `DATABASE_URL` (no hardcoded creds)

The connection string is read at runtime from the **`DATABASE_URL`** environment
variable (or `ConnectionStrings__Default`), which the platform materializes from your
team's Vault path. **Nothing is hardcoded** — `appsettings.json` ships an empty default
on purpose.

A freshly-scaffolded app deploys fine with **no** database configured: `/healthz` and
`/api/health` stay up, and the `/api/widgets` CRUD returns `503 database unavailable`
until you set a connection string. To wire MySQL, open the **Secrets** tab on your
component in The Process and add a secret named **`DATABASE_URL`** for the env(s) you
want (e.g. `Server=...;Port=3306;Database=...;User ID=...;Password=...;`). The platform
writes it to Vault and the External Secrets Operator materializes it into your pod — see
the **Secrets** section below and `.devops/secrets/README.md`.

## Secrets

Your team's secrets live as **`ExternalSecret` declarations** under `.devops/` (External
Secrets Operator + Vault). You do **not** put values in git — open the **Secrets** tab
on your component in The Process, enter a key/value and the target env(s), and it writes
the value to your team's Vault path and opens a PR that adds the pointer. Merge it and
ArgoCD applies it; ESO reads the value from Vault and materializes the Kubernetes
Secret. Secrets are **write-only** (you can't read a value back; to change one, set it
again). The starter already wires `DATABASE_URL` (for MySQL) and the optional
`APP_SECRET` demo env from that materialized secret. See `.devops/secrets/README.md`.

## Notes on the build

The image is built by the platform CI with Kaniko from `app/` using `app/Dockerfile`
(SDK build → `aspnet` runtime, non-root). The platform CI's language auto-detect covers
go/node/python today (not yet .NET), so it **skips** the lint/test stage for this repo —
keep `dotnet test tests` green locally before you open a PR.

> Base images (`mcr.microsoft.com/dotnet/*`) are pulled from Microsoft's registry. If
> the platform announces a pull-through cache host, prefer it for your `FROM` lines.
