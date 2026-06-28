# ${{ values.appName }} — FastAPI application package.
#
# This is YOUR code (the platform owns .devops/). The package layout:
#   app/main.py          — the FastAPI() app + health/secret-proof routes
#   app/db.py            — SQLAlchemy 2.x engine/session + the get_db dependency
#   app/models.py        — ORM models (the sample `Item`)
#   app/schemas.py       — Pydantic request/response models
#   app/routers/items.py — the sample CRUD router (/items)
__version__ = "0.0.0"
