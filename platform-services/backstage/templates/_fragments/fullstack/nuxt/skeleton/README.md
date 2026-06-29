# ${{ values.appName }}

${{ values.description }}

A **Nuxt 3** fullstack app — Vue pages plus a Nitro server API in one deployable, with a
**Drizzle ORM + MySQL** data layer. Scaffolded by The Process from the `fullstack/nuxt`
fragment; the `.devops/` + `.github/` golden-path contract is added by the platform.

## Layout

| path | what |
| --- | --- |
| `pages/` | Vue pages (`/`, `/items`) |
| `server/routes/healthz.get.ts` | `GET /healthz` — DB-independent health probe (200) |
| `server/api/items.{get,post}.ts` | the JSON API (`/api/items`) |
| `server/database/schema.ts` | Drizzle schema (the `items` table) |
| `server/utils/db.ts` | lazy DB client built from `DATABASE_URL` |
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
npm run build         # -> .output (self-contained Nitro node-server)
PORT=8080 npm run preview
```

The container listens on the **`PORT`** env (default 8080), which the platform chart sets.
