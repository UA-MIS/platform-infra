# ${{ values.appName }}

${{ values.description }}

A C# ASP.NET Core (.NET 8) Web API scaffolded by **The Process** onto the UA-MIS
capstone platform golden path.

## Quick start

1. Clone this repo and edit `app/` (your code). Leave `.devops/` alone.
2. Run it: `cd app && dotnet run` — then `GET http://localhost:${{ values.port }}/api/health`.
3. Run the tests: `dotnet test tests`.
4. Open a pull request — a **preview** environment is built automatically.
5. Merge to `main` — **dev** auto-deploys.
6. Tag `vX.Y.Z` — **staging** auto-deploys; **prod** waits on the manual gate.

## Endpoints

| Route | Behavior |
| --- | --- |
| `GET /healthz` | Probe — `200 ok`, DB-independent. |
| `GET /api/health` | App + database status (JSON). |
| `GET/POST/PUT/DELETE /api/widgets[/{id}]` | Sample EF Core CRUD over MySQL. |

## Deployment targets

| Environment | URL |
| --- | --- |
| dev | `https://${{ values.appName }}.dev.<platform-domain>` |
| staging | `https://${{ values.appName }}.staging.<platform-domain>` |
| prod | `https://${{ values.appName }}.<platform-domain>` |

## The `.devops/` contract

The platform owns everything under `.devops/`. Your only knobs are the four fields in
`.devops/app-metadata.yaml` (`team`, `semester`, `app-name`, `port`).

## Database & secrets

The MySQL connection string is read from the `DATABASE_URL` env (or
`ConnectionStrings__Default`), materialized by the External Secrets Operator from your
team's Vault path — **never hardcoded**. A fresh app with no DB still starts (it reports
the database as unconfigured). Open the **Secrets** tab on your component in The Process
to add a `DATABASE_URL` secret (and any other keys). Secrets are **write-only**; to
change one, set it again. See `.devops/secrets/README.md` for the full pattern.

## EF Core migrations

The starter uses `EnsureCreated()` for convenience. Before shipping schema changes,
switch to real migrations — see `app/Migrations/README.md`.

## Switching to a custom base image (apt) — read before you do

The starter uses the official `mcr.microsoft.com/dotnet/*` images, which need no `apt`.
If you switch a build/runtime stage to a Debian-family base and run `apt-get`, your CI
build can fail on the platform runners because the runner egress allows external
**:443 only** (no :80) and slim Debian bases ship no `ca-certificates`. Rewrite apt
sources to HTTPS and bootstrap `ca-certificates` first — the platform's own images use
that exact pattern. Ask the platform team if you hit this.
