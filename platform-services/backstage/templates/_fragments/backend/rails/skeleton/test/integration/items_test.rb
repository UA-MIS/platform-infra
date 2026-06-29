require "test_helper"

# CRUD for the sample /api/items resource (SQLite test DB) + the DB-degrade (503) path.
class ItemsTest < ActionDispatch::IntegrationTest
  test "create and get an item" do
    post "/api/items", params: { item: { name: "widget", description: "a thing" } }
    assert_response :created
    item = JSON.parse(response.body)
    assert_operator item["id"], :>, 0
    assert_equal "widget", item["name"]

    get "/api/items/#{item['id']}"
    assert_response :success
    assert_equal "widget", JSON.parse(response.body)["name"]
  end

  test "list items" do
    post "/api/items", params: { item: { name: "a" } }
    post "/api/items", params: { item: { name: "b" } }
    get "/api/items"
    assert_response :success
    names = JSON.parse(response.body).map { |i| i["name"] }
    assert_includes names, "a"
    assert_includes names, "b"
  end

  test "update an item" do
    post "/api/items", params: { item: { name: "old" } }
    id = JSON.parse(response.body)["id"]
    put "/api/items/#{id}", params: { item: { name: "new" } }
    assert_response :success
    assert_equal "new", JSON.parse(response.body)["name"]
  end

  test "delete an item" do
    post "/api/items", params: { item: { name: "doomed" } }
    id = JSON.parse(response.body)["id"]
    delete "/api/items/#{id}"
    assert_response :no_content
    get "/api/items/#{id}"
    assert_response :not_found
  end

  test "missing item is 404" do
    get "/api/items/999999"
    assert_response :not_found
  end

  test "invalid item is 422" do
    post "/api/items", params: { item: { name: "" } }
    assert_response :unprocessable_entity
  end

  test "data routes degrade to 503 when the database is unavailable" do
    # Simulate an unreachable / unconfigured DB (the DATABASE_URL-unset production path).
    Item.stub(:order, ->(*) { raise ActiveRecord::ConnectionNotEstablished }) do
      get "/api/items"
      assert_response :service_unavailable
      assert_includes JSON.parse(response.body)["error"], "database unavailable"
    end
  end
end
