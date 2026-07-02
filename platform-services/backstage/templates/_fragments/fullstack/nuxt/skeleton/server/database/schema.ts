// Drizzle ORM schema (MySQL). This is the typed query layer for the sample `items`
// table. Edit the models here, then generate a migration with `npm run db:generate`
// (drizzle-kit) — see ../../migrations/README.md.
import { mysqlTable, int, varchar, timestamp } from 'drizzle-orm/mysql-core'

export const items = mysqlTable('items', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
})

export type Item = typeof items.$inferSelect
