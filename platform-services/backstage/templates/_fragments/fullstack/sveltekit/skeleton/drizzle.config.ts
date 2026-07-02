import { defineConfig } from 'drizzle-kit'

// drizzle-kit config — generates/applies SQL migrations from src/lib/server/schema.ts.
//   npm run db:generate   # write a new migration into ./migrations from schema changes
//   npm run db:migrate    # apply pending migrations (reads DATABASE_URL)
export default defineConfig({
  dialect: 'mysql',
  schema: './src/lib/server/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
})
