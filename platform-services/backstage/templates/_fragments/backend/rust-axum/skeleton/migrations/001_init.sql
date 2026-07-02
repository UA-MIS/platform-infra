-- 001_init.sql — sample schema for the `items` table used by the starter CRUD routes.
--
-- The backend ALSO creates this table idempotently on startup (db.rs -> ensure_schema) so
-- a fresh app works out of the box. For real, versioned schema changes adopt sqlx
-- migrations (this file already follows the sqlx `migrations/<version>_<name>.sql`
-- naming) and drop the startup bootstrap — see README.md in this directory.

CREATE TABLE IF NOT EXISTS items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(1024)
);
