"""Health + secret-proof endpoint tests."""


def test_healthz_ok(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_health_alias_ok(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_root_secret_loaded(client, monkeypatch):
    monkeypatch.setenv("APP_SECRET", "hunter2")
    resp = client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["secret_loaded"] is True
    assert body["secret_length"] == len("hunter2")
    # The value must NEVER be echoed back.
    assert "hunter2" not in resp.text


def test_root_secret_missing(client, monkeypatch):
    monkeypatch.delenv("APP_SECRET", raising=False)
    resp = client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["secret_loaded"] is False
    assert body["secret_length"] == 0
