# ${{ values.appName }}

${{ values.description }}

A Python **FastAPI** API (SQLAlchemy 2.x + MySQL), scaffolded by **The Process** onto
the UA-MIS capstone platform golden path.

## Quick start

1. Clone this repo and edit `app/` (your code). Leave `.devops/` alone.
2. Install deps: `cd app && python -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt`.
3. Run it: `uvicorn app.main:app --reload --port ${{ values.port }}` (interactive docs at `/docs`).
4. Run the tests: `cd app && pytest -q`.
5. Open a pull request — a **preview** environment is built automatically.
6. Merge to `main` — **dev** auto-deploys.
7. Tag `vX.Y.Z` — **staging** auto-deploys; **prod** waits on the manual gate.

## Endpoints

| Route | Behavior |
| --- | --- |
| `GET /healthz` | `200 {"status":"ok"}` — liveness/readiness probe (the chart probes this). |
| `GET /health` | Alias of `/healthz`. |
| `GET /` | Proves it read `APP_SECRET` without echoing the value. |
| `… /items` | Sample CRUD over a SQLAlchemy `Item` model. |

## Database wiring — `DATABASE_URL` (MySQL)

The app reads `DATABASE_URL` from the environment (`app/db.py`); there are **no
hardcoded credentials**. In the cluster, set it (a MySQL DSN
`mysql+pymysql://user:pass@host:3306/db`) via the **Secrets** tab — the value goes to
Vault, ESO materializes a Kubernetes Secret, and the platform envs it into the pod.
Locally/in tests, an unset `DATABASE_URL` falls back to in-memory SQLite so the app boots
with zero setup. For real schema management adopt Alembic (`app/migrations/README.md`).

## Deployment targets

| Environment | URL |
| --- | --- |
| dev | `https://${{ values.appName }}.dev.<platform-domain>` |
| staging | `https://${{ values.appName }}.staging.<platform-domain>` |
| prod | `https://${{ values.appName }}.<platform-domain>` |

## The `.devops/` contract

The platform owns everything under `.devops/`. Your only knobs are the four fields in
`.devops/app-metadata.yaml` (`team`, `semester`, `app-name`, `port`).

## Secrets

Your team's secrets live as **`ExternalSecret` declarations** (External Secrets Operator
+ Vault). You do **not** put values in git — open the **Secrets** tab, enter a key/value
and the target env(s), and it writes the value to your team's Vault path and opens a PR
adding the per-env `ExternalSecret`. Merge it and ArgoCD applies it; ESO materializes the
Kubernetes Secret. Secrets are **write-only**. This is how you supply `DATABASE_URL`. See
`.devops/secrets/README.md`.

## Adding apt packages — read before you do

The starter is `python:3.12-slim` with **no `apt`** (PyMySQL is pure-Python; uvicorn is
wheels). If you add a stage that runs `apt-get`, your CI build will fail on the platform
runners **unless** you use the bootstrap block shipped (commented) in `app/Dockerfile`:

- The CI runner's egress allows external **:443 only** (no external :80) — Debian apt
  defaults to `http://…` (:80) and is blocked, so you must rewrite apt sources to HTTPS.
- Slim Debian bases ship **no `ca-certificates`** bundle, so the first HTTPS fetch can't
  verify the cert — bootstrap with peer-verify off for that one fetch to install
  `ca-certificates`, then verify normally afterward.

> Base images are pulled from Docker Hub today. At cohort scale this can hit Docker Hub
> rate limits; when the platform's pull-through cache is available, prefer pulling your
> base via the platform Harbor proxy (the platform team will announce the `FROM` host).
