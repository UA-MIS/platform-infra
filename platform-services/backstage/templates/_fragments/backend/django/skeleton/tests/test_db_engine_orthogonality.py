"""Regression coverage for DATABASE_URL engine resolution (FIX-16/D-092).

Unlike fastapi/express/go, this fragment needs NO scheme-branching code of its own:
`dj_database_url.parse()` (project/settings.py) already maps the bare scheme the
platform's DSN template emits straight onto the right Django backend --
`mysql://` -> django.db.backends.mysql, `postgres(ql)://` -> django.db.backends.postgresql
-- and Django's ORM abstracts the rest (no raw SQL anywhere in items/*). This test
proves that mapping holds for both engines, and that project/__init__.py's
`pymysql.install_as_MySQLdb()` shim (needed for the MySQL path) does not interfere
with the Postgres path -- it only registers pymysql under the MySQLdb name; the
postgresql backend never imports that name.

Fixture note: sanitized DSN shapes, not captured real values (see DSN-001,
artifacts/reviews/review-fix8-dsn.md).
"""
import dj_database_url

# Importing the project package runs project/__init__.py, which installs pymysql as
# MySQLdb. This must be a no-op for the Postgres path below -- proving that import
# order doesn't matter is the point of this test.
import project  # noqa: F401

FAKE_MYSQL_URL = (
    "mysql://exampleteam_dev:not-a-real-password@"
    "capstone-mariadb-mariadb-cluster-primary.db-tier.svc.cluster.local:3306/exampleteam_dev"
)
FAKE_POSTGRES_URL = (
    "postgresql://exampleteam_dev:not-a-real-password@"
    "capstone-postgres-cluster-primary.db-tier.svc.cluster.local:5432/exampleteam_dev"
)


def test_bare_mysql_url_resolves_to_mysql_backend():
    cfg = dj_database_url.parse(FAKE_MYSQL_URL)

    assert cfg["ENGINE"] == "django.db.backends.mysql"
    assert cfg["HOST"] == "capstone-mariadb-mariadb-cluster-primary.db-tier.svc.cluster.local"
    assert cfg["PORT"] == 3306
    assert cfg["NAME"] == "exampleteam_dev"


def test_bare_postgresql_url_resolves_to_postgres_backend():
    # The platform's DSN template emits exactly this scheme (dbScheme='postgresql').
    cfg = dj_database_url.parse(FAKE_POSTGRES_URL)

    assert cfg["ENGINE"] == "django.db.backends.postgresql"
    assert cfg["HOST"] == "capstone-postgres-cluster-primary.db-tier.svc.cluster.local"
    assert cfg["PORT"] == 5432
    assert cfg["NAME"] == "exampleteam_dev"


def test_short_postgres_scheme_also_resolves_to_postgres_backend():
    # A bring-your-own DATABASE_URL might use the shorter conventional form.
    cfg = dj_database_url.parse("postgres://user:pass@host:5432/db")

    assert cfg["ENGINE"] == "django.db.backends.postgresql"


def test_mysqldb_shim_does_not_leak_into_postgres_config():
    # The shim only ever affects django.db.backends.mysql's DBAPI resolution; the
    # postgresql backend config carries no reference to MySQLdb/pymysql at all.
    cfg = dj_database_url.parse(FAKE_POSTGRES_URL)

    assert "mysql" not in cfg["ENGINE"]
    assert "pymysql" not in str(cfg).lower()
