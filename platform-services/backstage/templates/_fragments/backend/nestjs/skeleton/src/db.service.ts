import { Injectable, OnModuleInit } from '@nestjs/common'
import mysql from 'mysql2/promise'
import type { Pool } from 'mysql2/promise'

// MySQL connection pool, built from DATABASE_URL (a standard mysql:// URI, e.g.
// `mysql://user:pass@host:3306/dbname`). The value is injected as an env var by the
// platform chart from the per-env app-secret (External Secrets Operator + Vault) — set it
// via The Process "Secrets" tab under the key DATABASE_URL. NEVER hardcode credentials.
//
// Zero-config friendly: if DATABASE_URL is unset the pool is null and the data routes
// return 503 with a clear message (see ItemsService), while /healthz stays green so the
// pod still becomes Ready on a fresh repo with nothing in Vault.
@Injectable()
export class DbService implements OnModuleInit {
  private pool: Pool | null = null

  isConfigured(): boolean {
    return Boolean(process.env.DATABASE_URL)
  }

  getPool(): Pool | null {
    if (this.pool) return this.pool
    const url = process.env.DATABASE_URL
    if (!url) return null
    this.pool = mysql.createPool(url)
    return this.pool
  }

  // Idempotent schema bootstrap for the sample `items` table, so a fresh app works out of
  // the box. For real schema changes use a migration tool and remove this — see
  // migrations/README.md. No-op when DATABASE_URL is unset.
  async onModuleInit(): Promise<void> {
    const p = this.getPool()
    if (!p) return
    try {
      await p.query(
        'CREATE TABLE IF NOT EXISTS items (' +
          'id INT AUTO_INCREMENT PRIMARY KEY, ' +
          'name VARCHAR(255) NOT NULL, ' +
          'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
          ')',
      )
    } catch (e) {
      // Don't crash on a transient DB hiccup at boot — the routes degrade gracefully.
      console.error('schema bootstrap skipped:', e)
    }
  }
}
