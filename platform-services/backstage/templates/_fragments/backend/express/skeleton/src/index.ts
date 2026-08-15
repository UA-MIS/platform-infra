import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import {
  isConfigured,
  ensureSchema,
  ping,
  listItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
} from './db'

const app = express()
app.use(express.json())

const PORT = Number(process.env.PORT) || 8080
const APP_NAME = '${{ values.appName }}'

// Wrap async route handlers so a rejected promise is forwarded to the error handler
// (Express 4 does not catch async errors automatically).
type AsyncHandler = (req: Request, res: Response) => Promise<unknown>
const wrap =
  (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

// Root — so a student's first visit to the app's own URL isn't a 404. API-only backend:
// no UI lives here (a fullstack layout's frontend owns "/" instead).
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: APP_NAME,
    status: 'running',
    hints: ['/healthz', '/api/health', '/api/items'],
  })
})

// Liveness/readiness probe — the chart hits /healthz on the pod DIRECTLY. Kept INDEPENDENT
// of the database so the pod stays Ready even when DATABASE_URL is unset/unreachable.
app.get('/healthz', (_req: Request, res: Response) => {
  res.type('text/plain').send('ok')
})

// API health — reports whether the DB is configured and reachable (a cheap SELECT 1).
app.get(
  '/api/health',
  wrap(async (_req, res) => {
    let db = 'unconfigured'
    if (isConfigured()) {
      try {
        await ping()
        db = 'up'
      } catch {
        db = 'down'
      }
    }
    res.json({ status: 'ok', db, time: new Date().toISOString() })
  }),
)

// Send a 503 (and return false) when DATABASE_URL is not set yet.
function requireDb(res: Response): boolean {
  if (!isConfigured()) {
    res.status(503).json({
      error:
        'DATABASE_URL is not set. Add it via The Process "Secrets" tab (key: DATABASE_URL).',
    })
    return false
  }
  return true
}

// ---- sample CRUD: /api/items ------------------------------------------------
app.get(
  '/api/items',
  wrap(async (_req, res) => {
    if (!requireDb(res)) return
    const items = await listItems()
    res.json({ items })
  }),
)

app.get(
  '/api/items/:id',
  wrap(async (req, res) => {
    if (!requireDb(res)) return
    const item = await getItem(req.params.id)
    if (!item) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json(item)
  }),
)

app.post(
  '/api/items',
  wrap(async (req, res) => {
    if (!requireDb(res)) return
    const name = String(req.body?.name ?? '').trim()
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    const item = await createItem(name)
    res.status(201).json(item)
  }),
)

app.put(
  '/api/items/:id',
  wrap(async (req, res) => {
    if (!requireDb(res)) return
    const name = String(req.body?.name ?? '').trim()
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    const updated = await updateItem(req.params.id, name)
    if (!updated) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ id: Number(req.params.id), name })
  }),
)

app.delete(
  '/api/items/:id',
  wrap(async (req, res) => {
    if (!requireDb(res)) return
    const deleted = await deleteItem(req.params.id)
    if (!deleted) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.status(204).end()
  }),
)

// Centralized error handler — log server-side, never leak stack traces/secrets to clients.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err)
  res.status(500).json({ error: 'internal server error' })
})

async function start(): Promise<void> {
  try {
    await ensureSchema()
  } catch (e) {
    // Don't crash on a transient DB hiccup at boot — the routes degrade gracefully.
    console.error('schema bootstrap skipped:', e)
  }
  app.listen(PORT, () => {
    console.log('backend listening on :' + PORT)
  })
}

void start()
