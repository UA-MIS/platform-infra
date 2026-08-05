// Contract tests (node --test) proving the BACKEND CONTRACT without a database:
//   - GET /healthz is 200 and DB-independent (the chart probes hit this).
//   - the API is served under /api.
//   - data routes degrade to a clean 503 when DATABASE_URL is unset.
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createServer } = require('../src/server')

delete process.env.DATABASE_URL

function withServer(run) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address()
      const base = `http://127.0.0.1:${port}`
      try {
        await run(base)
        resolve()
      } catch (e) {
        reject(e)
      } finally {
        server.close()
      }
    })
  })
}

test('GET / -> 200 running', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`)
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.status, 'running')
  })
})

test('GET /healthz -> 200 ok (DB-independent)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(await res.text(), 'ok')
  })
})

test('GET /api/health -> 200 unconfigured without DATABASE_URL', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`)
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.db, 'unconfigured')
  })
})

test('GET /api/items -> 503 when DATABASE_URL is unset', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/items`)
    assert.strictEqual(res.status, 503)
    const body = await res.json()
    assert.match(body.error, /DATABASE_URL/)
  })
})

test('POST /api/items -> 503 when DATABASE_URL is unset', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'widget' }),
    })
    assert.strictEqual(res.status, 503)
  })
})

test('unknown route -> 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`)
    assert.strictEqual(res.status, 404)
  })
})
