// server.js — bare Node.js HTTP server (no web framework), using only the built-in `http`
// module + mysql2. A small hand-rolled router serves:
//
//   GET    /healthz        -> 200 "ok"  (DB-INDEPENDENT — the chart probes hit this)
//   GET    /api/health     -> {status, db}  (DB-aware)
//   GET    /api/items      -> {items:[...]}
//   GET    /api/items/:id  -> {id,name} | 404
//   POST   /api/items      -> 201 {id,name}
//   PUT    /api/items/:id  -> {id,name} | 404
//   DELETE /api/items/:id  -> 204 | 404
//
// Every data route degrades to a clean 503 when DATABASE_URL is unset (see requireDb).
// This is YOUR app code — grow it freely (or switch to a framework via the other fragments).
'use strict'

const http = require('http')
const { getPool, isConfigured, ensureSchema } = require('./db')

const PORT = Number(process.env.PORT) || 8080

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

// Return the pool, or send a 503 (and return null) when DATABASE_URL is not set yet.
function requireDb(res) {
  const pool = getPool()
  if (!pool) {
    sendJson(res, 503, {
      error:
        'DATABASE_URL is not set. Add it via The Process "Secrets" tab (key: DATABASE_URL).',
    })
    return null
  }
  return pool
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) req.destroy() // basic guard against oversized bodies
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null) // signal a malformed body to the caller
      }
    })
  })
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const method = req.method

  // Liveness/readiness probe — kept INDEPENDENT of the database so the pod stays Ready
  // even when DATABASE_URL is unset/unreachable.
  if (method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }

  // DB-aware health — reports whether the DB is configured and reachable (a cheap SELECT 1).
  if (method === 'GET' && path === '/api/health') {
    let db = 'unconfigured'
    if (isConfigured()) {
      try {
        await getPool().query('SELECT 1')
        db = 'up'
      } catch {
        db = 'down'
      }
    }
    sendJson(res, 200, { status: 'ok', db, time: new Date().toISOString() })
    return
  }

  // ---- sample CRUD: /api/items ----------------------------------------------
  const itemsMatch = path.match(/^\/api\/items(?:\/([^/]+))?$/)
  if (itemsMatch) {
    const id = itemsMatch[1]

    if (method === 'GET' && !id) {
      const pool = requireDb(res)
      if (!pool) return
      const [rows] = await pool.query('SELECT id, name FROM items ORDER BY id')
      sendJson(res, 200, { items: rows })
      return
    }

    if (method === 'GET' && id) {
      const pool = requireDb(res)
      if (!pool) return
      const [rows] = await pool.query('SELECT id, name FROM items WHERE id = ?', [id])
      if (rows.length === 0) return sendJson(res, 404, { error: 'not found' })
      sendJson(res, 200, rows[0])
      return
    }

    if (method === 'POST' && !id) {
      const pool = requireDb(res)
      if (!pool) return
      const body = await readJsonBody(req)
      if (body === null) return sendJson(res, 400, { error: 'invalid JSON body' })
      const name = String(body.name ?? '').trim()
      if (!name) return sendJson(res, 400, { error: 'name is required' })
      const [result] = await pool.query('INSERT INTO items (name) VALUES (?)', [name])
      sendJson(res, 201, { id: result.insertId, name })
      return
    }

    if (method === 'PUT' && id) {
      const pool = requireDb(res)
      if (!pool) return
      const body = await readJsonBody(req)
      if (body === null) return sendJson(res, 400, { error: 'invalid JSON body' })
      const name = String(body.name ?? '').trim()
      if (!name) return sendJson(res, 400, { error: 'name is required' })
      const [result] = await pool.query('UPDATE items SET name = ? WHERE id = ?', [name, id])
      if (result.affectedRows === 0) return sendJson(res, 404, { error: 'not found' })
      sendJson(res, 200, { id: Number(id), name })
      return
    }

    if (method === 'DELETE' && id) {
      const pool = requireDb(res)
      if (!pool) return
      const [result] = await pool.query('DELETE FROM items WHERE id = ?', [id])
      if (result.affectedRows === 0) return sendJson(res, 404, { error: 'not found' })
      res.writeHead(204)
      res.end()
      return
    }
  }

  sendJson(res, 404, { error: 'not found' })
}

// Build the server. Errors thrown in async handlers are caught here so one bad request
// never crashes the process (and stack traces / secrets never leak to the client).
function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' })
    })
  })
}

async function start() {
  try {
    await ensureSchema()
  } catch (e) {
    // Don't crash on a transient DB hiccup at boot — the routes degrade gracefully.
    console.error('schema bootstrap skipped:', e)
  }
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log('backend listening on :' + PORT)
  })
}

// Only start the server when run directly (`node src/server.js`), so tests can import
// createServer and drive it on an ephemeral port.
if (require.main === module) {
  void start()
}

module.exports = { createServer }
