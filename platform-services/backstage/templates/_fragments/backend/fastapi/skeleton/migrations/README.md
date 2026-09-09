# Database migrations (Alembic) — NOT SET UP YET

> **Read this first: this starter does NOT use Alembic.** There is no `alembic.ini`, no
> `env.py` and no `versions/` here, and `alembic` is not in `requirements.txt`, so it is
> not in your built image. This directory contains ONE file — this to-do list. Nothing
> below is wired up until you wire it up.
>
> Concretely, that means **`migrate: "alembic upgrade head"` in
> `.devops/components.yaml` will NOT work on this starter as shipped.** The migration
> initContainer runs that command inside your image, `alembic` isn't there, and the pod
> wedges in `Init` after 3 failed attempts — the app container never starts. Follow the
> steps below FIRST; the `migrate:` field is the last step, not the first.

Your schema is currently created by `Base.metadata.create_all()` on startup (see
`app/db.py:init_db`). That is fine for the sample and for the SQLite fallback, but
**for a real deployment you should adopt [Alembic](https://alembic.sqlalchemy.org/)**
so schema changes are versioned, reviewable, and applied deterministically instead of
implicitly at boot. `create_all()` only ever ADDS missing tables — it cannot apply a
column change, a type change or a data backfill, and it will not tell you it skipped
them.

## Adopting Alembic

Run from THIS component's directory (the build context — the one with `Dockerfile` and
`requirements.txt` in it, e.g. `backend/`), not from `app/`:

```bash
python -m pip install alembic
alembic init migrations              # scaffolds migrations/ + alembic.ini
```

Then wire it up. Steps 3 and 4 are the ones people miss, and each of them fails at
deploy time rather than locally:

1. **Add `alembic` to `requirements.txt`** — the RUNTIME file, not
   `requirements-dev.txt`. The migration runs inside your deployed image, so a dev-only
   dependency isn't there when it matters. Pin it (`alembic==<version>`) like everything
   else in that file.

2. **Point `migrations/env.py` at your models and your DSN.** Set
   `target_metadata = Base.metadata` (import from `app.db`, and `import app.models` so
   the models actually register).

   For the URL, **do not use `os.environ["DATABASE_URL"]` raw.** The platform hands you
   a bare DSN (`postgresql://…` or `mysql://…`); SQLAlchemy needs the driver-qualified
   form (`postgresql+psycopg://…`, `mysql+pymysql://…`) and will otherwise reach for a
   default driver that is not installed, failing with `ModuleNotFoundError` at import.
   `app/db.py` already has the conversion — reuse it rather than writing a second copy
   that can drift:

   ```python
   from app.db import Base, _normalize_url
   url = _normalize_url(os.environ["DATABASE_URL"])
   ```

   Never hardcode credentials; leave `sqlalchemy.url` blank in `alembic.ini`.

3. **Copy the config and the scripts into the image.** The Dockerfile only copies `app`,
   so add:

   ```dockerfile
   COPY alembic.ini ./
   COPY migrations ./migrations
   ```

   Without this, `alembic` is installed but has nothing to read and dies with
   `No config file 'alembic.ini' found` — in the initContainer, which wedges the pod.

4. **Generate the first migration** — `alembic revision --autogenerate -m "init"` — and
   read the generated file before committing it. Autogenerate misses column renames
   (it emits drop + add, which loses the data).

5. **If your app has already been deployed, its tables already exist.** `create_all()`
   built them at boot, and there is no `alembic_version` table, so a vanilla first
   migration fails with `relation "…" already exists` and the pod wedges in `Init`.
   Either `alembic stamp head` against each existing database once, or make the initial
   revision skip creation when the table is present. Check the live schema matches your
   models before doing either.

6. **Remove the `init_db()` call from the FastAPI lifespan** in `app/main.py`, so
   `create_all` and Alembic don't both own the schema.

7. **Only now set `migrate:`.** Put `alembic upgrade head` in
   `.devops/components.yaml` **and** in the `migrate` initContainer in
   `.devops/chart/base/deployments.yaml` — the chart is static rendered YAML, so the
   second one is what actually runs. See `.devops/README.md`.

> The platform pod runs read-only-root + non-root; Alembic needs no writable filesystem
> (it talks to the database), so it works unchanged under those constraints.
