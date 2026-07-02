import type { Handle } from '@sveltejs/kit'
import { ensureSchema } from '$lib/server/db'

// Bootstrap the sample `items` table once, on the first request. Non-fatal: a transient DB
// hiccup (or an unset DATABASE_URL) is logged and skipped, never blocking the request, so
// /healthz and the UI shell stay green.
let booted = false

export const handle: Handle = async ({ event, resolve }) => {
  if (!booted) {
    booted = true
    try {
      await ensureSchema()
    } catch (e) {
      console.error('schema bootstrap skipped:', e)
    }
  }
  return resolve(event)
}
