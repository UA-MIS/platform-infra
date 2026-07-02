import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { DbService } from '../db.service'

export interface Item {
  id: number
  name: string
}

// Sample data-access service over the `items` table. Copy this pattern for your own
// resources. Every method goes through requireDb(), which returns a 503 (NOT a 500) when
// DATABASE_URL is unset — the clean, documented "no DB wired yet" degradation.
@Injectable()
export class ItemsService {
  constructor(private readonly db: DbService) {}

  private requireDb(): Pool {
    const pool = this.db.getPool()
    if (!pool) {
      throw new HttpException(
        {
          error:
            'DATABASE_URL is not set. Add it via The Process "Secrets" tab (key: DATABASE_URL).',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
    return pool
  }

  async list(): Promise<Item[]> {
    const pool = this.requireDb()
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, name FROM items ORDER BY id',
    )
    return rows as Item[]
  }

  async get(id: number): Promise<Item> {
    const pool = this.requireDb()
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, name FROM items WHERE id = ?',
      [id],
    )
    if (rows.length === 0) throw new NotFoundException('not found')
    return rows[0] as Item
  }

  async create(name: string): Promise<Item> {
    const pool = this.requireDb()
    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO items (name) VALUES (?)',
      [name],
    )
    return { id: result.insertId, name }
  }

  async update(id: number, name: string): Promise<Item> {
    const pool = this.requireDb()
    const [result] = await pool.query<ResultSetHeader>(
      'UPDATE items SET name = ? WHERE id = ?',
      [name, id],
    )
    if (result.affectedRows === 0) throw new NotFoundException('not found')
    return { id, name }
  }

  async remove(id: number): Promise<void> {
    const pool = this.requireDb()
    const [result] = await pool.query<ResultSetHeader>(
      'DELETE FROM items WHERE id = ?',
      [id],
    )
    if (result.affectedRows === 0) throw new NotFoundException('not found')
  }

  // API health — reports whether the DB is configured and reachable (a cheap SELECT 1).
  // Distinct from /healthz, which must never depend on the DB.
  async apiHealth(): Promise<{ status: string; db: string; time: string }> {
    let db = 'unconfigured'
    const pool = this.db.getPool()
    if (pool) {
      try {
        await pool.query('SELECT 1')
        db = 'up'
      } catch {
        db = 'down'
      }
    }
    return { status: 'ok', db, time: new Date().toISOString() }
  }
}
