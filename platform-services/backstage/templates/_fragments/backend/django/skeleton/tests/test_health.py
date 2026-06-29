"""Health + secret-proof endpoint tests (no database needed)."""
from django.test import Client

client = Client()


def test_healthz_ok():
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_health_alias_ok():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_root_secret_loaded(monkeypatch):
    monkeypatch.setenv("APP_SECRET", "hunter2")
    resp = client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["secret_loaded"] is True
    assert body["secret_length"] == len("hunter2")
    assert "hunter2" not in resp.content.decode()


def test_root_secret_missing(monkeypatch):
    monkeypatch.delenv("APP_SECRET", raising=False)
    resp = client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["secret_loaded"] is False
    assert body["secret_length"] == 0
