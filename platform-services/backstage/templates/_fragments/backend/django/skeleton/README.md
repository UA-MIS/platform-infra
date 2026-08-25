# ${{ values.appName }} — Python / Django + DRF API

A Django + Django REST Framework backend starter (the platform owns `.devops/`; this is
YOUR app code). It follows the platform backend contract:

- `GET /healthz` (and `/health`) — DB-independent 200 probe (the chart's liveness/
  readiness probes hit this).
- `GET /` — proves `APP_SECRET` was read without echoing it.
- `GET/POST /api/items`, `GET/PUT/DELETE /api/items/<id>` — sample CRUD (Django ORM +
  DRF). Served under `/api` so the platform ingress (`/api` → this backend) reaches it.
- Reads **`DATABASE_URL`** (a `mysql://` URI) and listens on **`PORT`**. When
  `DATABASE_URL` is unset the data routes return a clear **503** while `/healthz` stays
  200 (zero-config boot). Credentials are never hardcoded — set `DATABASE_URL` via the
  Secrets tab.

## Local development

```bash
python -m venv .venv && . .venv/bin/activate   # or your preferred tool
pip install -r requirements-dev.txt
DATABASE_URL=mysql://user:pass@127.0.0.1:3306/app python manage.py migrate
python manage.py runserver 0.0.0.0:8080
```

## Tests & lint

```bash
pytest        # in-memory SQLite; no MySQL needed
ruff check .
```

## Database migrations

See [`MIGRATIONS.md`](./MIGRATIONS.md). The platform runs `python manage.py migrate` for you
on every deploy, in a migration initContainer — you do not have to apply them yourself.
