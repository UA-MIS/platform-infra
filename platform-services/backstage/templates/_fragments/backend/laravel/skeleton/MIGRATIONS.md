# Database migrations (Laravel)

This starter ships Laravel migrations under `database/migrations/`, including
`*_create_items_table.php` for the sample `Item` model.

## Applying migrations

Migrations must be applied to the MySQL database **at deploy time** — as a one-shot Job
or an init-container — **NOT** from the running app process:

```bash
php artisan migrate --force
```

`DATABASE_URL` (a `mysql://user:pass@host:3306/db` URI) comes from the Secrets tab
(Vault/ESO); `config/database.php` reads it into the `mysql` connection. **Never hardcode
credentials.** When `DATABASE_URL` is unset the app still boots, `/healthz` stays 200, and
the `/api/items` routes return a clear 503.

## Changing the schema

After adding a migration, commit it:

```bash
php artisan make:migration add_field_to_items
```

> The platform pod runs read-only-root + non-root. `php artisan migrate` needs no writable
> filesystem (it talks to the database), so it works unchanged. The app itself writes
> nothing to disk: logs go to stderr, cache/session use the array driver, and no Blade
> views are compiled (the API returns JSON only).
