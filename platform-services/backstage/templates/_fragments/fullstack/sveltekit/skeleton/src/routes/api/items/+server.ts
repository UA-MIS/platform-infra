import { json, error } from '@sveltejs/kit'
import { desc } from 'drizzle-orm'
import type { RequestHandler } from './$types'
import { getDb } from '$lib/server/db'
import { items } from '$lib/server/schema'

const NO_DB =
  'DATABASE_URL is not set. Add it via The Process "Secrets" tab (key: DATABASE_URL).'

// GET /api/items — list the sample items, newest first. Returns a clear 503 (never a 500)
// when DATABASE_URL is unset or the database is unreachable.
export const GET: RequestHandler = async () => {
  const db = getDb()
  if (!db) throw error(503, NO_DB)
  try {
    const rows = await db.select().from(items).orderBy(desc(items.id))
    return json({ items: rows })
  } catch {
    throw error(503, 'database not reachable — is DATABASE_URL set and migrated?')
  }
}

// POST /api/items — create an item. Body: { "name": string }.
export const POST: RequestHandler = async ({ request }) => {
  const db = getDb()
  if (!db) throw error(503, NO_DB)

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    throw error(400, 'request body must be valid JSON')
  }
  const name = String((payload as { name?: unknown })?.name ?? '').trim()
  if (!name) throw error(400, 'name is required')

  try {
    const result = await db.insert(items).values({ name })
    return json({ id: result[0].insertId, name }, { status: 201 })
  } catch {
    throw error(503, 'could not save item — is DATABASE_URL set and migrated?')
  }
}
