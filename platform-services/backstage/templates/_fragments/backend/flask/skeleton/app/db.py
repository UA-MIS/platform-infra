# db.py — SQLAlchemy 2.x engine built lazily from DATABASE_URL, with clean degradation.
#
# DATABASE_URL (env) is the ONE knob. In the cluster it is a MySQL DSN supplied by the
# platform Secrets tab (ESO -> Vault -> a Kubernetes Secret env'd into the pod), e.g.:
#
#     mysql://<user>:<password>@<host>:3306/<database>
#
# SQLAlchemy needs the driver-qualified form mysql+pymysql://..., so a bare mysql:// URI
# (the contract's canonical form) is normalized below. `pymysql` is the pure-Python driver
# shipped in requirements.txt — no system libs/compiler, keeping the image slim and apt-free.
#
# Zero-config friendly: if DATABASE_URL is UNSET the engine is None, the data routes return
# a clean 503 (see app/items.py), and /healthz stays green so the pod still becomes Ready on
# a fresh repo with nothing in Vault. NEVER hardcode credentials here.
import os

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

_engine: Engine | None = None


def is_configured() -> bool:
    return bool(os.getenv("DATABASE_URL"))


def get_engine() -> Engine | None:
    """Return a process-wide engine, or None when DATABASE_URL is unset."""
    global _engine
    if _engine is not None:
        return _engine
    url = os.getenv("DATABASE_URL")
    if not url:
        return None
    # Normalize the contract's canonical `mysql://` URI to the pymysql driver SQLAlchemy
    # expects. A URL that already names a driver (mysql+pymysql://, sqlite://, ...) is left
    # untouched.
    if url.startswith("mysql://"):
        url = "mysql+pymysql://" + url[len("mysql://") :]
    _engine = create_engine(url, pool_pre_ping=True, future=True)
    return _engine


def db_status() -> str:
    """unconfigured | up | down — for the DB-aware /api/health route."""
    engine = get_engine()
    if engine is None:
        return "unconfigured"
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return "up"
    except Exception:  # noqa: BLE001 - health probe never raises
        return "down"


def ensure_schema() -> None:
    """Idempotently create the sample `items` table. No-op when DATABASE_URL is unset.

    For real, versioned schema changes adopt a migration tool (see migrations/README.md)
    and remove this bootstrap.
    """
    engine = get_engine()
    if engine is None:
        return
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS items ("
                "id INT AUTO_INCREMENT PRIMARY KEY, "
                "name VARCHAR(255) NOT NULL, "
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
                ")"
            )
        )
