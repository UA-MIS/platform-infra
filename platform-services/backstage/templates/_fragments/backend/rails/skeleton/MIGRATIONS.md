# Database migrations (Active Record)

This starter ships an Active Record migration (`db/migrate/*_create_items.rb`) for the
sample `Item` model.

## Applying migrations

Migrations must be applied to the MySQL database **at deploy time** — as a one-shot Job
or an init-container — **NOT** from the running app process:

```bash
bin/rails db:migrate
```

`DATABASE_URL` (a `mysql://user:pass@host:3306/db` URI) comes from the Secrets tab
(Vault/ESO); `config/database.yml` rewrites the scheme to `trilogy://`. **Never hardcode
credentials.** When `DATABASE_URL` is unset the app still boots, `/healthz` stays 200, and
the `/api/items` routes return a clear 503.

## Changing the schema

After editing a model, generate a new migration and commit it:

```bash
bin/rails generate migration AddFieldToItems field:type
```

> The platform pod runs read-only-root + non-root. `bin/rails db:migrate` needs no
> writable filesystem (it talks to the database), so it works unchanged. The app itself
> writes nothing to disk: bootsnap is disabled, the cache is in-memory, logs go to stdout,
> and Puma writes no pidfile.
