// GET /api/items — list the sample items, newest first. Returns a clear 503 (never a
// 500) when DATABASE_URL is unset or the database is unreachable, so a fresh scaffold
// degrades cleanly.
import { desc } from 'drizzle-orm'
import { getDb } from '../utils/db'
import { items } from '../database/schema'

export default defineEventHandler(async () => {
  const db = getDb()
  if (!db) {
    throw createError({
      statusCode: 503,
      statusMessage:
        'DATABASE_URL is not set. Add it via The Process "Secrets" tab (key: DATABASE_URL).',
    })
  }
  try {
    const rows = await db.select().from(items).orderBy(desc(items.id))
    return { items: rows }
  } catch {
    throw createError({
      statusCode: 503,
      statusMessage: 'database not reachable — is DATABASE_URL set and migrated?',
    })
  }
})
