# Database migrations (Alembic)

The starter calls `Base.metadata.create_all()` on startup (see `app/db.py:init_db`).
That is fine for the sample and for the SQLite fallback, but **for a real MySQL
deployment you should adopt [Alembic](https://alembic.sqlalchemy.org/) migrations** so
schema changes are versioned, reviewable, and applied deterministically instead of
implicitly at boot.

## Adopting Alembic

```bash
cd app
python -m pip install alembic        # add `alembic` to requirements.txt too
alembic init migrations              # scaffolds migrations/ + alembic.ini
```

Then wire it up:

1. In `migrations/env.py`, set `target_metadata = Base.metadata` (import it from
   `app.db`) and read the URL from the environment:
   `config.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])`.
   Never hardcode credentials — `DATABASE_URL` comes from the Secrets tab (Vault/ESO).
2. Generate the first migration: `alembic revision --autogenerate -m "init"`.
3. Apply migrations at deploy time (an init-container or a one-shot Job), **not** in the
   app process: `alembic upgrade head`.
4. Once Alembic owns the schema, remove the `init_db()` call from the FastAPI lifespan
   in `app/main.py` so the two don't fight.

> The platform pod runs read-only-root + non-root; Alembic needs no writable filesystem
> (it talks to the database), so it works unchanged under those constraints.
