# db.py — SQLAlchemy 2.x engine, session factory, declarative Base, and the
# FastAPI `get_db` dependency.
#
# DATABASE_URL (env) is the ONE knob. In the cluster it is a bare MySQL DSN supplied
# by the platform Secrets tab (ESO -> Vault -> a Kubernetes Secret env'd into the
# pod), e.g.:
#
#     mysql://<user>:<password>@<host>:3306/<database>
#
# SQLAlchemy needs the driver-qualified form mysql+pymysql://..., so a bare mysql://
# URI (the contract's canonical form) is normalized below. A raw pass-through would
# make SQLAlchemy default to MySQLdb, which isn't installed (only pymysql is — see
# requirements.txt), raising ModuleNotFoundError at import time and crash-looping the
# pod on every boot. `pymysql` is the pure-Python driver shipped in requirements.txt —
# no system libs or compiler needed, which keeps the image slim and apt-free; see
# app/Dockerfile.
#
# If DATABASE_URL is UNSET or blank, the DATA routes degrade to 503 with a clear
# message while /healthz stays green, so the pod still becomes Ready on a fresh repo
# with nothing in Vault. This matches the fragment library's backend contract (see
# _fragments/README.md) and the reference implementation in backend/express
# (src/db.ts `isConfigured()` + src/index.ts `requireDb()`).
#
# This module used to fall back to an in-memory SQLite database when DATABASE_URL was
# unset. That read as a nicer zero-config experience and was actually the worst
# failure mode available: the app ACCEPTED writes (POST /api/items -> 201) into a
# database living inside one container's memory. At one replica in dev it looked
# perfect; at two or three replicas each pod had its own copy, so records appeared and
# vanished depending on which pod answered, and every restart wiped everything — with
# no error, no failed request and nothing in the logs. A 503 that says "no database"
# is a bad afternoon; silent per-pod data loss is a bad week.
#
# The in-memory database is still available for local test runs, but it is now an
# EXPLICIT opt-in (FASTAPI_ALLOW_MEMORY_DB=1, set by conftest.py) rather than
# something you get by forgetting to configure a database. "Unset" is the production
# failure case; it must never be the trigger for a convenience path.
import os

from fastapi import HTTPException, status
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool

# The opt-in in-memory SQLite DSN, and the env var that unlocks it.
MEMORY_DATABASE_URL = "sqlite+pysqlite:///:memory:"
MEMORY_DB_ENV_VAR = "FASTAPI_ALLOW_MEMORY_DB"

# Kept byte-identical in spirit to backend/express's 503 body so the two starters tell
# a student the same thing. (Express sends {"error": ...}; FastAPI's HTTPException
# renders {"detail": ...} — same status, same words, each framework's idiom.)
UNCONFIGURED_MESSAGE = (
    'DATABASE_URL is not set. Add it via The Process "Secrets" tab (key: DATABASE_URL).'
)


def _normalize_url(url: str) -> str:
    """Normalize the contract's canonical bare `mysql://` or `postgres(ql)://` URI to
    the driver-qualified DSN SQLAlchemy expects. A URL that already names a driver
    (mysql+pymysql://, postgresql+psycopg://, sqlite+pysqlite://, ...) is left
    untouched, as is any other scheme (e.g. a bring-your-own DSN this fragment does
    not special-case).
    """
    if url.startswith("mysql://"):
        return "mysql+pymysql://" + url[len("mysql://"):]
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


# Back-compat alias: the pre-FIX-16 name, kept so any external reference (or a
# not-yet-rebased branch) importing the MySQL-only symbol still resolves.
_normalize_mysql_url = _normalize_url


# Sentinel for "argument not supplied", so that _memory_db_allowed(None) means an
# explicitly-absent value (-> False) rather than "go read the environment". Those two
# are different questions and `None` cannot answer both.
_READ_ENV = object()


def _memory_db_allowed(raw: str | None | object = _READ_ENV) -> bool:
    """Whether the opt-in in-memory SQLite database is enabled.

    Deliberately an ALLOW-LIST of truthy spellings: anything else — including the
    empty string an unset-but-declared env var produces — means "no". A typo must
    fail closed to the 503, never open into a silent in-memory database.
    """
    value = os.getenv(MEMORY_DB_ENV_VAR) if raw is _READ_ENV else raw
    if not isinstance(value, str):
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _resolve_database_url(raw: str | None, *, allow_memory: bool | None = None) -> str | None:
    """Resolve the effective DATABASE_URL, or None when no database is configured.

    UNSET *and* blank/whitespace both mean "no database". `os.getenv("DATABASE_URL",
    <default>)` alone only substitutes when the var is unset — a transiently EMPTY
    value (the env-injection race FIX-9 exists to close: a container starting a beat
    before ESO materializes the secret) would pass straight through, normalize to "",
    and blow up create_engine() at import with the identical CrashLoopBackOff this
    module exists to prevent, reached by a different door. Blank must degrade exactly
    like unset — and "degrade" now means 503, not a silent in-memory database.

    Returns the opt-in in-memory SQLite DSN instead of None only when
    FASTAPI_ALLOW_MEMORY_DB is set (conftest.py does this for the test suite).
    """
    if allow_memory is None:
        allow_memory = _memory_db_allowed()
    value = (raw or "").strip()
    if not value:
        return MEMORY_DATABASE_URL if allow_memory else None
    return _normalize_url(value)


# Wire a real database by setting DATABASE_URL via the Secrets tab (see README
# "Database wiring") — MySQL or PostgreSQL, both supported (FIX-16/D-092). NEVER
# hardcode credentials here. None == not configured == data routes 503.
DATABASE_URL: str | None = _resolve_database_url(os.getenv("DATABASE_URL"))


def is_configured() -> bool:
    """True when a database is wired up. Mirrors express's `isConfigured()`."""
    return DATABASE_URL is not None


def _build_engine(url: str):
    # SQLite needs two extra kwargs to behave under FastAPI's threadpool + share a
    # single in-memory database across connections. MySQL, PostgreSQL (and every other
    # backend) want neither, so apply them only for the sqlite case.
    kwargs: dict = {"pool_pre_ping": True, "future": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
        kwargs["poolclass"] = StaticPool
    return create_engine(url, **kwargs)


# Both are None when DATABASE_URL is unset: with no database there is nothing to
# connect to, and constructing an engine against "" is exactly the import-time crash
# _resolve_database_url() exists to prevent.
engine = _build_engine(DATABASE_URL) if DATABASE_URL is not None else None

SessionLocal = (
    sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    if engine is not None
    else None
)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def get_db():
    """FastAPI dependency: yield a Session and always close it after the request.

    With no database configured this raises 503 instead of yielding, so EVERY route
    that depends on it degrades consistently and no route can accidentally accept a
    write into nowhere. /healthz and /health take no `get_db` dependency, so they stay
    200 and the pod still becomes Ready — the chart's readiness, liveness AND startup
    probes all hit /healthz, and a probe that fails without a database would leave a
    student with a pod that never starts, which is worse than one that says why.
    """
    if SessionLocal is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=UNCONFIGURED_MESSAGE,
        )
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables from the ORM metadata. No-op when no database is configured.

    Fine for the starter and for SQLite. For a real MySQL deployment, adopt Alembic
    migrations instead of create_all (see app/migrations/README.md) so schema changes
    are versioned and reviewable.
    """
    if engine is None:
        return
    from . import models  # noqa: F401  (import registers the models on Base.metadata)

    Base.metadata.create_all(bind=engine)
