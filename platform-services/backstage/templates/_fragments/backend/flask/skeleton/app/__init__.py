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
#   GET /        : 200 — proves APP_SECRET was read WITHOUT echoing it.
#   GET /api/health : DB-aware — reports whether DATABASE_URL is configured/reachable.
#   /api/items   : sample CRUD (see app/items.py); returns 503 until DATABASE_URL is set.
import hashlib
import os

from flask import Flask, jsonify

from .db import db_status, ensure_schema
from .items import bp as items_bp

__version__ = "0.0.0"


def create_app() -> Flask:
    app = Flask(__name__)

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

    @app.get("/")
    def root():
        # Proves APP_SECRET was read WITHOUT leaking it: bool + length + sha256 prefix.
        secret = os.environ.get("APP_SECRET", "")
        digest = hashlib.sha256(secret.encode()).hexdigest()[:8]
        return jsonify(
            app="${{ values.appName }}",
            secret_loaded=bool(secret),
            secret_length=len(secret),
            secret_sha256_prefix=digest,
        )

    app.register_blueprint(items_bp)

    # Idempotent schema bootstrap so a fresh app works out of the box once DATABASE_URL is
    # set. No-op when unset. For real schema changes use migrations (see migrations/README).
    try:
        ensure_schema()
    except Exception as exc:  # noqa: BLE001 - boot must not crash on a transient DB hiccup
        app.logger.warning("schema bootstrap skipped: %s", exc)

    return app
