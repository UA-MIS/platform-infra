# ${{ values.appName }}

${{ values.description }}

A **Python FastAPI** API (SQLAlchemy 2.x + MySQL), scaffolded by **The Process** onto
the UA-MIS capstone platform golden path.

## Quick start

1. Clone this repo and edit `app/` (your code). Leave `.devops/` alone.
2. Create a virtualenv and install deps:
   ```bash
   cd app
   python -m venv .venv && . .venv/bin/activate
   pip install -r requirements-dev.txt
   ```
3. Run it locally (uses an in-memory SQLite DB until you wire MySQL — see below):
   ```bash
   uvicorn app.main:app --reload --port ${{ values.port }}
   ```
   Then open `http://localhost:${{ values.port }}/docs` for the interactive API.
4. Run the tests: `cd app && pytest -q`.
5. Open a pull request — a **preview** environment is built automatically.
6. Merge to `main` — **dev** auto-deploys.
7. Tag `vX.Y.Z` — **staging** auto-deploys; **prod** waits on the manual gate.

## The app (`app/`)

A minimal FastAPI service to start from:

| Route | Behavior |
| --- | --- |
| `GET /healthz` | `200 {"status":"ok"}` — liveness/readiness probe (the platform chart probes this path). |
| `GET /health` | Alias of `/healthz`. |
| `GET /` | `200` — proves it read `APP_SECRET` (bool + length + sha256 prefix) **without** echoing the value. |
| `… /items` | Sample CRUD over a SQLAlchemy `Item` model (`POST`/`GET`/`PUT`/`DELETE`). |

Layout:

```
app/
├── app/
│   ├── main.py          # FastAPI app + health/secret-proof routes
│   ├── db.py            # SQLAlchemy engine/session + get_db dependency
│   ├── models.py        # ORM models (sample Item)
│   ├── schemas.py       # Pydantic request/response models
│   └── routers/items.py # sample CRUD router
├── migrations/README.md # how to adopt Alembic for real schema management
├── requirements.txt     # runtime deps (baked into the image)
├── requirements-dev.txt # + test/lint deps (pytest, httpx, ruff)
├── Dockerfile           # slim, non-root, read-only-fs friendly
└── tests/               # pytest unit tests (health + CRUD)
```

## Database wiring — `DATABASE_URL` (MySQL)

The app reads its database connection from the **`DATABASE_URL`** environment variable
(`app/db.py`). There are **no hardcoded credentials** anywhere in the repo.

- **In the cluster:** set `DATABASE_URL` to your MySQL DSN
  (`mysql+pymysql://<user>:<password>@<host>:3306/<database>`) via the **Secrets** tab
  on your component in The Process. That writes the value to your team's Vault path; ESO
  materializes it into a Kubernetes Secret which the platform envs into the pod. Then add
  the env var to your workload by referencing that Secret in `.devops/chart` (see the
  `APP_SECRET` wiring in `.devops/chart/base/deployment.yaml` for the pattern). **Never
  commit a connection string to git.**
- **Locally / in tests:** if `DATABASE_URL` is unset the app falls back to an in-memory
  SQLite database, so it boots and the sample CRUD works with zero setup.

For real MySQL schema management, adopt Alembic migrations — see
`app/migrations/README.md` (the starter's `init_db()` create-all is for the sample only).

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
+ Vault). You do **not** put values in git — open the **Secrets** tab on your component
in The Process, enter a key/value and the target env(s), and it writes the value to your
team's Vault path and opens a PR that adds the per-env `ExternalSecret`. Merge it and
ArgoCD applies it; ESO reads the value from Vault and materializes the Kubernetes Secret.
Secrets are **write-only** (you can't read a value back; to change one, set it again).
This is exactly how you supply `DATABASE_URL` (above). See `.devops/secrets/README.md`
for the full pattern.

## The Dockerfile (apt note)

The starter image is `python:3.12-slim` and needs **no `apt`** (PyMySQL is pure-Python;
uvicorn installs as wheels). If you add a stage that runs `apt-get`, your CI build will
fail on the platform runners **unless** you use the bootstrap block shipped (commented)
at the bottom of `app/Dockerfile`. Two platform facts cause it:

- The CI runner's egress allows external **:443 only** (no external :80) — Debian apt
  defaults to `http://…` (:80) and is blocked, so you must rewrite apt sources to HTTPS.
- Slim Debian bases ship **no `ca-certificates`** bundle, so the first HTTPS fetch can't
  verify the cert — bootstrap with peer-verify off for that one fetch to install
  `ca-certificates`, then verify normally afterward.

> Base images are pulled from Docker Hub today. At cohort scale this can hit Docker Hub
> rate limits; when the platform's pull-through cache is available, prefer pulling your
> base via the platform Harbor proxy (the platform team will announce the `FROM` host).
