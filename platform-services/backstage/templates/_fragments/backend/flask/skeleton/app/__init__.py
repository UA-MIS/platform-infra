# ${{ values.appName }} — Flask application package.
#
# This is YOUR code (the platform owns .devops/). The package layout:
#   app/__init__.py — the application factory (create_app) + health routes
#   app/db.py       — the SQLAlchemy 2.x engine built from DATABASE_URL (+ degrade logic)
#   app/items.py    — the sample CRUD blueprint (/api/items)
#
#   GET /healthz : 200 "ok" — liveness/readiness; the platform chart's probes hit THIS
#                  path, so it is cheap and DB-independent (stays green with no DATABASE_URL).
#   GET /health  : JSON alias of /healthz (convenience).
#   GET /api/health : DB-aware — reports whether DATABASE_URL is configured/reachable.
#   /api/items   : sample CRUD (see app/items.py); returns 503 until DATABASE_URL is set.
from flask import Flask, jsonify

from .db import db_status, ensure_schema
from .items import bp as items_bp

__version__ = "0.0.0"


def create_app() -> Flask:
    app = Flask(__name__)

    @app.get("/")
    def root():
        # So a student's first visit to the app's own URL isn't a 404. API-only
        # backend: no UI lives here (a fullstack layout's frontend owns "/" instead).
        return jsonify(
            service="${{ values.appName }}",
            status="running",
            hints=["/healthz", "/api/health", "/api/items"],
        )

    @app.get("/healthz")
    def healthz():
        # Liveness/readiness probe — always 200 while the process is up, and INDEPENDENT
        # of the database (the platform probes call this). Plain text, like the contract.
        return "ok", 200, {"Content-Type": "text/plain; charset=utf-8"}

    @app.get("/health")
    def health():
        return jsonify(status="ok")

    @app.get("/api/health")
    def api_health():
        # DB-aware health — reports configured/reachable without leaking the connection.
        return jsonify(status="ok", db=db_status())

    app.register_blueprint(items_bp)

    # Idempotent schema bootstrap so a fresh app works out of the box once DATABASE_URL is
    # set. No-op when unset. For real schema changes use migrations (see migrations/README).
    try:
        ensure_schema()
    except Exception as exc:  # noqa: BLE001 - boot must not crash on a transient DB hiccup
        app.logger.warning("schema bootstrap skipped: %s", exc)

    return app
