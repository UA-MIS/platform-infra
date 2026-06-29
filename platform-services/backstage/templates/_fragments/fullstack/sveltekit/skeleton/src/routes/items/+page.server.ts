import { desc } from 'drizzle-orm'
import type { PageServerLoad } from './$types'
import { getDb } from '$lib/server/db'
import { items, type Item } from '$lib/server/schema'

// Server-side load for /items. Degrades cleanly: when DATABASE_URL is unset/unreachable it
// returns an empty list + a flag the page uses to show a friendly banner, instead of
// throwing an error page — so the app stays usable on a fresh repo.
export const load: PageServerLoad = async (): Promise<{ items: Item[]; dbError: boolean }> => {
  const db = getDb()
  if (!db) return { items: [], dbError: true }
  try {
    const rows = await db.select().from(items).orderBy(desc(items.id))
    return { items: rows, dbError: false }
  } catch {
    return { items: [], dbError: true }
  }
}
