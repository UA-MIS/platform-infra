# Database migrations

The backend connects to MySQL using the `DATABASE_URL` connection string (a standard
`mysql://user:pass@host:3306/dbname` URI). **You never put credentials in git** — set
`DATABASE_URL` via the **Secrets** tab on your component in The Process; the platform
materializes it into your app's secret (External Secrets Operator + Vault), and the chart
injects it as an env var into the backend container.

## Starter behavior (zero-config)

For convenience the backend creates the sample `items` table idempotently on startup
(`src/db.ts` → `ensureSchema()`), so the CRUD routes work as soon as `DATABASE_URL` points
at a reachable database. `001_init.sql` is the same DDL, written out so you can apply it by
hand:

```bash
mysql "$DATABASE_URL" < migrations/001_init.sql
```

## Moving to real migrations

The startup bootstrap is fine for the starter, but for a real project use a migration tool
so schema changes are versioned, ordered, and reversible. Good options for Node + MySQL:

- **node-pg-migrate / db-migrate** — plain SQL up/down files.
- **Prisma Migrate** — if you adopt Prisma as your ORM/query layer.
- **Knex migrations** — if you use Knex as a query builder.

When you adopt one, remove the `ensureSchema()` call from `src/index.ts` and manage all
schema changes through numbered files in this directory (run them as a deploy step / job,
not on every pod start).
