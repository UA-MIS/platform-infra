"""DB-degrade tests for the sample /api/items router.

These run WITHOUT a database (the starter's zero-config state), so they assert the clean
503 degradation rather than real CRUD. Once you wire DATABASE_URL (Secrets tab) the same
routes persist to MySQL — add CRUD tests against a test database at that point.
"""


def test_list_items_degrades_to_503(client):
    resp = client.get("/api/items")
    assert resp.status_code == 503
    assert "DATABASE_URL" in resp.get_json()["error"]


def test_get_item_degrades_to_503(client):
    resp = client.get("/api/items/1")
    assert resp.status_code == 503


def test_create_item_degrades_to_503(client):
    resp = client.post("/api/items", json={"name": "widget"})
    assert resp.status_code == 503


def test_update_item_degrades_to_503(client):
    resp = client.put("/api/items/1", json={"name": "new"})
    assert resp.status_code == 503


def test_delete_item_degrades_to_503(client):
    resp = client.delete("/api/items/1")
    assert resp.status_code == 503
