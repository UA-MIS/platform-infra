// POST /api/items — create an item. Body: { "name": string }. Returns 503 when the DB is
// not configured/reachable and 400 for invalid input.
import { getDb } from '../utils/db'
import { items } from '../database/schema'

export default defineEventHandler(async (event) => {
  const db = getDb()
  if (!db) {
    throw createError({
      statusCode: 503,
      statusMessage:
        'DATABASE_URL is not set. Add it via The Process "Secrets" tab (key: DATABASE_URL).',
    })
  }
  const body = await readBody(event)
  const name = String(body?.name ?? '').trim()
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'name is required' })
  }
  try {
    const result = await db.insert(items).values({ name })
    setResponseStatus(event, 201)
    return { id: result[0].insertId, name }
  } catch {
    throw createError({
      statusCode: 503,
      statusMessage: 'could not save item — is DATABASE_URL set and migrated?',
    })
  }
})
