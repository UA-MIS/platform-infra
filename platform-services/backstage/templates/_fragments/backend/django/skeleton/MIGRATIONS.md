# Database migrations (Django)

This starter ships Django's native migrations (`items/migrations/`). The sample `Item`
model already has its initial migration (`0001_initial.py`).

## Applying migrations

Migrations must be applied to the MySQL database **at deploy time** — as a one-shot Job
or an init-container — **NOT** from the running app process:

```bash
python manage.py migrate
```

`DATABASE_URL` (a `mysql://user:pass@host:3306/db` URI) comes from the Secrets tab
(Vault/ESO). **Never hardcode credentials.** When `DATABASE_URL` is unset the app still
boots, `/healthz` stays 200, and the `/api/items` routes return a clear 503.

## Changing the schema

After editing a model, generate a new migration and commit it:

```bash
python manage.py makemigrations
```

> The platform pod runs read-only-root + non-root. `manage.py migrate` needs no writable
> filesystem (it talks to the database), so it works unchanged under those constraints.
> The app itself writes nothing to disk (logs go to stdout; no schema is created at boot).
