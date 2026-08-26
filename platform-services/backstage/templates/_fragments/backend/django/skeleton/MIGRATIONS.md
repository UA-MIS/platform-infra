# Database migrations (Django)

This starter ships Django's native migrations (`items/migrations/`). The sample `Item`
model already has its initial migration (`0001_initial.py`).

## Applying migrations — the platform already does this for you

Migrations are applied to the MySQL database **at deploy time**, by a migration
**initContainer** the platform's chart runs before your app container starts, on **every**
deploy, in **every** environment. You do not have to run anything.

```
python manage.py migrate --noinput
```

That command comes from your `.devops/components.yaml` (`migrate:`), and it runs inside your
own image — the same build that is being deployed. Applied migrations are recorded in the
`django_migrations` table, so re-running on every deploy is a no-op.

**If a migration fails, your pod stays in `Init` and never becomes Ready.** That is
deliberate: on a rolling update the previous version keeps serving, and you get a loud,
obvious failure instead of a "Healthy" app that 500s on every data route.

The command retries 3 times (5s apart) before giving up, so a transient blip — or two
replicas racing the same migration on a brand-new environment — resolves itself. If it
still fails, the migration's own output says why: find it in **Grafana ->
[Logs](https://grafana.capstone.uamishub.com)**, filtered to your namespace
(`<team>-<env>`) and the `migrate` container. (You never need `kubectl` — that is the
platform team's maintenance path, not yours.)

Want to change what runs at deploy time (add a seed step, swap the command)? Edit `migrate:`
in `.devops/components.yaml`.

## Running migrations yourself (locally)

Against a local database, or to apply them by hand:

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
