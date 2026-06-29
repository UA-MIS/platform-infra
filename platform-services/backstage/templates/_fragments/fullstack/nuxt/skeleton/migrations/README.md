# Database migrations

The app connects to MySQL using the `DATABASE_URL` connection string (a standard
`mysql://user:pass@host:3306/dbname` URI). **You never put credentials in git** — set
`DATABASE_URL` via the **Secrets** tab on your component in The Process; the platform
materializes it into your app's secret (External Secrets Operator + Vault), and the chart
injects it as an env var into the container.

## Starter behavior (zero-config)

For convenience the app creates the sample `items` table idempotently at startup
(`server/utils/db.ts` -> `ensureSchema()`, run by `server/plugins/schema.ts`), so the page
and API work as soon as `DATABASE_URL` points at a reachable database. `0001_init.sql` is
the same DDL, written out so you can apply it by hand:

```bash
mysql "$DATABASE_URL" < migrations/0001_init.sql
```

## Moving to real migrations (Drizzle Kit)

The data layer uses **Drizzle ORM** (`server/database/schema.ts`). For real projects manage
schema changes with versioned migrations instead of the startup bootstrap:

```bash
npm run db:generate   # diff schema.ts -> a new SQL migration in this dir
npm run db:migrate    # apply pending migrations (reads DATABASE_URL)
```

When you adopt this, remove the `ensureSchema()` call from `server/plugins/schema.ts` and
manage all schema changes through the generated files (run `db:migrate` as a deploy step /
job, not on every pod start). Prefer Prisma or Knex instead? Either works the same way —
swap the data layer in `server/utils/db.ts` and keep reading `DATABASE_URL`.
