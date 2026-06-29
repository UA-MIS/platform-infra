// db.js — MySQL connection pool, built from DATABASE_URL (a standard mysql:// URI, e.g.
// `mysql://user:pass@host:3306/dbname`). The value is injected as an env var by the
// platform chart from the per-env app-secret (External Secrets Operator + Vault) — set it
// via The Process "Secrets" tab under the key DATABASE_URL. NEVER hardcode credentials.
//
// Zero-config friendly: if DATABASE_URL is unset the pool is null and the data routes
// return 503 with a clear message (see server.js), while /healthz stays green so the pod
// still becomes Ready on a fresh repo with nothing in Vault.
'use strict'

const mysql = require('mysql2/promise')

let pool = null

function isConfigured() {
  return Boolean(process.env.DATABASE_URL)
}

function getPool() {
  if (pool) return pool
  const url = process.env.DATABASE_URL
  if (!url) return null
  pool = mysql.createPool(url)
  return pool
}

// Idempotent schema bootstrap for the sample `items` table, so a fresh app works out of
// the box. For real schema changes use a migration tool and remove this — see
// migrations/README.md. No-op when DATABASE_URL is unset.
async function ensureSchema() {
  const p = getPool()
  if (!p) return
  await p.query(
    'CREATE TABLE IF NOT EXISTS items (' +
      'id INT AUTO_INCREMENT PRIMARY KEY, ' +
      'name VARCHAR(255) NOT NULL, ' +
      'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
      ')',
  )
}

module.exports = { isConfigured, getPool, ensureSchema }
