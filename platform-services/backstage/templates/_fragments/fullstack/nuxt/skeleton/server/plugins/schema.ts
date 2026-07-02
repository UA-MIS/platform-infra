// Nitro startup plugin — bootstrap the sample `items` table once at boot so the starter
// works out of the box. Non-fatal: a transient DB hiccup (or an unset DATABASE_URL) is
// logged and skipped, never crashing the server, so /healthz stays green.
import { ensureSchema } from '../utils/db'

export default defineNitroPlugin(async () => {
  try {
    await ensureSchema()
  } catch (e) {
    console.error('schema bootstrap skipped:', e)
  }
})
