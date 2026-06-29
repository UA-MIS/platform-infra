# Database migrations

The backend connects to MySQL using the `DATABASE_URL` connection string (a standard
`mysql://user:pass@host:3306/dbname` URI; `app/db.py` normalizes it to the
`mysql+pymysql://` form SQLAlchemy expects). **You never put credentials in git** — set
`DATABASE_URL` via the **Secrets** tab on your component in The Process; the platform
materializes it into your app's secret (External Secrets Operator + Vault), and the chart
injects it as an env var. Until it is set the data routes return a clean `503` and
`/healthz` stays green.

## Starter behavior (zero-config)

For convenience the app creates the sample `items` table idempotently at startup
(`app/db.py` → `ensure_schema()`), so the CRUD routes work as soon as `DATABASE_URL`
points at a reachable database. Apply the same DDL by hand if you prefer:

```bash
mysql "$DATABASE_URL" -e "CREATE TABLE IF NOT EXISTS items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
```

## Moving to real migrations (Alembic)

The startup bootstrap is fine for the starter, but for a real project adopt
[Alembic](https://alembic.sqlalchemy.org/) so schema changes are versioned and reviewable.

```bash
python -m pip install alembic        # add `alembic` to requirements.txt too
alembic init migrations
```

Then:

1. In `migrations/env.py` read the URL from the environment
   (`config.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])`) — never hardcode
   credentials — and point `target_metadata` at your model metadata if you adopt the ORM.
2. `alembic revision --autogenerate -m "init"` then `alembic upgrade head`.
3. Apply migrations at deploy time (an init-container or one-shot Job), **not** in the app
   process, and remove the `ensure_schema()` call from `create_app()` so the two don't fight.

> The platform pod runs read-only-root + non-root; Alembic needs no writable filesystem
> (it talks to the database), so it works unchanged under those constraints.
