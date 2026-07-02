// items.rs — a sample CRUD router over the `items` table (sqlx, runtime queries). This is
// the pattern to copy for your own resources. Every data route pulls the pool out of the
// shared state and returns a clear 503 when DATABASE_URL is unset, so a freshly scaffolded
// app (no DB wired yet) degrades cleanly instead of erroring.

use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::MySqlPool;

#[derive(Serialize, sqlx::FromRow)]
struct Item {
    id: i64,
    name: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct ItemInput {
    name: String,
    description: Option<String>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/items", get(list).post(create))
        .route("/api/items/:id", get(get_one).put(update).delete(delete))
}

/// 503 helper for when no database is configured.
fn no_db() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": "DATABASE_URL is not set. Add it via The Process \"Secrets\" tab (key: DATABASE_URL)."
        })),
    )
        .into_response()
}

fn db_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "database error" })),
    )
        .into_response()
}

/// Pull the pool out of state or short-circuit with a 503.
macro_rules! pool_or_503 {
    ($st:expr) => {
        match &$st.pool {
            Some(p) => p,
            None => return no_db(),
        }
    };
}

async fn list(State(st): State<AppState>) -> Response {
    let pool: &MySqlPool = pool_or_503!(st);
    match sqlx::query_as::<_, Item>("SELECT id, name, description FROM items ORDER BY id")
        .fetch_all(pool)
        .await
    {
        Ok(items) => Json(serde_json::json!({ "items": items })).into_response(),
        Err(_) => db_error(),
    }
}

async fn get_one(State(st): State<AppState>, Path(id): Path<i64>) -> Response {
    let pool: &MySqlPool = pool_or_503!(st);
    match sqlx::query_as::<_, Item>("SELECT id, name, description FROM items WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
    {
        Ok(Some(item)) => Json(item).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" }))).into_response(),
        Err(_) => db_error(),
    }
}

async fn create(State(st): State<AppState>, Json(input): Json<ItemInput>) -> Response {
    let pool: &MySqlPool = pool_or_503!(st);
    if input.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "name is required" }))).into_response();
    }
    match sqlx::query("INSERT INTO items (name, description) VALUES (?, ?)")
        .bind(&input.name)
        .bind(&input.description)
        .execute(pool)
        .await
    {
        Ok(res) => {
            let item = Item {
                id: res.last_insert_id() as i64,
                name: input.name,
                description: input.description,
            };
            (StatusCode::CREATED, Json(item)).into_response()
        }
        Err(_) => db_error(),
    }
}

async fn update(State(st): State<AppState>, Path(id): Path<i64>, Json(input): Json<ItemInput>) -> Response {
    let pool: &MySqlPool = pool_or_503!(st);
    if input.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "name is required" }))).into_response();
    }
    match sqlx::query("UPDATE items SET name = ?, description = ? WHERE id = ?")
        .bind(&input.name)
        .bind(&input.description)
        .bind(id)
        .execute(pool)
        .await
    {
        Ok(res) if res.rows_affected() == 0 => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" }))).into_response()
        }
        Ok(_) => Json(Item { id, name: input.name, description: input.description }).into_response(),
        Err(_) => db_error(),
    }
}

async fn delete(State(st): State<AppState>, Path(id): Path<i64>) -> Response {
    let pool: &MySqlPool = pool_or_503!(st);
    match sqlx::query("DELETE FROM items WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
    {
        Ok(res) if res.rows_affected() == 0 => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" }))).into_response()
        }
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => db_error(),
    }
}
