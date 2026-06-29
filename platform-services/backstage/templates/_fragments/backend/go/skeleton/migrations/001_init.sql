-- 001_init.sql — sample schema for the `items` table used by the starter CRUD routes.
--
-- The backend ALSO creates this table idempotently on startup (db.go -> ensureSchema) so
-- a fresh app works out of the box. For real, versioned schema changes prefer a migration
-- tool and drop the startup bootstrap — see README.md in this directory.

CREATE TABLE IF NOT EXISTS items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(1024)
);
