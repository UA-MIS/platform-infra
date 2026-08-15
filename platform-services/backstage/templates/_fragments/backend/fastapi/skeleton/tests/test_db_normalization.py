"""Regression coverage for DATABASE_URL driver normalization (FIX-8, FIX-16).

The platform hands DATABASE_URL to every fragment as a bare `mysql://` or
`postgresql://` URI (see .devops/chart/overlays/*/database.externalsecret.yaml), but
SQLAlchemy needs a driver-qualified DSN and the image ships PyMySQL + psycopg only (no
MySQLdb/mysqlclient/psycopg2). A raw pass-through to create_engine raises
ModuleNotFoundError the instant app/db.py is imported — crashing the pod on every boot
before any request is served, or even any network connection is attempted. See the
dotnet-aspnet fragment's ConnectionStringHelperTests for the sibling MySQL fix
(commit 66d5660).

FIX-16/D-092 adds the postgres branch: the platform never rewrites the DSN scheme
(D-070, fragment-side only), so this fragment must recognize BOTH the bare
`postgresql://` the platform's DSN template emits AND the `postgres://` short form a
bring-your-own DATABASE_URL might use.

Fixture note: the DSNs below are SANITIZED shapes, not captured real values — same
host/scheme structure a real tenant secret has, fake user/password. Do not replace
them with a real credential (see DSN-001, artifacts/reviews/review-fix8-dsn.md).
"""

from app.db import _normalize_mysql_url, _normalize_url, _resolve_database_url

FAKE_MYSQL_URL = (
    "mysql://exampleteam_dev:not-a-real-password@"
    "capstone-mariadb-mariadb-cluster-primary.db-tier.svc.cluster.local:3306/exampleteam_dev"
)
FAKE_MYSQL_PYMYSQL_URL = (
    "mysql+pymysql://exampleteam_dev:not-a-real-password@"
    "capstone-mariadb-mariadb-cluster-primary.db-tier.svc.cluster.local:3306/exampleteam_dev"
)
FAKE_POSTGRES_URL = (
    "postgresql://exampleteam_dev:not-a-real-password@"
    "capstone-postgres-cluster-primary.db-tier.svc.cluster.local:5432/exampleteam_dev"
)
FAKE_POSTGRES_PSYCOPG_URL = (
    "postgresql+psycopg://exampleteam_dev:not-a-real-password@"
    "capstone-postgres-cluster-primary.db-tier.svc.cluster.local:5432/exampleteam_dev"
)


def test_normalize_url_adds_pymysql_driver():
    result = _normalize_url(FAKE_MYSQL_URL)

    assert result == FAKE_MYSQL_PYMYSQL_URL


def test_normalize_url_adds_psycopg_driver_for_bare_postgresql_scheme():
    # The platform's DSN template emits this exact bare form (dbScheme='postgresql').
    result = _normalize_url(FAKE_POSTGRES_URL)

    assert result == FAKE_POSTGRES_PSYCOPG_URL


def test_normalize_url_adds_psycopg_driver_for_short_postgres_scheme():
    # A bring-your-own DATABASE_URL, or any DSN using the shorter conventional form.
    result = _normalize_url("postgres://user:pass@host:5432/db")

    assert result == "postgresql+psycopg://user:pass@host:5432/db"


def test_normalize_url_passes_through_already_qualified_mysql():
    result = _normalize_url("mysql+pymysql://user:pass@host:3306/db")

    assert result == "mysql+pymysql://user:pass@host:3306/db"


def test_normalize_url_passes_through_already_qualified_postgres():
    result = _normalize_url("postgresql+psycopg://user:pass@host:5432/db")

    assert result == "postgresql+psycopg://user:pass@host:5432/db"


def test_normalize_url_passes_through_sqlite_fallback():
    result = _normalize_url("sqlite+pysqlite:///:memory:")

    assert result == "sqlite+pysqlite:///:memory:"


def test_normalize_url_passes_through_other_schemes_unchanged():
    result = _normalize_url("mysql2://user:pass@host:3306/db")

    assert result == "mysql2://user:pass@host:3306/db"


def test_normalize_mysql_url_alias_still_works():
    # Back-compat: the pre-FIX-16 symbol name is kept as an alias.
    result = _normalize_mysql_url(FAKE_MYSQL_URL)

    assert result == FAKE_MYSQL_PYMYSQL_URL


def test_resolve_database_url_normalizes_bare_mysql():
    result = _resolve_database_url(FAKE_MYSQL_URL)

    assert result == FAKE_MYSQL_PYMYSQL_URL


def test_resolve_database_url_normalizes_bare_postgres():
    result = _resolve_database_url(FAKE_POSTGRES_URL)

    assert result == FAKE_POSTGRES_PSYCOPG_URL


def test_resolve_database_url_falls_back_to_sqlite_when_unset():
    result = _resolve_database_url(None)

    assert result == "sqlite+pysqlite:///:memory:"


def test_resolve_database_url_falls_back_to_sqlite_when_empty():
    # DSN-002: a transiently EMPTY (not unset) value must degrade exactly like
    # unset, not reach create_engine() with "" and crash at import — this is the
    # env-injection race FIX-9 exists to close, reached by a different door.
    result = _resolve_database_url("")

    assert result == "sqlite+pysqlite:///:memory:"


def test_resolve_database_url_falls_back_to_sqlite_when_whitespace():
    result = _resolve_database_url("   ")

    assert result == "sqlite+pysqlite:///:memory:"
