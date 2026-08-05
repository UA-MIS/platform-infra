// ${{ values.appName }} — UA-MIS capstone Rust (Axum + sqlx) API starter.
//
// Proves the golden path end to end: PR -> preview, merge -> dev, tag -> staging,
// manual gate -> prod. Ships:
//
//   GET /healthz     : 200 "ok" — liveness/readiness probe (the .devops chart probes THIS
//                      path; DB-independent so the pod is Ready even with no DB).
//   GET /api/health  : 200 JSON — app name + whether the DB is configured/reachable.
//   /api/items       : a sample sqlx CRUD over MySQL.
//
// Edit this freely — it is YOUR app code. (Do not edit .devops/.)
//
// The MySQL pool is built from the DATABASE_URL env (see db.rs). A freshly scaffolded app
// has no DATABASE_URL and still starts cleanly: /healthz stays green and the data routes
// return a clear 503. NEVER hardcode credentials.

mod db;
mod items;

use axum::{extract::State, routing::get, Json, Router};
use sqlx::MySqlPool;
use std::env;

/// The scaffolded project name, surfaced in /api/health.
pub const APP_NAME: &str = "${{ values.appName }}";

/// Shared application state. `pool` is None when DATABASE_URL is unset.
#[derive(Clone)]
pub struct AppState {
    pub pool: Option<MySqlPool>,
}

#[tokio::main]
async fn main() {
    let pool = db::connect();
    if let Some(p) = &pool {
        // Best-effort schema bootstrap; never fail boot if the DB is unreachable.
        if let Err(e) = db::ensure_schema(p).await {
            eprintln!("schema bootstrap skipped: {e}");
        }
    }

    let app = build_router(AppState { pool });

    let port = env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind listener");
    println!("{APP_NAME} listening on {addr}");
    axum::serve(listener, app).await.expect("serve");
}

/// Wire every route. Kept separate from `main` so tests can build the router with a
/// None (or fake) pool.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/healthz", get(healthz))
        .route("/api/health", get(api_health))
        .merge(items::routes())
        .with_state(state)
}

/// Root — so a student's first visit to the app's own URL isn't a 404. API-only backend:
/// no UI lives here (a fullstack layout's frontend owns "/" instead).
async fn root() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "service": APP_NAME,
        "status": "running",
        "hints": ["/healthz", "/api/health", "/api/items"],
    }))
}

/// Liveness/readiness probe — DB-INDEPENDENT (the chart hits this directly).
async fn healthz() -> &'static str {
    "ok"
}

/// App-level health — reports whether the DB is configured and reachable.
async fn api_health(State(st): State<AppState>) -> Json<serde_json::Value> {
    let db = match &st.pool {
        None => "unconfigured",
        Some(pool) => {
            if sqlx::query("SELECT 1").execute(pool).await.is_ok() {
                "up"
            } else {
                "down"
            }
        }
    };
    Json(serde_json::json!({ "status": "ok", "app": APP_NAME, "db": db }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt; // for `oneshot`

    fn router_no_db() -> Router {
        build_router(AppState { pool: None })
    }

    #[tokio::test]
    async fn root_is_ok() {
        let resp = router_no_db()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn healthz_is_ok_and_db_independent() {
        let resp = router_no_db()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"ok");
    }

    #[tokio::test]
    async fn items_return_503_when_database_url_unset() {
        let resp = router_no_db()
            .oneshot(Request::get("/api/items").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn api_health_reports_unconfigured_without_db() {
        let resp = router_no_db()
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["db"], "unconfigured");
    }
}
