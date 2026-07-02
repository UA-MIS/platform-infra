import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import type { Pool } from 'mysql2/promise'
import { getPool, isConfigured, ensureSchema } from './db'

const app = express()
app.use(express.json())

const PORT = Number(process.env.PORT) || 8080

// Wrap async route handlers so a rejected promise is forwarded to the error handler
// (Express 4 does not catch async errors automatically).
type AsyncHandler = (req: Request, res: Response) => Promise<unknown>
const wrap =
  (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next)

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
        await getPool()!.query('SELECT 1')
        db = 'up'
      } catch {
        db = 'down'
      }
    }
    res.json({ status: 'ok', db, time: new Date().toISOString() })
  }),
)

// Return the pool, or send a 503 (and return undefined) when DATABASE_URL is not set yet.
function requireDb(res: Response): Pool | undefined {
  const pool = getPool()
  if (!pool) {
    res.status(503).json({
      error:
        'DATABASE_URL is not set. Add it via The Process "Secrets" tab (key: DATABASE_URL).',
    })
    return undefined
  }
  return pool
}

// ---- sample CRUD: /api/items ------------------------------------------------
app.get(
  '/api/items',
  wrap(async (_req, res) => {
    const pool = requireDb(res)
    if (!pool) return
    const [rows] = await pool.query<RowDataPacket[]>('SELECT id, name FROM items ORDER BY id')
    res.json({ items: rows })
  }),
)

app.get(
  '/api/items/:id',
  wrap(async (req, res) => {
    const pool = requireDb(res)
    if (!pool) return
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, name FROM items WHERE id = ?',
      [req.params.id],
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json(rows[0])
  }),
)

app.post(
  '/api/items',
  wrap(async (req, res) => {
    const pool = requireDb(res)
    if (!pool) return
    const name = String(req.body?.name ?? '').trim()
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO items (name) VALUES (?)',
      [name],
    )
    res.status(201).json({ id: result.insertId, name })
  }),
)

app.put(
  '/api/items/:id',
  wrap(async (req, res) => {
    const pool = requireDb(res)
    if (!pool) return
    const name = String(req.body?.name ?? '').trim()
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    const [result] = await pool.query<ResultSetHeader>(
      'UPDATE items SET name = ? WHERE id = ?',
      [name, req.params.id],
    )
    if (result.affectedRows === 0) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ id: Number(req.params.id), name })
  }),
)

app.delete(
  '/api/items/:id',
  wrap(async (req, res) => {
    const pool = requireDb(res)
    if (!pool) return
    const [result] = await pool.query<ResultSetHeader>(
      'DELETE FROM items WHERE id = ?',
      [req.params.id],
    )
    if (result.affectedRows === 0) {
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
