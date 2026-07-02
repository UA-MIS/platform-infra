"""Health endpoint tests — the chart probes hit /healthz, so it must be 200 and DB-free."""


def test_healthz_ok(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.get_data(as_text=True) == "ok"


def test_health_alias_ok(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok"}


def test_api_health_reports_unconfigured_without_db(client):
    # With no DATABASE_URL the DB-aware health reports "unconfigured" (still HTTP 200).
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.get_json()["db"] == "unconfigured"
