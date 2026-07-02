# db.py — SQLAlchemy 2.x engine, session factory, declarative Base, and the
# FastAPI `get_db` dependency.
#
# DATABASE_URL (env) is the ONE knob. In the cluster it is a MySQL DSN supplied by
# the platform Secrets tab (ESO -> Vault -> a Kubernetes Secret env'd into the pod),
# e.g.:
#
#     mysql+pymysql://<user>:<password>@<host>:3306/<database>
#
# (`pymysql` is the pure-Python driver shipped in requirements.txt — no system libs
# or compiler needed, which keeps the image slim and apt-free; see app/Dockerfile.)
#
# If DATABASE_URL is UNSET (a freshly scaffolded app with no DB wired yet, or the
# unit tests) it falls back to an in-memory SQLite database so the app still boots,
# /healthz stays green, and the sample CRUD works end to end with zero setup. A
# read-only root filesystem (the platform pod securityContext) is fine because the
# fallback is in-MEMORY — nothing is written to disk.
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool

# Zero-config default = in-memory SQLite. Wire MySQL by setting DATABASE_URL via the
# Secrets tab (see README "Database wiring"). NEVER hardcode credentials here.
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+pysqlite:///:memory:")

# SQLite needs two extra kwargs to behave under FastAPI's threadpool + share a single
# in-memory database across connections. MySQL (and every other backend) wants neither,
# so apply them only for the sqlite fallback.
_is_sqlite = DATABASE_URL.startswith("sqlite")
_engine_kwargs: dict = {"pool_pre_ping": True, "future": True}
if _is_sqlite:
    _engine_kwargs["connect_args"] = {"check_same_thread": False}
    _engine_kwargs["poolclass"] = StaticPool

engine = create_engine(DATABASE_URL, **_engine_kwargs)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def get_db():
    """FastAPI dependency: yield a Session and always close it after the request."""
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables from the ORM metadata.

    Fine for the starter and for SQLite. For a real MySQL deployment, adopt Alembic
    migrations instead of create_all (see app/migrations/README.md) so schema changes
    are versioned and reviewable.
    """
    from . import models  # noqa: F401  (import registers the models on Base.metadata)

    Base.metadata.create_all(bind=engine)
