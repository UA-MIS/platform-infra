"""CRUD tests for the sample /api/items router."""


def test_create_and_get_item(client):
    created = client.post("/api/items", json={"name": "widget", "description": "a thing"})
    assert created.status_code == 201
    item = created.json()
    assert item["id"] > 0
    assert item["name"] == "widget"
    assert item["description"] == "a thing"

    fetched = client.get(f"/api/items/{item['id']}")
    assert fetched.status_code == 200
    assert fetched.json() == item


def test_list_items(client):
    client.post("/api/items", json={"name": "a"})
    client.post("/api/items", json={"name": "b"})
    resp = client.get("/api/items")
    assert resp.status_code == 200
    names = [i["name"] for i in resp.json()]
    assert names == ["a", "b"]


def test_update_item(client):
    item_id = client.post("/api/items", json={"name": "old"}).json()["id"]
    updated = client.put(f"/api/items/{item_id}", json={"name": "new"})
    assert updated.status_code == 200
    assert updated.json()["name"] == "new"


def test_delete_item(client):
    item_id = client.post("/api/items", json={"name": "doomed"}).json()["id"]
    assert client.delete(f"/api/items/{item_id}").status_code == 204
    assert client.get(f"/api/items/{item_id}").status_code == 404


def test_get_missing_item_404(client):
    assert client.get("/api/items/999999").status_code == 404


def test_create_item_validation_error(client):
    # name is required + min_length=1.
    assert client.post("/api/items", json={}).status_code == 422
    assert client.post("/api/items", json={"name": ""}).status_code == 422
