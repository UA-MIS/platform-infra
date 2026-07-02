# items.py — a sample CRUD blueprint over the `items` table, mounted under /api/items.
#
# This is the pattern to copy for your own resources: a Blueprint, the shared engine from
# app/db.py, parameterized SQL (NEVER string-format user input into SQL), and JSON in/out.
# Every handler goes through _engine_or_503(), which returns a clean 503 (NOT a 500) when
# DATABASE_URL is unset — the documented "no DB wired yet" degradation, while /healthz
# stays green.
from flask import Blueprint, jsonify, request
from sqlalchemy import text

from .db import get_engine

bp = Blueprint("items", __name__, url_prefix="/api/items")

_DB_UNSET = {
    "error": 'DATABASE_URL is not set. Add it via The Process "Secrets" tab (key: DATABASE_URL).'
}


def _engine_or_503():
    """Return (engine, None) or (None, 503 response) when DATABASE_URL is unset."""
    engine = get_engine()
    if engine is None:
        return None, (jsonify(_DB_UNSET), 503)
    return engine, None


def _require_name():
    name = str((request.get_json(silent=True) or {}).get("name", "")).strip()
    if not name:
        return None, (jsonify(error="name is required"), 400)
    return name, None


@bp.get("")
def list_items():
    engine, err = _engine_or_503()
    if err:
        return err
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT id, name FROM items ORDER BY id")).mappings().all()
    return jsonify(items=[dict(r) for r in rows])


@bp.get("/<int:item_id>")
def get_item(item_id: int):
    engine, err = _engine_or_503()
    if err:
        return err
    with engine.connect() as conn:
        row = (
            conn.execute(
                text("SELECT id, name FROM items WHERE id = :id"), {"id": item_id}
            )
            .mappings()
            .first()
        )
    if row is None:
        return jsonify(error="not found"), 404
    return jsonify(dict(row))


@bp.post("")
def create_item():
    engine, err = _engine_or_503()
    if err:
        return err
    name, name_err = _require_name()
    if name_err:
        return name_err
    with engine.begin() as conn:
        result = conn.execute(text("INSERT INTO items (name) VALUES (:name)"), {"name": name})
        new_id = result.lastrowid
    return jsonify(id=new_id, name=name), 201


@bp.put("/<int:item_id>")
def update_item(item_id: int):
    engine, err = _engine_or_503()
    if err:
        return err
    name, name_err = _require_name()
    if name_err:
        return name_err
    with engine.begin() as conn:
        result = conn.execute(
            text("UPDATE items SET name = :name WHERE id = :id"),
            {"name": name, "id": item_id},
        )
        if result.rowcount == 0:
            return jsonify(error="not found"), 404
    return jsonify(id=item_id, name=name)


@bp.delete("/<int:item_id>")
def delete_item(item_id: int):
    engine, err = _engine_or_503()
    if err:
        return err
    with engine.begin() as conn:
        result = conn.execute(text("DELETE FROM items WHERE id = :id"), {"id": item_id})
        if result.rowcount == 0:
            return jsonify(error="not found"), 404
    return "", 204
