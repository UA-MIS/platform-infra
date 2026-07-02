# Database migrations

The backend connects to MySQL using the `DATABASE_URL` connection string (a standard
`mysql://user:pass@host:3306/dbname` URI). **You never put credentials in git** — set
`DATABASE_URL` via the **Secrets** tab on your component in The Process; the platform
materializes it into your app's secret (External Secrets Operator + Vault), and the chart
injects it as an env var. Until it is set the data routes return a clean `503` and
`/healthz` stays green.

## Starter behavior (zero-config)

For convenience the backend creates the sample `items` table idempotently on startup
(`src/db.js` → `ensureSchema()`), so the CRUD routes work as soon as `DATABASE_URL` points
at a reachable database. `001_init.sql` is the same DDL, written out so you can apply it by
hand:

```bash
mysql "$DATABASE_URL" < migrations/001_init.sql
```

## Moving to real migrations

The startup bootstrap is fine for the starter, but for a real project use a migration tool
so schema changes are versioned, ordered, and reversible. Good options for Node + MySQL:

- **node-pg-migrate / db-migrate** — plain SQL up/down files (closest to this bare setup).
- **dbmate** — a single static binary, language-agnostic, plain SQL migrations.

When you adopt one, remove the `ensureSchema()` call from `src/server.js` and manage all
schema changes through numbered files in this directory (run them as a deploy step / job,
not on every pod start).
