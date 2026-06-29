# ${{ values.appName }} — UA-MIS capstone FastAPI starter.
#
# A minimal FastAPI service (SQLAlchemy 2.x + MySQL) that proves the golden path end
# to end: PR -> preview, merge -> dev, tag -> staging, manual gate -> prod, reading a
# secret (materialized by ESO from Vault) along the way. Edit this freely — it is YOUR
# app code. (Do not edit .devops/.)
#
#   GET /healthz : 200 {"status":"ok"} — liveness/readiness; the platform chart's
#                  probes hit THIS path, so keep it cheap and dependency-free.
#   GET /health  : alias of /healthz (convenience).
#   GET /        : 200 — proves it read APP_SECRET WITHOUT echoing the value.
#   /items       : sample CRUD over a SQLAlchemy model (see routers/items.py).
import hashlib
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db import init_db
from .routers import items


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create the sample table on startup. For real schema management use Alembic
    # migrations instead (see app/migrations/README.md).
    init_db()
    yield


app = FastAPI(
    title="${{ values.appName }}",
    description="${{ values.description }}",
    version="0.0.0",
    lifespan=lifespan,
)

app.include_router(items.router)


@app.get("/healthz", tags=["health"])
def healthz() -> dict[str, str]:
    """Liveness/readiness probe — always 200 while the process is up. Must not depend
    on app config or secret state (the platform probes call this)."""
    return {"status": "ok"}


@app.get("/health", tags=["health"])
def health() -> dict[str, str]:
    """Alias of /healthz."""
    return {"status": "ok"}


@app.get("/", tags=["root"])
def root() -> dict[str, object]:
    """Prove APP_SECRET was read WITHOUT leaking it: bool + length + sha256 prefix.

    APP_SECRET is wired by the platform from the ESO-materialized Secret
    `${{ values.appName }}-secret` (optional — a fresh app with nothing in Vault still
    boots and reports loaded=false). Set it via the Secrets tab in The Process.
    """
    secret = os.getenv("APP_SECRET", "")
    digest = hashlib.sha256(secret.encode()).hexdigest()[:8]
    return {
        "app": "${{ values.appName }}",
        "secret_loaded": bool(secret),
        "secret_length": len(secret),
        "secret_sha256_prefix": digest,
    }
