# ${{ values.appName }} — PHP / Laravel API

A Laravel 12 (API routes) backend starter (the platform owns `.devops/`; this is YOUR app
code). It follows the platform backend contract:

- `GET /healthz` (and `/health`) — DB-independent 200 probe (the chart's liveness/
  readiness probes hit this).
- `GET /` — proves `APP_SECRET` was read without echoing it.
- `GET/POST /api/items`, `GET/PUT/DELETE /api/items/{id}` — sample CRUD (Eloquent).
  Served under `/api` so the platform ingress (`/api` → this backend) reaches it.
- Reads **`DATABASE_URL`** (a `mysql://` URI, parsed by Laravel's connection-URL support)
  and listens on **`PORT`**. When `DATABASE_URL` is unset the data routes return a clear
  **503** while `/healthz` stays 200 (zero-config boot). Credentials are never hardcoded —
  set `DATABASE_URL` via the Secrets tab.

## Local development

```bash
composer install
DATABASE_URL=mysql://user:pass@127.0.0.1:3306/app php artisan migrate
php artisan serve --host=0.0.0.0 --port=8080
```

## Tests

```bash
php artisan test    # in-memory SQLite (.env.testing); no MySQL needed
```

## Database migrations

See [`MIGRATIONS.md`](./MIGRATIONS.md). Run `php artisan migrate` at deploy time.
