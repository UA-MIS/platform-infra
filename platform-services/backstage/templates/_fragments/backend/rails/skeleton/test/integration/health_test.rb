require "test_helper"

# Health + secret-proof endpoints (no database needed).
class HealthTest < ActionDispatch::IntegrationTest
  test "GET /healthz is 200 and DB-independent" do
    get "/healthz"
    assert_response :success
    assert_equal({ "status" => "ok" }, JSON.parse(response.body))
  end

  test "GET /health is 200" do
    get "/health"
    assert_response :success
    assert_equal({ "status" => "ok" }, JSON.parse(response.body))
  end

  test "GET / proves APP_SECRET was read without echoing it" do
    ENV["APP_SECRET"] = "hunter2"
    get "/"
    assert_response :success
    body = JSON.parse(response.body)
    assert_equal true, body["secret_loaded"]
    assert_equal "hunter2".length, body["secret_length"]
    refute_includes response.body, "hunter2"
  ensure
    ENV.delete("APP_SECRET")
  end

  test "GET / reports secret missing when APP_SECRET is unset" do
    ENV.delete("APP_SECRET")
    get "/"
    assert_response :success
    body = JSON.parse(response.body)
    assert_equal false, body["secret_loaded"]
    assert_equal 0, body["secret_length"]
  end
end
