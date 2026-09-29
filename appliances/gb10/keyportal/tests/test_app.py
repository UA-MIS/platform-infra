import os

import jwt as pyjwt
import pytest
from fastapi import HTTPException


# ---------------------------------------------------------------------------
# _require_env / load_config -- the "fail loudly, not silently" contract
# ---------------------------------------------------------------------------


def test_require_env_missing_raises(app_module, monkeypatch):
    monkeypatch.delenv("SOME_UNSET_VAR", raising=False)
    with pytest.raises(RuntimeError, match="SOME_UNSET_VAR is unset or blank"):
        app_module._require_env("SOME_UNSET_VAR")


def test_require_env_blank_raises(app_module, monkeypatch):
    # This is exactly the box's real state: docker-compose.yml passes
    # CF_ACCESS_AUD=${CF_ACCESS_AUD_KEYPORTAL}, which is PRESENT but empty
    # until the owner fills it in -- must fail the same as fully unset.
    monkeypatch.setenv("CF_ACCESS_AUD_BLANK_TEST", "")
    with pytest.raises(
        RuntimeError, match="CF_ACCESS_AUD_BLANK_TEST is unset or blank"
    ):
        app_module._require_env("CF_ACCESS_AUD_BLANK_TEST")


def test_require_env_whitespace_only_raises(app_module, monkeypatch):
    monkeypatch.setenv("WHITESPACE_VAR", "   ")
    with pytest.raises(RuntimeError, match="WHITESPACE_VAR is unset or blank"):
        app_module._require_env("WHITESPACE_VAR")


def test_require_env_present_returns_stripped_value(app_module, monkeypatch):
    monkeypatch.setenv("SOME_VAR", "  value  ")
    assert app_module._require_env("SOME_VAR") == "value"


def test_require_env_includes_hint_in_message(app_module, monkeypatch):
    monkeypatch.delenv("HINTED_VAR", raising=False)
    with pytest.raises(RuntimeError, match="do the thing"):
        app_module._require_env("HINTED_VAR", hint="do the thing")


def test_load_config_success_reads_all_fields(app_module):
    config = app_module.load_config()
    assert config.litellm_base_url == "http://litellm.test:4000"
    assert config.pending_team_id == "pending-team-id"
    assert config.cf_access_aud == "test-aud-tag"
    assert config.allowed_email_suffixes == ("@crimson.ua.edu", "@ua.edu")
    assert config.jwks_url == (
        "https://test-team.cloudflareaccess.com/cdn-cgi/access/certs"
    )


def test_load_config_missing_cf_access_aud_fails_loudly(app_module, monkeypatch):
    # Simulates the box's real, currently-blank CF_ACCESS_AUD_KEYPORTAL.
    monkeypatch.setenv("CF_ACCESS_AUD", "")
    with pytest.raises(RuntimeError, match="CF_ACCESS_AUD is unset or blank"):
        app_module.load_config()


# ---------------------------------------------------------------------------
# verify_access_jwt -- signature/audience verification, not header trust
# ---------------------------------------------------------------------------


def test_verify_jwt_missing_header_returns_401(app_module, make_request):
    config = app_module.load_config()
    with pytest.raises(HTTPException) as exc_info:
        app_module.verify_access_jwt(make_request(), config, jwks_client=object())
    assert exc_info.value.status_code == 401
    assert "Missing Cloudflare Access assertion" in exc_info.value.detail


def test_verify_jwt_invalid_audience_returns_401(app_module, make_request, mocker):
    config = app_module.load_config()
    fake_jwks = mocker.Mock()
    fake_jwks.get_signing_key_from_jwt.return_value = mocker.Mock(key="fake-key")
    mocker.patch(
        "app.jwt.decode",
        side_effect=pyjwt.InvalidAudienceError("audience mismatch"),
    )
    request = make_request(headers={"Cf-Access-Jwt-Assertion": "bad.jwt.token"})
    with pytest.raises(HTTPException) as exc_info:
        app_module.verify_access_jwt(request, config, fake_jwks)
    assert exc_info.value.status_code == 401
    assert "Invalid Access assertion" in exc_info.value.detail


def test_verify_jwt_bad_signature_returns_401(app_module, make_request, mocker):
    config = app_module.load_config()
    fake_jwks = mocker.Mock()
    fake_jwks.get_signing_key_from_jwt.return_value = mocker.Mock(key="fake-key")
    mocker.patch("app.jwt.decode", side_effect=pyjwt.InvalidSignatureError("bad sig"))
    request = make_request(headers={"Cf-Access-Jwt-Assertion": "bad.jwt.token"})
    with pytest.raises(HTTPException) as exc_info:
        app_module.verify_access_jwt(request, config, fake_jwks)
    assert exc_info.value.status_code == 401


