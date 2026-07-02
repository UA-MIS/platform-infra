// Server-only database access — Drizzle ORM over a mysql2 connection pool, built from
// DATABASE_URL (a standard mysql:// URI, e.g. `mysql://user:pass@host:3306/dbname`). Lives
// under $lib/server so it can NEVER be bundled into client code. The platform chart injects
// DATABASE_URL from the per-env app-secret (External Secrets Operator + Vault) — set it via
// The Process "Secrets" tab under the key DATABASE_URL. NEVER hardcode credentials.
//
// Zero-config friendly (mirrors how the nextjs seed wires Prisma): the client is created
// lazily and stays null when DATABASE_URL is unset, so /healthz and the page shell stay
// green on a fresh repo with nothing in Vault; the data endpoints return a clear 503.
import mysql from 'mysql2/promise'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import * as schema from './schema'

let pool: mysql.Pool | null = null
let db: MySql2Database<typeof schema> | null = null

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL)
}

export function getDb(): MySql2Database<typeof schema> | null {
  if (db) return db
  const url = process.env.DATABASE_URL
  if (!url) return null
  pool = mysql.createPool(url)
  db = drizzle(pool, { schema, mode: 'default' })
  return db
}

// Idempotent schema bootstrap for the sample `items` table, so a fresh app works out of
// the box. For real schema changes use drizzle-kit migrations and remove this — see
// migrations/README.md. No-op when DATABASE_URL is unset.
export async function ensureSchema(): Promise<void> {
  getDb()
  if (!pool) return
  await pool.query(
    'CREATE TABLE IF NOT EXISTS items (' +
      'id INT AUTO_INCREMENT PRIMARY KEY, ' +
      'name VARCHAR(255) NOT NULL, ' +
      'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
      ')',
  )
}
