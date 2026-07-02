-- 0001_init.sql — sample schema for the `items` table used by the starter page + API.
--
-- The app ALSO creates this table idempotently at startup (server/utils/db.ts ->
-- ensureSchema, run by server/plugins/schema.ts) so a fresh app works out of the box.
-- For real, versioned schema changes prefer drizzle-kit and drop the startup bootstrap —
-- see README.md in this directory.

CREATE TABLE IF NOT EXISTS items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
