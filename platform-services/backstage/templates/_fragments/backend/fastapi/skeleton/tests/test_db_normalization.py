"""Regression coverage for DATABASE_URL driver normalization (FIX-8, go-live blocker).

The platform hands DATABASE_URL to every fragment as a bare `mysql://` URI (see
.devops/chart/overlays/*/database.externalsecret.yaml), but SQLAlchemy needs a
driver-qualified DSN and the image ships PyMySQL only (no MySQLdb/mysqlclient). A raw
pass-through to create_engine raises ModuleNotFoundError the instant app/db.py is
imported — crashing the pod on every boot before any request is served, or even any
network connection is attempted. See the dotnet-aspnet fragment's
ConnectionStringHelperTests for the sibling fix (commit 66d5660).
"""

from app.db import _normalize_mysql_url


def test_normalize_mysql_url_adds_pymysql_driver():
    result = _normalize_mysql_url(
        "mysql://molly_demo_dev:OcBvFI0gmEkd2F89ufiDakgihu1@"
        "capstone-mariadb-mariadb-cluster-primary.db-tier.svc.cluster.local:3306/molly_demo_dev"
    )

    assert result == (
        "mysql+pymysql://molly_demo_dev:OcBvFI0gmEkd2F89ufiDakgihu1@"
        "capstone-mariadb-mariadb-cluster-primary.db-tier.svc.cluster.local:3306/molly_demo_dev"
    )


def test_normalize_mysql_url_passes_through_already_qualified():
    result = _normalize_mysql_url("mysql+pymysql://user:pass@host:3306/db")

    assert result == "mysql+pymysql://user:pass@host:3306/db"


def test_normalize_mysql_url_passes_through_sqlite_fallback():
    result = _normalize_mysql_url("sqlite+pysqlite:///:memory:")

    assert result == "sqlite+pysqlite:///:memory:"


def test_normalize_mysql_url_passes_through_other_schemes_unchanged():
    result = _normalize_mysql_url("postgresql+psycopg://user:pass@host:5432/db")

    assert result == "postgresql+psycopg://user:pass@host:5432/db"
