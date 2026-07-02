# Database migrations

The backend connects to MySQL using the `DATABASE_URL` connection string (a standard
`mysql://user:pass@host:3306/dbname` URI, converted to a `jdbc:mysql://` URL at runtime in
`src/main/java/com/example/app/Db.java`). **You never put credentials in git** — set
`DATABASE_URL` via the **Secrets** tab on your component in The Process; the platform
materializes it (External Secrets Operator + Vault) and the chart injects it as an env var.

## Starter behavior (zero-config)

For convenience the backend creates the sample `items` table idempotently on startup
(`Db.ensureSchema()`), so the CRUD routes work as soon as `DATABASE_URL` points at a
reachable database. `001_init.sql` is the same DDL, written out so you can apply it by hand:

```bash
mysql -h <host> -u <user> -p <database> < migrations/001_init.sql
```

If `DATABASE_URL` is unset the app still starts, `/healthz` stays green, and the data routes
return a clear `503`.

## Moving to real migrations

For a real project use a migration tool so schema changes are versioned, ordered, and
reviewable. Good options for Spring Boot + MySQL:

- **Flyway** — add `org.flywaydb:flyway-mysql`; put versioned SQL in
  `src/main/resources/db/migration` (`V1__init.sql`). Spring Boot runs it automatically.
- **Liquibase** — add `org.liquibase:liquibase-core`; declare changesets in XML/YAML/SQL.

When you adopt one, remove the `ensureSchema()` call from `Db.init()` so the two do not
fight over the schema.
