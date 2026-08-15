import mysql from 'mysql2/promise'
import type { Pool as MysqlPool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { Pool as PgPool } from 'pg'

// DATABASE_URL (a standard mysql:// or postgres(ql):// URI, e.g.
// `mysql://user:pass@host:3306/dbname` or `postgresql://user:pass@host:5432/dbname`) is
// injected as an env var by the platform chart from the per-env app-secret (External
// Secrets Operator + Vault) — set it via The Process "Secrets" tab under the key
// DATABASE_URL. NEVER hardcode credentials.
//
// FIX-16/D-092: the platform never rewrites this scheme (D-070) — it emits whichever
// engine the wizard's database choice resolved to. This module is the ONE place that
// branches on it: mysql2 for mysql://, pg for postgres(ql)://. Everything downstream
// (index.ts) goes through the semantic Item CRUD functions below, so route code stays
// engine-agnostic — the two drivers have incompatible placeholder syntax (`?` vs
// `$1`), result shapes ([rows] vs {rows}), and insert-id retrieval (LAST_INSERT_ID()
// vs RETURNING), so hiding that here is the point.
//
// Zero-config friendly (mirrors the platform's optional-secret pattern): if
// DATABASE_URL is unset the data routes return 503 with a clear message, while
// /healthz stays green so the pod still becomes Ready on a fresh repo with nothing in
// Vault.

export type Engine = 'mysql' | 'postgres'

export interface Item {
  id: number
  name: string
}

let mysqlPool: MysqlPool | null = null
let pgPool: PgPool | null = null

function detectEngine(url: string): Engine {
  // The platform's DSN template emits the bare `postgresql://` form; a bring-your-own
  // DATABASE_URL might use the shorter conventional `postgres://` — accept both.
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgres'
  return 'mysql'
}

export function isConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL)
}

export function getEngine(): Engine | null {
  const url = process.env.DATABASE_URL
  if (!url) return null
  return detectEngine(url)
}

function mysqlPoolFor(url: string): MysqlPool {
  if (!mysqlPool) mysqlPool = mysql.createPool(url)
  return mysqlPool
}

function pgPoolFor(url: string): PgPool {
  if (!pgPool) pgPool = new PgPool({ connectionString: url })
  return pgPool
}

/** Returns null when DATABASE_URL is unset — callers 503 in that case. */
function currentUrl(): string | null {
  return process.env.DATABASE_URL || null
}

// Idempotent schema bootstrap for the sample `items` table, so a fresh app works out
// of the box. For real schema changes use a migration tool and remove this — see
// migrations/README.md. No-op when DATABASE_URL is unset. Engine-specific DDL:
// MySQL's AUTO_INCREMENT vs Postgres's SERIAL have no shared spelling.
export async function ensureSchema(): Promise<void> {
  const url = currentUrl()
  if (!url) return
  if (detectEngine(url) === 'mysql') {
    await mysqlPoolFor(url).query(
      'CREATE TABLE IF NOT EXISTS items (' +
        'id INT AUTO_INCREMENT PRIMARY KEY, ' +
        'name VARCHAR(255) NOT NULL, ' +
        'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
        ')',
    )
  } else {
    await pgPoolFor(url).query(
      'CREATE TABLE IF NOT EXISTS items (' +
        'id SERIAL PRIMARY KEY, ' +
        'name VARCHAR(255) NOT NULL, ' +
        'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
        ')',
    )
  }
}

/** Cheap liveness probe for /api/health. Throws if the DB is unreachable. */
export async function ping(): Promise<void> {
  const url = currentUrl()
  if (!url) throw new Error('DATABASE_URL not set')
  if (detectEngine(url) === 'mysql') {
    await mysqlPoolFor(url).query('SELECT 1')
  } else {
    await pgPoolFor(url).query('SELECT 1')
  }
}

export async function listItems(): Promise<Item[]> {
  const url = currentUrl()
  if (!url) throw new Error('DATABASE_URL not set')
  if (detectEngine(url) === 'mysql') {
    const [rows] = await mysqlPoolFor(url).query<RowDataPacket[]>(
      'SELECT id, name FROM items ORDER BY id',
    )
    return rows as Item[]
  }
  const { rows } = await pgPoolFor(url).query<Item>('SELECT id, name FROM items ORDER BY id')
  return rows
}

export async function getItem(id: string): Promise<Item | null> {
  const url = currentUrl()
  if (!url) throw new Error('DATABASE_URL not set')
  if (detectEngine(url) === 'mysql') {
    const [rows] = await mysqlPoolFor(url).query<RowDataPacket[]>(
      'SELECT id, name FROM items WHERE id = ?',
      [id],
    )
    return (rows[0] as Item) ?? null
  }
  const { rows } = await pgPoolFor(url).query<Item>('SELECT id, name FROM items WHERE id = $1', [id])
  return rows[0] ?? null
}

export async function createItem(name: string): Promise<Item> {
  const url = currentUrl()
  if (!url) throw new Error('DATABASE_URL not set')
  if (detectEngine(url) === 'mysql') {
    const [result] = await mysqlPoolFor(url).query<ResultSetHeader>(
      'INSERT INTO items (name) VALUES (?)',
      [name],
    )
    return { id: result.insertId, name }
  }
  // Postgres's wire protocol has no LAST_INSERT_ID() equivalent — RETURNING is the
  // idiomatic (and only reliable) way to get the generated id back in one round trip.
  const { rows } = await pgPoolFor(url).query<Item>(
    'INSERT INTO items (name) VALUES ($1) RETURNING id, name',
    [name],
  )
  return rows[0]
}

/** Returns true if a row was updated, false if `id` didn't match any row. */
export async function updateItem(id: string, name: string): Promise<boolean> {
  const url = currentUrl()
  if (!url) throw new Error('DATABASE_URL not set')
  if (detectEngine(url) === 'mysql') {
    const [result] = await mysqlPoolFor(url).query<ResultSetHeader>(
      'UPDATE items SET name = ? WHERE id = ?',
      [name, id],
    )
    return result.affectedRows > 0
  }
  const result = await pgPoolFor(url).query('UPDATE items SET name = $1 WHERE id = $2', [name, id])
  return (result.rowCount ?? 0) > 0
}

/** Returns true if a row was deleted, false if `id` didn't match any row. */
export async function deleteItem(id: string): Promise<boolean> {
  const url = currentUrl()
  if (!url) throw new Error('DATABASE_URL not set')
  if (detectEngine(url) === 'mysql') {
    const [result] = await mysqlPoolFor(url).query<ResultSetHeader>(
      'DELETE FROM items WHERE id = ?',
      [id],
    )
    return result.affectedRows > 0
  }
  const result = await pgPoolFor(url).query('DELETE FROM items WHERE id = $1', [id])
  return (result.rowCount ?? 0) > 0
}