def test_verify_jwt_disallowed_domain_returns_403(app_module, make_request, mocker):
    config = app_module.load_config()
    fake_jwks = mocker.Mock()
    fake_jwks.get_signing_key_from_jwt.return_value = mocker.Mock(key="fake-key")
    mocker.patch("app.jwt.decode", return_value={"email": "someone@gmail.com"})
    request = make_request(headers={"Cf-Access-Jwt-Assertion": "good.jwt.token"})
    with pytest.raises(HTTPException) as exc_info:
        app_module.verify_access_jwt(request, config, fake_jwks)
    assert exc_info.value.status_code == 403


@pytest.mark.parametrize("email", ["student@crimson.ua.edu", "faculty@ua.edu"])
def test_verify_jwt_valid_allowed_domain_returns_email(
    app_module, make_request, mocker, email
):
    config = app_module.load_config()
    fake_jwks = mocker.Mock()
    fake_jwks.get_signing_key_from_jwt.return_value = mocker.Mock(key="fake-key")
    mocker.patch("app.jwt.decode", return_value={"email": email})
    request = make_request(headers={"Cf-Access-Jwt-Assertion": "good.jwt.token"})
    assert app_module.verify_access_jwt(request, config, fake_jwks) == email


def test_verify_jwt_passes_configured_audience_to_decode(
    app_module, make_request, mocker
):
    config = app_module.load_config()
    fake_jwks = mocker.Mock()
    fake_jwks.get_signing_key_from_jwt.return_value = mocker.Mock(key="fake-key")
    decode_mock = mocker.patch(
        "app.jwt.decode", return_value={"email": "student@crimson.ua.edu"}
    )
    request = make_request(headers={"Cf-Access-Jwt-Assertion": "good.jwt.token"})
    app_module.verify_access_jwt(request, config, fake_jwks)
    assert decode_mock.call_args.kwargs["audience"] == config.cf_access_aud


# ---------------------------------------------------------------------------
# key cache / issue_key
# ---------------------------------------------------------------------------


def test_get_cached_key_returns_none_when_absent(app_module):
    assert (
        app_module.get_cached_key(app_module.CONFIG.db_path, "nobody@crimson.ua.edu")
        is None
    )


def test_issue_key_stores_in_db_and_calls_litellm_with_master_key(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    post_mock = mocker.patch(
        "app.httpx.post",
        return_value=fake_response({"key": "sk-newkey123", "token_id": "tok-1"}),
    )
    key = app_module.issue_key(config, "new@crimson.ua.edu", config.pending_team_id)
    assert key == "sk-newkey123"
    assert post_mock.call_args.args[0] == f"{config.litellm_base_url}/key/generate"
    assert (
        post_mock.call_args.kwargs["headers"]["Authorization"]
        == f"Bearer {config.litellm_master_key}"
    )
    assert post_mock.call_args.kwargs["json"]["team_id"] == config.pending_team_id
    assert (
        app_module.get_cached_key(config.db_path, "new@crimson.ua.edu")
        == "sk-newkey123"
    )


def test_issue_key_overwrites_existing_row_for_same_email(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    mocker.patch("app.httpx.post", return_value=fake_response({"key": "sk-first"}))
    app_module.issue_key(config, "dup@crimson.ua.edu", config.pending_team_id)
    mocker.patch("app.httpx.post", return_value=fake_response({"key": "sk-second"}))
    app_module.issue_key(config, "dup@crimson.ua.edu", config.pending_team_id)
    assert (
        app_module.get_cached_key(config.db_path, "dup@crimson.ua.edu") == "sk-second"
    )


# ---------------------------------------------------------------------------
# get_current_team_id / team_grants_access -- verified against real
# LiteLLM response shapes recorded live on the box, 2026-09-29:
#   GET /key/info  -> {"info": {..., "team_id": "..."}}
#   GET /team/info -> {"team_id": "...", "team_info": {..., "models": [...]}}
# ---------------------------------------------------------------------------


def test_get_current_team_id_nested_shape(app_module, mocker, fake_response):
    config = app_module.CONFIG
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response({"info": {"team_id": "students-team"}}),
    )
    assert app_module.get_current_team_id(config, "sk-x") == "students-team"


def test_get_current_team_id_flat_shape_fallback(app_module, mocker, fake_response):
    config = app_module.CONFIG
    mocker.patch(
        "app.httpx.get", return_value=fake_response({"team_id": "faculty-team"})
    )
    assert app_module.get_current_team_id(config, "sk-x") == "faculty-team"


def test_team_grants_access_false_for_pending_team_without_http_call(
    app_module, mocker
):
    config = app_module.CONFIG
    get_mock = mocker.patch("app.httpx.get")
    assert app_module.team_grants_access(config, config.pending_team_id) is False
    get_mock.assert_not_called()


def test_team_grants_access_false_for_none_team(app_module, mocker):
    config = app_module.CONFIG
    get_mock = mocker.patch("app.httpx.get")
    assert app_module.team_grants_access(config, None) is False
    get_mock.assert_not_called()


def test_team_grants_access_true_when_team_has_models_nested(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response(
            {"team_id": "students-team", "team_info": {"models": ["qwen3.8-27b"]}}
        ),
    )
    assert app_module.team_grants_access(config, "students-team") is True


def test_team_grants_access_false_when_team_has_empty_models(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response(
            {"team_id": "some-other-team", "team_info": {"models": []}}
        ),
    )
    assert app_module.team_grants_access(config, "some-other-team") is False


def test_team_grants_access_true_flat_shape_fallback(app_module, mocker, fake_response):
    config = app_module.CONFIG
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response({"models": ["qwen3.8-27b"]}),
    )
    assert app_module.team_grants_access(config, "some-team") is True


