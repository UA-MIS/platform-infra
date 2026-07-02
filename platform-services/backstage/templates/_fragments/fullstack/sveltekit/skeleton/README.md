# ${{ values.appName }}

${{ values.description }}

A **SvelteKit** fullstack app — Svelte routes plus `+server.ts` endpoints in one
deployable (adapter-node), with a **Drizzle ORM + MySQL** data layer. Scaffolded by The
Process from the `fullstack/sveltekit` fragment; the `.devops/` + `.github/` golden-path
contract is added by the platform.

## Layout

| path | what |
| --- | --- |
| `src/routes/+page.svelte`, `items/+page.*` | Svelte pages (`/`, `/items`) |
| `src/routes/healthz/+server.ts` | `GET /healthz` — DB-independent health probe (200) |
| `src/routes/api/items/+server.ts` | the JSON API (`/api/items`) |
| `src/lib/server/schema.ts` | Drizzle schema (the `items` table) |
| `src/lib/server/db.ts` | lazy DB client built from `DATABASE_URL` (server-only) |
| `migrations/` | SQL + how to move to drizzle-kit migrations |

## Local development

```bash
npm install
npm run dev            # http://localhost:${{ values.port }}
```

Set a database connection (optional — the app runs without one, the data page just shows a
"set DATABASE_URL" banner):

```bash
export DATABASE_URL="mysql://user:password@127.0.0.1:3306/appdb"
npm run dev
```

## How the database is wired (zero-config)

The app reads **`DATABASE_URL`** (a `mysql://` URI) from the environment — **never** a
hardcoded credential. On the platform it is materialized into the pod by External Secrets
Operator from Vault; set it in the **Secrets** tab in The Process. When it is unset the
client stays null: `/healthz` and the UI shell stay green and `/api/items` returns a clear
`503`. See `migrations/README.md` for the schema/migration story.

## Build / run (production)

```bash
npm run build         # -> ./build (adapter-node server)
PORT=8080 node build
```

The container listens on the **`PORT`** env (default 8080), which the platform chart sets.
