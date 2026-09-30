import os
import sqlite3
import sys
from pathlib import Path

import pytest

# app.py lives one directory up from tests/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(scope="session", autouse=True)
def _required_env(tmp_path_factory):
    """Set every env var app.load_config() requires, BEFORE app.py is ever
    imported (module-level CONFIG = load_config() runs at import time)."""
    db_path = tmp_path_factory.mktemp("keyportal") / "test.db"
    os.environ.update(
        {
            "LITELLM_BASE_URL": "http://litellm.test:4000",
            "LITELLM_MASTER_KEY": "test-master-key",
            "PENDING_TEAM_ID": "pending-team-id",
            "STUDENTS_TEAM_ID": "students-team-id",
            "FACULTY_TEAM_ID": "faculty-team-id",
            "CF_ACCESS_TEAM_DOMAIN": "test-team.cloudflareaccess.com",
            "CF_ACCESS_AUD": "test-aud-tag",
            "ADMIN_CONTACT": "Test Admin (admin@ua.edu)",
            # Deliberately mixed case + stray whitespace + a duplicate --
            # exercises the case-insensitive, whitespace-stripped matching
            # require_admin() must do.
            "ADMIN_EMAILS": " admin@ua.edu , Faculty-Admin@Crimson.UA.EDU ",
            "KEYPORTAL_HOSTNAME": "local-llm-keys.uamishub.com",
            "KEYPORTAL_DB_PATH": str(db_path),
        }
    )
    yield


@pytest.fixture(scope="session")
def app_module(_required_env):
    import app as _app  # noqa: E402  (must import after env vars are set)

    return _app


@pytest.fixture(autouse=True)
def _clean_db(app_module):
    with sqlite3.connect(app_module.CONFIG.db_path) as conn:
        conn.execute("DELETE FROM keys")
        conn.execute("DELETE FROM preauthorized")
        conn.commit()
    yield


class FakeRequest:
    """Minimal stand-in for fastapi.Request -- verify_access_jwt only
    touches .headers.get(...)."""

    def __init__(self, headers=None):
        self.headers = headers or {}


@pytest.fixture
def make_request():
    return FakeRequest


class FakeResponse:
    """Minimal stand-in for httpx.Response."""

    def __init__(self, json_data, status_code=200, url=""):
        self._json = json_data
        self.status_code = status_code
        self.url = url

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError(
                f"status {self.status_code}", request=None, response=self
            )

    def json(self):
        return self._json


@pytest.fixture
def fake_response():
    return FakeResponse
