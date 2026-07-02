# Database migrations

The backend connects to MySQL using the `DATABASE_URL` connection string (a standard
`mysql://user:pass@host:3306/dbname` URI, accepted directly by sqlx — see `src/db.rs`).
**You never put credentials in git** — set `DATABASE_URL` via the **Secrets** tab on your
component in The Process; the platform materializes it (External Secrets Operator + Vault)
and the chart injects it as an env var.

## Starter behavior (zero-config)

For convenience the backend creates the sample `items` table idempotently on startup
(`src/db.rs` → `ensure_schema()`), so the CRUD routes work as soon as `DATABASE_URL` points
at a reachable database. `001_init.sql` is the same DDL, written out so you can apply it by
hand:

```bash
mysql -h <host> -u <user> -p <database> < migrations/001_init.sql
```

If `DATABASE_URL` is unset the app still starts, `/healthz` stays green, and the data routes
return a clear `503`.

## Moving to real migrations

This file already follows the [sqlx migrations](https://docs.rs/sqlx) naming convention
(`migrations/<version>_<name>.sql`), so adopting them is easy:

```bash
cargo install sqlx-cli --no-default-features --features mysql
export DATABASE_URL="mysql://user:pass@host:3306/dbname"   # from the Secrets tab; never commit
sqlx migrate run                                            # applies everything in migrations/
```

Run migrations as a deploy step / one-shot job (not on every pod start). Once sqlx owns the
schema, remove the `ensure_schema()` call from `src/main.rs` so the two do not fight. You
can also embed and run them at startup with `sqlx::migrate!()` if you prefer.
