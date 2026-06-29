// db.rs — the ONE place the MySQL pool is built, from the DATABASE_URL env.
//
// DATABASE_URL is a standard mysql:// URI (e.g. mysql://user:pass@host:3306/dbname),
// supplied by the platform "Secrets" tab (External Secrets Operator + Vault -> a
// Kubernetes Secret env'd into the pod). sqlx accepts this URI form directly. NEVER
// hardcode credentials.
//
// Zero-config: if DATABASE_URL is UNSET, `connect` returns None so the data routes return
// a clear 503 — while /healthz stays green and the pod still becomes Ready on a fresh repo
// with nothing in Vault. The pool is LAZY (connect_lazy), so a configured-but-unreachable
// DB does not block startup; the first query simply fails and the route reports it.

use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use std::env;

/// Build a lazy MySQL pool from DATABASE_URL, or None when it is unset/invalid.
pub fn connect() -> Option<MySqlPool> {
    let url = env::var("DATABASE_URL").ok().filter(|s| !s.is_empty())?;
    match MySqlPoolOptions::new()
        .max_connections(5)
        .connect_lazy(&url)
    {
        Ok(pool) => Some(pool),
        Err(e) => {
            eprintln!("invalid DATABASE_URL: {e}");
            None
        }
    }
}

/// Idempotently create the sample `items` table. For real schema changes use sqlx
/// migrations and remove this — see migrations/README.md.
pub async fn ensure_schema(pool: &MySqlPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS items (\
         id BIGINT AUTO_INCREMENT PRIMARY KEY, \
         name VARCHAR(255) NOT NULL, \
         description VARCHAR(1024))",
    )
    .execute(pool)
    .await?;
    Ok(())
}
