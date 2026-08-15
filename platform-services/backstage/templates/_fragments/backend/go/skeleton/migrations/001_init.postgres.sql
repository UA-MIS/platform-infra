-- 001_init.postgres.sql — Postgres equivalent of 001_init.sql, for a host-postgres or
-- bring-your-own postgres:// DATABASE_URL (FIX-16/D-092). MySQL's AUTO_INCREMENT has
-- no direct Postgres spelling; SERIAL is the idiomatic equivalent.
--
-- The backend ALSO creates this table idempotently on startup (db.go -> ensureSchema,
-- engine-branched) so a fresh app works out of the box. For real, versioned schema
-- changes prefer a migration tool and drop the startup bootstrap — see README.md in
-- this directory.

CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(1024)
);