# ---------------------------------------------------------------------------
# revoke_and_reissue -- THE D11 regression test: regenerate must not
# silently un-promote an already-active user back to `pending`.
# ---------------------------------------------------------------------------


def test_regenerate_preserves_current_team_not_pending(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    email = "promoted@crimson.ua.edu"
    # Seed the cache as if this user was issued a key while pending, then
    # promoted by an admin (team_id now "students-team", key unchanged).
    with mocker_seed_cache(app_module, config, email, "sk-old-promoted-key"):
        pass

    # The old key's CURRENT team, looked up live, is "students-team" --
    # NOT the pending team.
    get_mock = mocker.patch(
        "app.httpx.get",
        return_value=fake_response({"info": {"team_id": "students-team"}}),
    )
    delete_mock = mocker.patch("app.httpx.post")

    def post_side_effect(url, **kwargs):
        if url.endswith("/key/delete"):
            return fake_response({"deleted_keys": ["sk-old-promoted-key"]})
        if url.endswith("/key/generate"):
            return fake_response({"key": "sk-new-promoted-key"})
        raise AssertionError(f"unexpected POST to {url}")

    delete_mock.side_effect = post_side_effect

    new_key = app_module.revoke_and_reissue(config, email)

    assert new_key == "sk-new-promoted-key"
    # The critical assertion: /key/generate must have been called with
    # team_id="students-team", never config.pending_team_id.
    generate_call = next(
        c for c in delete_mock.call_args_list if c.args[0].endswith("/key/generate")
    )
    assert generate_call.kwargs["json"]["team_id"] == "students-team"
    assert generate_call.kwargs["json"]["team_id"] != config.pending_team_id
    # The old key must have been deleted.
    delete_call = next(
        c for c in delete_mock.call_args_list if c.args[0].endswith("/key/delete")
    )
    assert delete_call.kwargs["json"]["keys"] == ["sk-old-promoted-key"]
    # The new key is now the cached one.
    assert app_module.get_cached_key(config.db_path, email) == "sk-new-promoted-key"


def test_regenerate_with_no_prior_cached_key_defaults_to_pending(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    email = "brandnew@crimson.ua.edu"
    get_mock = mocker.patch("app.httpx.get")
    post_mock = mocker.patch(
        "app.httpx.post", return_value=fake_response({"key": "sk-fresh"})
    )
    new_key = app_module.revoke_and_reissue(config, email)
    assert new_key == "sk-fresh"
    # No prior key -> no /key/delete call, and no team lookup was needed.
    get_mock.assert_not_called()
    assert post_mock.call_args.kwargs["json"]["team_id"] == config.pending_team_id


def test_regenerate_still_pending_stays_pending(app_module, mocker, fake_response):
    """A user who regenerates while STILL pending should stay pending --
    not be accidentally promoted or demoted."""
    config = app_module.CONFIG
    email = "stillpending@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-old-pending-key"):
        pass
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response({"info": {"team_id": config.pending_team_id}}),
    )

    def post_side_effect(url, **kwargs):
        if url.endswith("/key/delete"):
            return fake_response({"deleted_keys": ["sk-old-pending-key"]})
        if url.endswith("/key/generate"):
            assert kwargs["json"]["team_id"] == config.pending_team_id
            return fake_response({"key": "sk-new-pending-key"})
        raise AssertionError(f"unexpected POST to {url}")

    mocker.patch("app.httpx.post", side_effect=post_side_effect)

    new_key = app_module.revoke_and_reissue(config, email)
    assert new_key == "sk-new-pending-key"


