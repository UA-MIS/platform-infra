"""CRUD tests for the sample /api/items router + the DB-degrade (503) path."""
import pytest
from django.test import Client, override_settings

client = Client()


@pytest.mark.django_db
def test_create_and_get_item():
    created = client.post(
        "/api/items", data={"name": "widget", "description": "a thing"},
        content_type="application/json",
    )
    assert created.status_code == 201
    item = created.json()
    assert item["id"] > 0
    assert item["name"] == "widget"

    fetched = client.get(f"/api/items/{item['id']}")
    assert fetched.status_code == 200
    assert fetched.json() == item


@pytest.mark.django_db
def test_list_items():
    client.post("/api/items", data={"name": "a"}, content_type="application/json")
    client.post("/api/items", data={"name": "b"}, content_type="application/json")
    resp = client.get("/api/items")
    assert resp.status_code == 200
    assert [i["name"] for i in resp.json()] == ["a", "b"]


@pytest.mark.django_db
def test_update_item():
    item_id = client.post(
        "/api/items", data={"name": "old"}, content_type="application/json"
    ).json()["id"]
    updated = client.put(
        f"/api/items/{item_id}", data={"name": "new"}, content_type="application/json"
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "new"


@pytest.mark.django_db
def test_delete_item():
    item_id = client.post(
        "/api/items", data={"name": "doomed"}, content_type="application/json"
    ).json()["id"]
    assert client.delete(f"/api/items/{item_id}").status_code == 204
    assert client.get(f"/api/items/{item_id}").status_code == 404


@pytest.mark.django_db
def test_get_missing_item_404():
    assert client.get("/api/items/999999").status_code == 404


@pytest.mark.django_db
def test_create_item_validation_error():
    # name is required.
    assert client.post("/api/items", data={}, content_type="application/json").status_code == 400


# The "dummy" backend is exactly what settings.py selects when DATABASE_URL is unset.
_NO_DB = {"default": {"ENGINE": "django.db.backends.dummy"}}


@override_settings(DATABASES=_NO_DB)
def test_items_degrade_503_when_db_unset():
    """With no database configured (DATABASE_URL unset) the data routes return 503."""
    resp = client.get("/api/items")
    assert resp.status_code == 503
    assert "DATABASE_URL" in resp.json()["detail"]


@override_settings(DATABASES=_NO_DB)
def test_healthz_stays_green_when_db_unset():
    """/healthz must stay 200 even with no database configured."""
    assert client.get("/healthz").status_code == 200
