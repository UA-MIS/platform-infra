# Database migrations

The backend connects to MySQL using the `DATABASE_URL` connection string (a standard
`mysql://user:pass@host:3306/dbname` URI, converted to the go-sql-driver DSN at runtime in
`db.go`). **You never put credentials in git** — set `DATABASE_URL` via the **Secrets** tab
on your component in The Process; the platform materializes it (External Secrets Operator +
Vault) and the chart injects it as an env var.

## Starter behavior (zero-config)

For convenience the backend creates the sample `items` table idempotently on startup
(`db.go` → `ensureSchema()`), so the CRUD routes work as soon as `DATABASE_URL` points at a
reachable database. `001_init.sql` is the same DDL, written out so you can apply it by hand:

```bash
mysql -h <host> -u <user> -p <database> < migrations/001_init.sql
```

If `DATABASE_URL` is unset the app still starts, `/healthz` stays green, and the data routes
return a clear `503`.

## Moving to real migrations

For a real project use a migration tool so schema changes are versioned, ordered, and
reversible. Good options for Go + MySQL:

- **golang-migrate/migrate** — plain SQL `*.up.sql` / `*.down.sql` files; run as a deploy
  step or one-shot job, not on every pod start.
- **pressly/goose** — SQL or Go migrations with embedded versioning.

When you adopt one, remove the `ensureSchema()` call from `OpenDB()` in `db.go` so the two
do not fight over the schema.