class mocker_seed_cache:
    """Context manager that seeds the keys table directly (bypassing
    issue_key/HTTP) so a test can set up "this email already has a
    cached key" without mocking issue_key's own HTTP call too."""

    def __init__(self, app_module, config, email, key):
        self._app_module = app_module
        self._config = config
        self._email = email
        self._key = key

    def __enter__(self):
        import sqlite3
        import time

        with sqlite3.connect(self._config.db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO keys (email, litellm_key, key_id, created_at) "
                "VALUES (?, ?, ?, ?)",
                (self._email, self._key, "seed", time.time()),
            )
            conn.commit()

    def __exit__(self, *exc_info):
        return False


# ---------------------------------------------------------------------------
# render_page -- pending vs active rendering, and no leaking a key into
# the pending-state page
# ---------------------------------------------------------------------------


def test_render_page_pending_shows_plain_language_not_error(app_module):
    config = app_module.CONFIG
    html = app_module.render_page("student@crimson.ua.edu", "sk-hidden", False, config)
    assert "not yet activated" in html
    assert config.admin_contact in html
    assert "403" not in html
    assert "Traceback" not in html
    # The key must NOT be shown while pending.
    assert "sk-hidden" not in html


def test_render_page_active_shows_key_and_continue_config(app_module):
    config = app_module.CONFIG
    html = app_module.render_page("student@crimson.ua.edu", "sk-realkey", True, config)
    assert "sk-realkey" in html
    assert "qwen3.8-27b" in html
    assert "https://local-llm.uamishub.com/v1" in html
    assert "roles: [chat, edit, apply, agent]" in html
    assert "Regenerate" in html
    assert app_module.ONBOARDING_URL in html


def test_render_page_active_roles_include_agent(app_module):
    """Regression guard for the team-lead brief: the plan's own snippet
    and the onboarding/ scripts still say [chat, edit, apply] -- agent
    tool calling now works on vLLM, so the portal must include "agent"."""
    config = app_module.CONFIG
    html = app_module.render_page("x@ua.edu", "sk-k", True, config)
    assert "agent" in html.split("roles:")[1].splitlines()[0]


def test_render_page_links_to_onboarding_scripts_both_states(app_module):
    config = app_module.CONFIG
    pending_html = app_module.render_page("a@ua.edu", "sk-a", False, config)
    active_html = app_module.render_page("b@ua.edu", "sk-b", True, config)
    assert app_module.ONBOARDING_URL in pending_html
    assert app_module.ONBOARDING_URL in active_html


# ---------------------------------------------------------------------------
# HTTP-level routes via FastAPI TestClient
# ---------------------------------------------------------------------------


@pytest.fixture
def client(app_module):
    from fastapi.testclient import TestClient

    return TestClient(app_module.app)


def test_healthz(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_index_without_jwt_assertion_returns_401(client):
    resp = client.get("/")
    assert resp.status_code == 401


def test_index_first_time_visit_issues_pending_key(
    app_module, client, mocker, fake_response
):
    email = "firsttime@crimson.ua.edu"
    mocker.patch.object(app_module, "verify_access_jwt", return_value=email)
    mocker.patch(
        "app.httpx.post", return_value=fake_response({"key": "sk-issued-pending"})
    )
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response(
            {"info": {"team_id": app_module.CONFIG.pending_team_id}}
        ),
    )
    resp = client.get("/", headers={"Cf-Access-Jwt-Assertion": "irrelevant-mocked"})
    assert resp.status_code == 200
    assert "not yet activated" in resp.text
    assert "sk-issued-pending" not in resp.text


def test_index_active_user_sees_key_and_config(
    app_module, client, mocker, fake_response
):
    email = "active@crimson.ua.edu"
    mocker.patch.object(app_module, "verify_access_jwt", return_value=email)
    with mocker_seed_cache(app_module, app_module.CONFIG, email, "sk-active-key"):
        pass
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response(
            {
                "info": {"team_id": "students-team"},
                "team_info": {"models": ["qwen3.8-27b"]},
            }
        ),
    )

    def get_side_effect(url, **kwargs):
        if url.endswith("/key/info"):
            return fake_response({"info": {"team_id": "students-team"}})
        if url.endswith("/team/info"):
            return fake_response({"team_info": {"models": ["qwen3.8-27b"]}})
        raise AssertionError(f"unexpected GET {url}")

    mocker.patch("app.httpx.get", side_effect=get_side_effect)
    resp = client.get("/", headers={"Cf-Access-Jwt-Assertion": "irrelevant-mocked"})
    assert resp.status_code == 200
    assert "sk-active-key" in resp.text
    assert "roles: [chat, edit, apply, agent]" in resp.text
