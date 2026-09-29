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
    assert config.students_team_id == "students-team-id"
    assert config.faculty_team_id == "faculty-team-id"
    assert config.cf_access_aud == "test-aud-tag"
    assert config.allowed_email_suffixes == ("@crimson.ua.edu", "@ua.edu")
    # Lower-cased and whitespace-stripped -- see conftest.py's deliberately
    # messy ADMIN_EMAILS fixture value.
    assert config.admin_emails == ("admin@ua.edu", "faculty-admin@crimson.ua.edu")
    assert config.jwks_url == (
        "https://test-team.cloudflareaccess.com/cdn-cgi/access/certs"
    )


def test_load_config_missing_cf_access_aud_fails_loudly(app_module, monkeypatch):
    # Simulates the box's real, currently-blank CF_ACCESS_AUD_KEYPORTAL.
    monkeypatch.setenv("CF_ACCESS_AUD", "")
    with pytest.raises(RuntimeError, match="CF_ACCESS_AUD is unset or blank"):
        app_module.load_config()


# ---------------------------------------------------------------------------
# ADMIN_EMAILS -- same fail-loudly contract as CF_ACCESS_AUD. This is a
# security boundary (require_admin() below trusts config.admin_emails
# completely), so "fails at startup" is not optional -- an admin panel
# that came up with an empty allowlist would be open to every
# crimson.ua.edu/ua.edu visitor.
# ---------------------------------------------------------------------------


def test_load_config_missing_admin_emails_fails_loudly(app_module, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "")
    with pytest.raises(RuntimeError, match="ADMIN_EMAILS is unset or blank"):
        app_module.load_config()


def test_load_config_admin_emails_only_commas_and_whitespace_fails_loudly(
    app_module, monkeypatch
):
    """ADMIN_EMAILS=" , " is non-blank by _require_env's own check (there
    are non-whitespace characters), but splits into zero real emails --
    must still fail loudly, not silently produce an empty allowlist."""
    monkeypatch.setenv("ADMIN_EMAILS", " , , ")
    with pytest.raises(RuntimeError, match="ADMIN_EMAILS is unset or blank"):
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


def test_init_db_locks_down_file_permissions(app_module, tmp_path):
    """The db holds raw LiteLLM keys in the clear -- it must be
    owner-only (0600), and its parent directory owner-only (0700)."""
    db_path = tmp_path / "sub" / "perm-test.db"
    app_module.init_db(str(db_path))
    assert oct(db_path.stat().st_mode)[-3:] == "600"
    assert oct(db_path.parent.stat().st_mode)[-3:] == "700"


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


def test_issue_key_never_sets_user_id(app_module, mocker, fake_response):
    """Regression test for the shipped promotion bug (2026-09-29): a key
    generated with user_id=email can never be promoted via /key/update,
    because LiteLLM's team-membership check keys off key.user_id and no
    User/membership row is ever created for that literal string (see
    issue_key()'s docstring and test_live_integration.py for the live
    proof). The payload sent to /key/generate must not contain
    "user_id" at all -- not None, not the email, absent."""
    config = app_module.CONFIG
    post_mock = mocker.patch(
        "app.httpx.post", return_value=fake_response({"key": "sk-nouserid"})
    )
    app_module.issue_key(config, "nouserid@crimson.ua.edu", config.pending_team_id)
    assert "user_id" not in post_mock.call_args.kwargs["json"]
    assert post_mock.call_args.kwargs["json"]["key_alias"] == "nouserid@crimson.ua.edu"
    assert (
        post_mock.call_args.kwargs["json"]["metadata"]["portal_email"]
        == "nouserid@crimson.ua.edu"
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


def test_issue_key_cas_prevents_orphan_when_row_changes_mid_flight(
    app_module, mocker, fake_response
):
    """Security review B1 hardening (2026-09-30): issue_key()'s final
    write is a compare-and-swap against the row it read BEFORE calling
    LiteLLM, arbitrated by sqlite itself -- a guard that stays correct
    independent of _lock_for_email(), specifically so this doesn't
    silently reopen if a future deployment ever runs more than one
    process. Simulates that exact scenario directly, bypassing the
    in-process lock entirely: the DB row changes to a DIFFERENT key
    WHILE issue_key() is "waiting" on LiteLLM, as if a second process
    had already won the race."""
    import sqlite3
    from contextlib import closing

    config = app_module.CONFIG
    email = "cas-race@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-casold"):
        pass

    delete_calls = []

    def post_side_effect(url, **kwargs):
        if url.endswith("/key/generate"):
            # A "concurrent other process" wins the race and updates
            # the row while THIS call is still "waiting" on LiteLLM.
            with closing(sqlite3.connect(config.db_path)) as conn:
                conn.execute(
                    "UPDATE keys SET litellm_key = ? WHERE email = ?",
                    ("sk-caswinner", email),
                )
                conn.commit()
            return fake_response({"key": "sk-casloser"})
        if url.endswith("/key/delete"):
            delete_calls.append(kwargs["json"]["keys"][0])
            return fake_response({"deleted_keys": kwargs["json"]["keys"]})
        raise AssertionError(f"unexpected POST to {url}")

    mocker.patch("app.httpx.post", side_effect=post_side_effect)
    result = app_module.issue_key(config, email, config.students_team_id)

    # The loser's freshly-minted key must be cleaned up, not left as a
    # live, untracked orphan in LiteLLM.
    assert "sk-casloser" in delete_calls
    # The caller still gets back a real, TRACKED key -- the winner's,
    # not the orphan -- so nobody is left without a working key.
    assert result == "sk-caswinner"
    assert app_module.get_cached_key(config.db_path, email) == "sk-caswinner"


def test_issue_key_cas_first_time_issuance_still_wins_normally(
    app_module, mocker, fake_response
):
    """Sanity check that the CAS logic doesn't break the ordinary,
    non-racing first-issuance path (previous_key=None -> INSERT OR
    IGNORE)."""
    config = app_module.CONFIG
    mocker.patch("app.httpx.post", return_value=fake_response({"key": "sk-casfirst"}))
    key = app_module.issue_key(
        config, "cas-first@crimson.ua.edu", config.pending_team_id
    )
    assert key == "sk-casfirst"
    assert app_module.get_cached_key(config.db_path, "cas-first@crimson.ua.edu") == (
        "sk-casfirst"
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


def test_get_current_team_id_sends_sha256_hash_not_raw_key(
    app_module, mocker, fake_response
):
    """Security review F2/F4 (2026-09-30): LiteLLM's own /key/info docs
    say a raw key in the `key` query parameter is recorded verbatim by
    any HTTP access log in front of the proxy -- pass the SHA256 hash
    instead (verified live to return identical info). This is the only
    place in the file that ever put a key in a query string; every
    other LiteLLM call already uses a JSON body."""
    import hashlib

    config = app_module.CONFIG
    get_mock = mocker.patch(
        "app.httpx.get",
        return_value=fake_response({"info": {"team_id": "students-team"}}),
    )
    raw_key = "sk-fake-raw"
    app_module.get_current_team_id(config, raw_key)
    sent_key = get_mock.call_args.kwargs["params"]["key"]
    assert sent_key != raw_key
    assert sent_key == hashlib.sha256(raw_key.encode()).hexdigest()


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


def test_regenerate_raises_when_delete_fails(app_module, mocker, fake_response):
    """Security review F2 (2026-09-30): a silently-failed /key/delete
    used to let revoke_and_reissue() sail on to issue a SECOND key
    anyway, leaving a dangling old key in LiteLLM that would later 500
    list_issued_users() the moment someone looked it up. The delete
    response is now checked with raise_for_status() -- a failed delete
    must stop the regenerate, not be swallowed."""
    config = app_module.CONFIG
    email = "delete-fails@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-delfail"):
        pass
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response({"info": {"team_id": config.pending_team_id}}),
    )

    # Isolate the failure to /key/delete specifically -- /key/generate
    # must succeed here, so a passing test can only mean the DELETE's
    # own raise_for_status caught it, not issue_key()'s.
    def post_side_effect(url, **kwargs):
        if url.endswith("/key/delete"):
            return fake_response({"error": "boom"}, status_code=500)
        if url.endswith("/key/generate"):
            return fake_response({"key": "sk-unreached"})
        raise AssertionError(f"unexpected POST to {url}")

    generate_mock = mocker.patch("app.httpx.post", side_effect=post_side_effect)
    with pytest.raises(Exception):
        app_module.revoke_and_reissue(config, email)
    # And /key/generate must never even have been called -- the whole
    # point is to stop BEFORE issuing a second key on top of an old one
    # whose deletion status is unknown.
    assert not any(
        c.args[0].endswith("/key/generate") for c in generate_mock.call_args_list
    )


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
# render_page -- student landing-page intro, added ABOVE the key section
# (team-lead brief, 2026-09-29): what-this-is, how-to-use-it, honest
# expectations, course-policy line, who-to-contact. Must appear in BOTH
# pending and active states without regressing anything already covered
# above.
# ---------------------------------------------------------------------------


def test_render_page_intro_appears_in_both_states(app_module):
    config = app_module.CONFIG
    pending_html = app_module.render_page("a@ua.edu", "sk-a", False, config)
    active_html = app_module.render_page("b@ua.edu", "sk-b", True, config)
    for html in (pending_html, active_html):
        assert "MIS program" in html
        assert "outside company" in html
        assert "How to use it" in html
        assert "30" in html and "60 seconds" in html
        assert "does not override your course" in html
        assert config.admin_contact in html


def test_render_page_intro_admin_contact_is_from_config_not_hardcoded(app_module):
    """The contact line must come from config.admin_contact (ADMIN_CONTACT
    env var), never a hardcoded name -- the box's current value happens to
    be "LabMx", but the portal must not assume that."""
    from dataclasses import replace

    config = replace(app_module.CONFIG, admin_contact="Some Other Contact")
    html = app_module.render_page("a@ua.edu", "sk-a", False, config)
    assert "Some Other Contact" in html


def test_render_page_intro_course_policy_line_present_both_states(app_module):
    config = app_module.CONFIG
    pending_html = app_module.render_page("a@ua.edu", "sk-a", False, config)
    active_html = app_module.render_page("b@ua.edu", "sk-b", True, config)
    for html in (pending_html, active_html):
        assert "course" in html.lower()
        assert "assignment" in html.lower()


def test_render_page_intro_includes_generic_manual_config_with_placeholder(
    app_module,
):
    """The manual copy-paste config block belongs on the page itself (not
    only a link out to onboarding/), so a pending user -- who never sees a
    real key -- can still see the shape of the file. It must use a
    placeholder, never leak the caller's real key."""
    config = app_module.CONFIG
    hidden_key = "sk-pendhide"  # must never leak into the pending page
    html = app_module.render_page("a@ua.edu", hidden_key, False, config)
    assert "your key" in html.lower()
    assert app_module.MODEL_NAME in html
    assert app_module.MODEL_ENDPOINT in html
    assert hidden_key not in html


def test_render_page_intro_does_not_imply_ai_always_allowed(app_module):
    """MIS 221 forbids AI assistance on PA-1 -- the page must not claim or
    imply the tool is unconditionally fine to use for coursework."""
    config = app_module.CONFIG
    html = app_module.render_page("a@ua.edu", "sk-a", False, config)
    lowered = html.lower()
    assert "always allowed" not in lowered
    assert "use this for any assignment" not in lowered


def test_render_page_has_viewport_meta_for_mobile(app_module):
    config = app_module.CONFIG
    html = app_module.render_page("a@ua.edu", "sk-a", False, config)
    assert "width=device-width" in html


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


# ---------------------------------------------------------------------------
# require_admin -- the authorization boundary for the whole /admin* surface.
# ---------------------------------------------------------------------------

ADMIN_EMAIL = "admin@ua.edu"  # matches conftest.py's ADMIN_EMAILS fixture
NON_ADMIN_EMAIL = "student@crimson.ua.edu"
# Matches conftest.py's KEYPORTAL_HOSTNAME fixture. Security review F5
# (2026-09-30) added a same-origin check to every state-changing POST,
# so every test that expects to get PAST that check -- including tests
# of unrelated behavior like auth or form validation -- must send this.
VALID_ORIGIN_HEADER = {"Origin": "https://local-llm-keys.uamishub.com"}


def test_require_admin_allows_exact_match(app_module):
    app_module.require_admin(ADMIN_EMAIL, app_module.CONFIG)  # must not raise


def test_require_admin_matches_case_insensitively_and_strips_whitespace(app_module):
    # conftest.py's ADMIN_EMAILS includes " Faculty-Admin@Crimson.UA.EDU "
    # -- exercise whitespace-stripping with an ALREADY-lowercase value.
    app_module.require_admin(
        "  faculty-admin@crimson.ua.edu  ", app_module.CONFIG
    )  # must not raise


def test_require_admin_matches_when_caller_supplies_uppercase(app_module):
    """Security review (2026-09-30): a surviving mutant showed the
    previous case-insensitivity test passed only ALREADY-lowercase
    input, so it never actually exercised require_admin() lower-casing
    the CALLER's value before comparing. conftest.py's ADMIN_EMAILS
    stores "admin@ua.edu" (already lowercase); this asserts an
    uppercase claim from Entra still matches it. Real-world stakes: if
    this regressed, an admin whose Entra UPN comes back mixed-case would
    be 403'd out of their own panel."""
    app_module.require_admin("ADMIN@UA.EDU", app_module.CONFIG)  # must not raise


def test_require_admin_rejects_non_admin(app_module):
    with pytest.raises(HTTPException) as exc_info:
        app_module.require_admin(NON_ADMIN_EMAIL, app_module.CONFIG)
    assert exc_info.value.status_code == 403


@pytest.mark.parametrize(
    "lookalike_email",
    [
        "xadmin@ua.edu",  # superstring of "admin@ua.edu" -- substring match would wrongly allow
        "admin@ua.edu.attacker.example",  # allowlist entry as a PREFIX of this string
    ],
)
def test_require_admin_rejects_substring_lookalikes(app_module, lookalike_email):
    """Security review (2026-09-30): a surviving mutant showed
    require_admin() could be changed to substring matching
    (`any(a in email or email in a for a in config.admin_emails)`)
    without any of the 68 existing tests noticing, because
    NON_ADMIN_EMAIL ("student@crimson.ua.edu") happens to be neither a
    sub- nor superstring of any allowlist entry. These two values ARE
    related by substring to "admin@ua.edu" and must still be rejected
    -- exact match is the entire point of this function."""
    with pytest.raises(HTTPException) as exc_info:
        app_module.require_admin(lookalike_email, app_module.CONFIG)
    assert exc_info.value.status_code == 403


def test_require_admin_rejects_with_same_detail_regardless_of_caller(app_module):
    """The 403 must not leak whether a route/payload was otherwise valid --
    every non-admin rejection carries the exact same detail message."""
    with pytest.raises(HTTPException) as exc_info:
        app_module.require_admin(NON_ADMIN_EMAIL, app_module.CONFIG)
    assert exc_info.value.detail == app_module._ADMIN_FORBIDDEN_DETAIL


# ---------------------------------------------------------------------------
# list_issued_users / render_admin_page -- the key must NEVER appear.
# ---------------------------------------------------------------------------


def test_list_issued_users_reports_email_team_state_and_issued_at(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    email = "listed@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-listed"):
        pass
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response(
            {
                "info": {"team_id": config.students_team_id},
                "team_info": {"models": ["qwen3.8-27b"]},
            }
        ),
    )

    def get_side_effect(url, **kwargs):
        if url.endswith("/key/info"):
            return fake_response({"info": {"team_id": config.students_team_id}})
        if url.endswith("/team/info"):
            return fake_response({"team_info": {"models": ["qwen3.8-27b"]}})
        raise AssertionError(f"unexpected GET {url}")

    mocker.patch("app.httpx.get", side_effect=get_side_effect)
    users = app_module.list_issued_users(config)
    matching = [u for u in users if u.email == email]
    assert len(matching) == 1
    user = matching[0]
    assert user.team_id == config.students_team_id
    assert user.team_label == "students"
    assert user.active is True
    assert isinstance(user.created_at, float)
    # No key field at all on the dataclass -- not just "not populated".
    assert not hasattr(user, "litellm_key")
    assert not hasattr(user, "key")


def test_list_issued_users_stale_row_is_explicit_not_fatal(
    app_module, mocker, fake_response
):
    """Security review F2 (2026-09-30): a key LiteLLM no longer
    recognizes (deleted out-of-band, expired past 365d, or left behind
    by a failed delete) used to raise unhandled and 500 the ENTIRE
    listing -- permanently, for as long as that one row existed. It
    must now show up as an explicit stale row instead, and every OTHER
    row must still render correctly."""
    import hashlib

    config = app_module.CONFIG
    good_email = "good-row@crimson.ua.edu"
    stale_email = "stale-row@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, good_email, "sk-goodrow"):
        pass
    with mocker_seed_cache(app_module, config, stale_email, "sk-stalerow"):
        pass
    good_hash = hashlib.sha256(b"sk-goodrow").hexdigest()
    stale_hash = hashlib.sha256(b"sk-stalerow").hexdigest()

    def get_side_effect(url, **kwargs):
        if url.endswith("/key/info"):
            key_param = kwargs["params"]["key"]
            if key_param == stale_hash:
                return fake_response({"error": "key not found"}, status_code=400)
            assert key_param == good_hash
            return fake_response({"info": {"team_id": config.students_team_id}})
        if url.endswith("/team/info"):
            return fake_response({"team_info": {"models": ["qwen3.8-27b"]}})
        raise AssertionError(f"unexpected GET {url}")

    mocker.patch("app.httpx.get", side_effect=get_side_effect)
    users = app_module.list_issued_users(config)
    by_email = {u.email: u for u in users}
    assert set(by_email) == {good_email, stale_email}

    good_user = by_email[good_email]
    assert good_user.stale is False
    assert good_user.active is True
    assert good_user.team_label == "students"

    stale_user = by_email[stale_email]
    assert stale_user.stale is True
    assert stale_user.active is False
    assert stale_user.lookup_error is not None


def test_list_issued_users_caches_team_grants_access_per_team(
    app_module, mocker, fake_response
):
    """Security review F2 non-blocking note (2026-09-30): /team/info was
    called once per USER even though there are only a handful of
    distinct teams -- a 300-student roster meant 300 redundant calls on
    top of the 300 unavoidable /key/info calls. Now cached per team_id
    within one call."""
    config = app_module.CONFIG
    for i in range(5):
        with mocker_seed_cache(
            app_module, config, f"student{i}@crimson.ua.edu", f"sk-stu{i}"
        ):
            pass

    team_info_calls = []

    def get_side_effect(url, **kwargs):
        if url.endswith("/key/info"):
            return fake_response({"info": {"team_id": config.students_team_id}})
        if url.endswith("/team/info"):
            team_info_calls.append(kwargs["params"]["team_id"])
            return fake_response({"team_info": {"models": ["qwen3.8-27b"]}})
        raise AssertionError(f"unexpected GET {url}")

    mocker.patch("app.httpx.get", side_effect=get_side_effect)
    users = app_module.list_issued_users(config)
    assert len(users) == 5
    assert all(u.active for u in users)
    # All 5 users are on the SAME team -- /team/info must be called
    # once, not 5 times.
    assert len(team_info_calls) == 1


def test_admin_row_stale_offers_no_promote_demote_buttons(app_module):
    """A stale row's promote/demote buttons would hit the same
    unrecognized LiteLLM key and fail too, from a DIFFERENT code path
    than the one that already flagged it -- don't offer actions that
    can't work."""
    config = app_module.CONFIG
    users = [
        app_module.IssuedUser(
            email="ghost@crimson.ua.edu",
            team_id=None,
            team_label="(unknown -- LiteLLM does not recognize this key)",
            active=False,
            created_at=1_700_000_000.0,
            lookup_error="400 Client Error",
        )
    ]
    html = app_module.render_admin_page(ADMIN_EMAIL, users, [], config)
    assert "ghost@crimson.ua.edu" in html
    assert "Unknown" in html
    assert (
        '<input type="hidden" name="target_email" value="ghost@crimson.ua.edu">'
        not in html
    )


def test_render_admin_page_never_includes_any_key(app_module):
    config = app_module.CONFIG
    users = [
        app_module.IssuedUser(
            email="a@crimson.ua.edu",
            team_id=config.pending_team_id,
            team_label="pending",
            active=False,
            created_at=1_700_000_000.0,
        ),
        app_module.IssuedUser(
            email="b@ua.edu",
            team_id=config.students_team_id,
            team_label="students",
            active=True,
            created_at=1_700_000_100.0,
        ),
    ]
    html = app_module.render_admin_page(ADMIN_EMAIL, users, [], config)
    assert "a@crimson.ua.edu" in html
    assert "b@ua.edu" in html
    assert "pending" in html
    assert "students" in html
    assert "Active" in html
    assert "Pending" in html
    # There is no key anywhere in the fixture data above, but assert the
    # structural guarantee too: the page never renders anything from a
    # "litellm_key"/raw-key source -- IssuedUser has no such field, so
    # this is enforced by render_admin_page() only ever touching
    # IssuedUser attributes.
    assert "sk-" not in html


def test_render_admin_page_empty_state(app_module):
    html = app_module.render_admin_page(ADMIN_EMAIL, [], [], app_module.CONFIG)
    assert "No one has visited" in html
    assert "No one is pre-authorized" in html


def test_render_admin_page_users_none_shows_unavailable_but_roster_intact(app_module):
    """Security review B3 (2026-09-30): users=None is distinct from
    users=[] -- it means the key list could not be read at all, not that
    it read fine and is empty. The roster must render normally either
    way."""
    config = app_module.CONFIG
    preauthorized = [
        app_module.PreauthorizedEntry(
            email="waiting@ua.edu", added_at=1_700_000_000.0, redeemed_at=None
        )
    ]
    html = app_module.render_admin_page(ADMIN_EMAIL, None, preauthorized, config)
    assert "unavailable" in html.lower()
    assert "waiting@ua.edu" in html


def test_render_admin_page_escapes_user_table_values(app_module):
    """Security review (2026-09-30): a surviving mutant showed removing
    escape() from the issued-users table rows changed nothing observable
    to any of the 68 existing tests, because every fixture email/team
    value used in those tests happens to contain no HTML-significant
    characters. Not exploitable today (both values are operator-set or
    from the verified JWT claim), but pin the behavior down so it can't
    silently regress into something that IS exploitable later."""
    config = app_module.CONFIG
    users = [
        app_module.IssuedUser(
            email="<script>alert(1)</script>@ua.edu",
            team_id=config.pending_team_id,
            team_label="<b>pending</b>",
            active=False,
            created_at=1_700_000_000.0,
        )
    ]
    html = app_module.render_admin_page(ADMIN_EMAIL, users, [], config)
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html
    assert "<b>pending</b>" not in html
    assert "&lt;b&gt;pending&lt;/b&gt;" in html


def test_render_admin_page_escapes_signed_in_as(app_module):
    html = app_module.render_admin_page(
        "<img src=x onerror=alert(1)>@ua.edu", [], [], app_module.CONFIG
    )
    assert "<img src=x onerror=alert(1)>" not in html
    assert "&lt;img" in html


def test_render_admin_page_escapes_preauthorized_table_values(app_module):
    config = app_module.CONFIG
    preauthorized = [
        app_module.PreauthorizedEntry(
            email="<script>alert(2)</script>@ua.edu",
            added_at=1_700_000_000.0,
            redeemed_at=None,
        )
    ]
    html = app_module.render_admin_page(ADMIN_EMAIL, [], preauthorized, config)
    assert "<script>alert(2)</script>" not in html
    assert "&lt;script&gt;" in html


def test_render_admin_page_shows_preauthorized_list_with_redeemed_flag(app_module):
    config = app_module.CONFIG
    preauthorized = [
        app_module.PreauthorizedEntry(
            email="waiting@crimson.ua.edu", added_at=1_700_000_000.0, redeemed_at=None
        ),
        app_module.PreauthorizedEntry(
            email="done@ua.edu", added_at=1_700_000_100.0, redeemed_at=1_700_000_200.0
        ),
    ]
    html = app_module.render_admin_page(ADMIN_EMAIL, [], preauthorized, config)
    assert "waiting@crimson.ua.edu" in html
    assert "done@ua.edu" in html
    assert "Waiting" in html
    assert "Redeemed" in html
    # The redeemed entry must not offer a "Remove" button that would
    # just 409 -- it should point at Demote instead.
    assert "Use Demote above" in html


def test_render_admin_page_shows_preauthorize_result_banner(app_module):
    config = app_module.CONFIG
    result = app_module.PreauthorizeResult(
        added=("new@crimson.ua.edu",),
        already_present=("old@ua.edu",),
        rejected=(("bad@gmail.com", "not a crimson.ua.edu or ua.edu address"),),
    )
    html = app_module.render_admin_page(
        ADMIN_EMAIL, [], [], config, preauthorize_result=result
    )
    assert "new@crimson.ua.edu" in html
    assert "old@ua.edu" in html
    assert "bad@gmail.com" in html
    assert "Rejected" in html


# ---------------------------------------------------------------------------
# promote_user / demote_user -- must replicate promote-user.sh exactly:
# two /key/update calls, never a reissue, user_id only ever cleared to
# None (never set to the email), idempotent on repeat.
# ---------------------------------------------------------------------------


def test_promote_user_happy_path_two_calls_no_real_user_id_sent(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    email = "promote-target@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-promote-target"):
        pass
    post_mock = mocker.patch("app.httpx.post", return_value=fake_response({}))

    app_module.promote_user(config, email, "students")

    calls = post_mock.call_args_list
    assert len(calls) == 2
    clear_call, team_call = calls
    assert clear_call.args[0].endswith("/key/update")
    assert clear_call.kwargs["json"]["key"] == "sk-promote-target"
    # Step 1 ONLY ever clears user_id to None -- never the email, never
    # any other value. This is the exact regression issue_key() guards
    # against, replicated here for the admin promotion path.
    assert clear_call.kwargs["json"]["user_id"] is None
    assert team_call.args[0].endswith("/key/update")
    assert team_call.kwargs["json"]["key"] == "sk-promote-target"
    assert team_call.kwargs["json"]["team_id"] == config.students_team_id
    # Step 2's payload has no user_id key at all.
    assert "user_id" not in team_call.kwargs["json"]


def test_promote_user_faculty_target_uses_faculty_team_id(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    email = "promote-faculty@ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-promote-faculty"):
        pass
    post_mock = mocker.patch("app.httpx.post", return_value=fake_response({}))
    app_module.promote_user(config, email, "faculty")
    team_call = post_mock.call_args_list[1]
    assert team_call.kwargs["json"]["team_id"] == config.faculty_team_id


def test_promote_user_rejects_unknown_target(app_module):
    config = app_module.CONFIG
    with pytest.raises(HTTPException) as exc_info:
        app_module.promote_user(config, "someone@ua.edu", "ungraded")
    assert exc_info.value.status_code == 400


def test_promote_user_no_cached_key_returns_404(app_module):
    config = app_module.CONFIG
    with pytest.raises(HTTPException) as exc_info:
        app_module.promote_user(config, "never-visited@ua.edu", "students")
    assert exc_info.value.status_code == 404


def test_promote_user_idempotent_on_repeat(app_module, mocker, fake_response):
    """Promoting an already-promoted user must be a no-op that succeeds --
    never a duplicate membership, never a second key."""
    config = app_module.CONFIG
    email = "repeat-target@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-repeat-target"):
        pass
    post_mock = mocker.patch("app.httpx.post", return_value=fake_response({}))

    app_module.promote_user(config, email, "students")
    app_module.promote_user(config, email, "students")

    # Still the same cached key -- no reissue happened on either call.
    assert app_module.get_cached_key(config.db_path, email) == "sk-repeat-target"
    # Every single call was a /key/update -- never a /key/generate.
    assert len(post_mock.call_args_list) == 4
    for call in post_mock.call_args_list:
        assert call.args[0].endswith("/key/update")
    # Both team-set calls landed on the same team_id.
    team_calls = [c for c in post_mock.call_args_list if "team_id" in c.kwargs["json"]]
    assert len(team_calls) == 2
    assert all(
        c.kwargs["json"]["team_id"] == config.students_team_id for c in team_calls
    )


def test_demote_user_moves_to_pending_team(app_module, mocker, fake_response):
    config = app_module.CONFIG
    email = "demote-target@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-demote-target"):
        pass
    post_mock = mocker.patch("app.httpx.post", return_value=fake_response({}))
    app_module.demote_user(config, email)
    team_call = post_mock.call_args_list[1]
    assert team_call.kwargs["json"]["team_id"] == config.pending_team_id
    assert "user_id" not in team_call.kwargs["json"]


def test_demote_user_no_cached_key_returns_404(app_module):
    config = app_module.CONFIG
    with pytest.raises(HTTPException) as exc_info:
        app_module.demote_user(config, "never-visited@ua.edu")
    assert exc_info.value.status_code == 404


# ---------------------------------------------------------------------------
# HTTP-level /admin* routes -- authorization must fail closed on every
# route, every method, before any LiteLLM call is made.
# ---------------------------------------------------------------------------


def test_admin_index_no_jwt_returns_401(client):
    resp = client.get("/admin")
    assert resp.status_code == 401


def test_admin_promote_no_jwt_returns_401(client):
    resp = client.post(
        "/admin/promote",
        data={"target_email": "x@crimson.ua.edu", "target_team": "students"},
        headers=VALID_ORIGIN_HEADER,
    )
    assert resp.status_code == 401


def test_admin_demote_no_jwt_returns_401(client):
    resp = client.post(
        "/admin/demote",
        data={"target_email": "x@crimson.ua.edu"},
        headers=VALID_ORIGIN_HEADER,
    )
    assert resp.status_code == 401


def test_admin_index_non_admin_returns_403(app_module, client, mocker):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=NON_ADMIN_EMAIL)
    resp = client.get("/admin", headers={"Cf-Access-Jwt-Assertion": "irrelevant"})
    assert resp.status_code == 403


def test_admin_promote_non_admin_returns_403(app_module, client, mocker):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=NON_ADMIN_EMAIL)
    post_mock = mocker.patch("app.httpx.post")
    resp = client.post(
        "/admin/promote",
        data={"target_email": "x@crimson.ua.edu", "target_team": "students"},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == app_module._ADMIN_FORBIDDEN_DETAIL
    # The allowlist check must happen BEFORE any LiteLLM call, not after.
    post_mock.assert_not_called()


def test_admin_demote_non_admin_returns_403(app_module, client, mocker):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=NON_ADMIN_EMAIL)
    post_mock = mocker.patch("app.httpx.post")
    resp = client.post(
        "/admin/demote",
        data={"target_email": "x@crimson.ua.edu"},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == app_module._ADMIN_FORBIDDEN_DETAIL
    post_mock.assert_not_called()


# ---------------------------------------------------------------------------
# F3 (security review, 2026-09-30): a malformed/missing form field used
# to trigger FastAPI's own 422 validation BEFORE verify_access_jwt/
# require_admin ever ran (Form(...) params are resolved ahead of the
# handler body). A non-admin must get the exact same 403 regardless of
# what's in the body -- including an empty one -- and an admin sending a
# genuinely malformed body should still get a clean 422, just AFTER auth.
# ---------------------------------------------------------------------------


def test_admin_promote_non_admin_malformed_body_still_403(app_module, client, mocker):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=NON_ADMIN_EMAIL)
    post_mock = mocker.patch("app.httpx.post")
    resp = client.post(
        "/admin/promote",
        data={},  # both required fields missing
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 403
    post_mock.assert_not_called()


def test_admin_promote_admin_malformed_body_returns_422_after_auth(
    app_module, client, mocker
):
    """The fix moves WHEN validation happens (after auth), not whether
    it happens -- an admin with a bad payload still gets a clean 422."""
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    resp = client.post(
        "/admin/promote",
        data={"target_email": "someone@ua.edu"},  # target_team missing
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 422


def test_admin_demote_non_admin_malformed_body_still_403(app_module, client, mocker):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=NON_ADMIN_EMAIL)
    post_mock = mocker.patch("app.httpx.post")
    resp = client.post(
        "/admin/demote",
        data={},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 403
    post_mock.assert_not_called()


def test_admin_preauthorize_non_admin_malformed_body_still_403(
    app_module, client, mocker
):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=NON_ADMIN_EMAIL)
    resp = client.post(
        "/admin/preauthorize",
        data={},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 403


def test_admin_preauthorize_remove_non_admin_malformed_body_still_403(
    app_module, client, mocker
):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=NON_ADMIN_EMAIL)
    resp = client.post(
        "/admin/preauthorize/remove",
        data={},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 403


def test_admin_promote_succeeds_even_with_unrelated_stale_row(
    app_module, client, mocker, fake_response
):
    """Security review F2 symptom (b) (2026-09-30): promote_user() used
    to succeed and then the POST-mutation list_issued_users() call would
    throw because of an UNRELATED stale row elsewhere in the table,
    reporting the whole request as a failure even though the promotion
    had already applied. Fixed by list_issued_users() no longer raising
    on a per-row failure -- this exercises the exact reproduction
    shape."""
    import hashlib

    config = app_module.CONFIG
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    target_email = "promote-target-amid-stale@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, target_email, "sk-targetx"):
        pass
    with mocker_seed_cache(
        app_module, config, "stale-neighbor@ua.edu", "sk-staleneighbor"
    ):
        pass
    stale_hash = hashlib.sha256(b"sk-staleneighbor").hexdigest()

    def get_side_effect(url, **kwargs):
        if url.endswith("/key/info"):
            if kwargs["params"]["key"] == stale_hash:
                return fake_response({"error": "gone"}, status_code=400)
            return fake_response({"info": {"team_id": config.students_team_id}})
        if url.endswith("/team/info"):
            return fake_response({"team_info": {"models": ["qwen3.8-27b"]}})
        raise AssertionError(f"unexpected GET {url}")

    mocker.patch("app.httpx.get", side_effect=get_side_effect)
    mocker.patch("app.httpx.post", return_value=fake_response({}))

    resp = client.post(
        "/admin/promote",
        data={"target_email": target_email, "target_team": "students"},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 200
    assert target_email in resp.text
    # The stale row is shown, not hidden, and did not crash this request.
    assert "stale-neighbor@ua.edu" in resp.text


def test_admin_index_admin_sees_users_table(app_module, client, mocker, fake_response):
    config = app_module.CONFIG
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    with mocker_seed_cache(app_module, config, "seen@crimson.ua.edu", "sk-seen"):
        pass
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response({"info": {"team_id": config.pending_team_id}}),
    )
    resp = client.get("/admin", headers={"Cf-Access-Jwt-Assertion": "irrelevant"})
    assert resp.status_code == 200
    assert "seen@crimson.ua.edu" in resp.text
    assert "sk-seen" not in resp.text
    assert ADMIN_EMAIL in resp.text


def test_admin_promote_route_happy_path_updates_and_redisplays(
    app_module, client, mocker, fake_response
):
    config = app_module.CONFIG
    email = "route-promote@crimson.ua.edu"
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    with mocker_seed_cache(app_module, config, email, "sk-route-promote"):
        pass

    def get_side_effect(url, **kwargs):
        return fake_response({"info": {"team_id": config.students_team_id}})

    mocker.patch("app.httpx.get", side_effect=get_side_effect)
    post_mock = mocker.patch("app.httpx.post", return_value=fake_response({}))

    resp = client.post(
        "/admin/promote",
        data={"target_email": email, "target_team": "students"},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 200
    assert email in resp.text
    assert "sk-route-promote" not in resp.text
    team_call = post_mock.call_args_list[1]
    assert team_call.kwargs["json"]["team_id"] == config.students_team_id


def test_admin_demote_route_happy_path(app_module, client, mocker, fake_response):
    config = app_module.CONFIG
    email = "route-demote@crimson.ua.edu"
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    with mocker_seed_cache(app_module, config, email, "sk-route-demote"):
        pass
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response({"info": {"team_id": config.pending_team_id}}),
    )
    post_mock = mocker.patch("app.httpx.post", return_value=fake_response({}))

    resp = client.post(
        "/admin/demote",
        data={"target_email": email},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 200
    team_call = post_mock.call_args_list[1]
    assert team_call.kwargs["json"]["team_id"] == config.pending_team_id


# ---------------------------------------------------------------------------
# verify_same_origin -- CSRF defense for every state-changing POST
# (security review F5, 2026-09-30). Cloudflare Access's SameSite cookie
# behavior already makes a forged cross-site POST non-exploitable today,
# but that safety rests on an off-box dashboard toggle nobody here
# controls -- this is the application-layer backstop.
# ---------------------------------------------------------------------------

EXPECTED_ORIGIN = "https://local-llm-keys.uamishub.com"


def test_verify_same_origin_valid_origin_passes(app_module, make_request):
    request = make_request(headers={"Origin": EXPECTED_ORIGIN})
    app_module.verify_same_origin(request, app_module.CONFIG)  # must not raise


def test_verify_same_origin_wrong_host_rejected(app_module, make_request):
    request = make_request(headers={"Origin": "https://attacker.example"})
    with pytest.raises(HTTPException) as exc_info:
        app_module.verify_same_origin(request, app_module.CONFIG)
    assert exc_info.value.status_code == 403
    assert "origin mismatch" in exc_info.value.detail.lower()


def test_verify_same_origin_suffix_attack_host_rejected(app_module, make_request):
    """Same class of bug as the require_admin substring mutant: a naive
    `startswith`/`in` check would accept a host that merely STARTS WITH
    the expected hostname as a subdomain-looking prefix of an attacker
    domain."""
    request = make_request(
        headers={"Origin": "https://local-llm-keys.uamishub.com.attacker.example"}
    )
    with pytest.raises(HTTPException) as exc_info:
        app_module.verify_same_origin(request, app_module.CONFIG)
    assert exc_info.value.status_code == 403


def test_verify_same_origin_absent_origin_valid_referer_passes(
    app_module, make_request
):
    request = make_request(headers={"Referer": f"{EXPECTED_ORIGIN}/admin"})
    app_module.verify_same_origin(request, app_module.CONFIG)  # must not raise


def test_verify_same_origin_referer_does_not_override_a_present_origin(
    app_module, make_request
):
    """Referer is a FALLBACK for when Origin is absent, never a second
    chance for a mismatched Origin -- a request with a bad Origin AND a
    good Referer must still be rejected."""
    request = make_request(
        headers={
            "Origin": "https://attacker.example",
            "Referer": f"{EXPECTED_ORIGIN}/admin",
        }
    )
    with pytest.raises(HTTPException) as exc_info:
        app_module.verify_same_origin(request, app_module.CONFIG)
    assert exc_info.value.status_code == 403


def test_verify_same_origin_both_absent_rejected(app_module, make_request):
    """Fail closed: a state-changing POST with NEITHER header must be
    rejected, not allowed through -- the same "never silently permissive"
    contract as the rest of this file."""
    request = make_request(headers={})
    with pytest.raises(HTTPException) as exc_info:
        app_module.verify_same_origin(request, app_module.CONFIG)
    assert exc_info.value.status_code == 403


def test_admin_promote_wrong_origin_rejected_zero_calls(app_module, client, mocker):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    post_mock = mocker.patch("app.httpx.post")
    resp = client.post(
        "/admin/promote",
        data={"target_email": "x@crimson.ua.edu", "target_team": "students"},
        headers={
            "Cf-Access-Jwt-Assertion": "irrelevant",
            "Origin": "https://attacker.example",
        },
    )
    assert resp.status_code == 403
    assert "origin mismatch" in resp.json()["detail"].lower()
    post_mock.assert_not_called()
    assert (
        app_module.get_cached_key(app_module.CONFIG.db_path, "x@crimson.ua.edu") is None
    )


def test_admin_promote_suffix_attack_origin_rejected(app_module, client, mocker):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    post_mock = mocker.patch("app.httpx.post")
    resp = client.post(
        "/admin/promote",
        data={"target_email": "x@crimson.ua.edu", "target_team": "students"},
        headers={
            "Cf-Access-Jwt-Assertion": "irrelevant",
            "Origin": "https://local-llm-keys.uamishub.com.attacker.example",
        },
    )
    assert resp.status_code == 403
    post_mock.assert_not_called()


def test_admin_preauthorize_wrong_origin_no_db_write(app_module, client, mocker):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    resp = client.post(
        "/admin/preauthorize",
        data={"emails": "wouldbe@crimson.ua.edu"},
        headers={
            "Cf-Access-Jwt-Assertion": "irrelevant",
            "Origin": "https://attacker.example",
        },
    )
    assert resp.status_code == 403
    # Zero DB writes on rejection -- the paste never took effect.
    assert (
        app_module.is_preauthorized(app_module.CONFIG, "wouldbe@crimson.ua.edu")
        is False
    )
    assert app_module.list_preauthorized(app_module.CONFIG) == []


def test_regenerate_wrong_origin_rejected_key_untouched(app_module, client, mocker):
    """Security review F5 (2026-09-30) explicitly calls out /regenerate:
    it is student-facing, not admin, but a forged POST here would
    silently invalidate a student's working key. Must be covered by its
    own test, not just inferred from the admin routes."""
    config = app_module.CONFIG
    email = "regen-origin-check@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-regenorigin"):
        pass
    mocker.patch.object(app_module, "verify_access_jwt", return_value=email)
    post_mock = mocker.patch("app.httpx.post")
    resp = client.post("/regenerate", headers={"Origin": "https://attacker.example"})
    assert resp.status_code == 403
    assert "origin mismatch" in resp.json()["detail"].lower()
    post_mock.assert_not_called()
    # The student's key must be completely untouched by the rejected
    # forgery attempt.
    assert app_module.get_cached_key(config.db_path, email) == "sk-regenorigin"


def test_regenerate_no_origin_or_referer_rejected(app_module, client, mocker):
    config = app_module.CONFIG
    email = "regen-no-origin@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-regennoorigin"):
        pass
    mocker.patch.object(app_module, "verify_access_jwt", return_value=email)
    post_mock = mocker.patch("app.httpx.post")
    resp = client.post("/regenerate")
    assert resp.status_code == 403
    post_mock.assert_not_called()


def test_regenerate_valid_origin_succeeds(app_module, client, mocker, fake_response):
    """Confirms the check does not accidentally break the real student
    path -- a valid same-origin regenerate must still work end to end.
    Mocks an ACTIVE (students) team throughout, so the new key actually
    shows up in the response -- the app correctly HIDES the key while
    pending, so that state wouldn't prove the round trip worked."""
    config = app_module.CONFIG
    email = "regen-valid-origin@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-regenvalid"):
        pass
    mocker.patch.object(app_module, "verify_access_jwt", return_value=email)

    def get_side_effect(url, **kwargs):
        if url.endswith("/key/info"):
            return fake_response({"info": {"team_id": config.students_team_id}})
        if url.endswith("/team/info"):
            return fake_response({"team_info": {"models": ["qwen3.8-27b"]}})
        raise AssertionError(f"unexpected GET {url}")

    mocker.patch("app.httpx.get", side_effect=get_side_effect)

    def post_side_effect(url, **kwargs):
        if url.endswith("/key/delete"):
            return fake_response({"deleted_keys": kwargs["json"]["keys"]})
        if url.endswith("/key/generate"):
            return fake_response({"key": "sk-regenfresh"})
        raise AssertionError(f"unexpected POST to {url}")

    mocker.patch("app.httpx.post", side_effect=post_side_effect)
    resp = client.post("/regenerate", headers=VALID_ORIGIN_HEADER)
    assert resp.status_code == 200
    assert "sk-regenfresh" in resp.text


# ---------------------------------------------------------------------------
# Pre-authorization: an admin pastes a class roster BEFORE anyone has
# signed in (team-lead brief, 2026-09-30).
# ---------------------------------------------------------------------------


def test_add_preauthorized_emails_accepts_valid_ua_emails(app_module):
    config = app_module.CONFIG
    result = app_module.add_preauthorized_emails(
        config, "one@crimson.ua.edu,two@ua.edu"
    )
    assert result.added == ("one@crimson.ua.edu", "two@ua.edu")
    assert result.already_present == ()
    assert result.rejected == ()
    entries = {e.email: e for e in app_module.list_preauthorized(config)}
    assert set(entries) == {"one@crimson.ua.edu", "two@ua.edu"}
    assert all(not e.redeemed for e in entries.values())


def test_add_preauthorized_emails_normalizes_messy_paste(app_module):
    """Mixed separators (comma, newline, semicolon, AND tab), stray
    whitespace, mixed case, and an internal duplicate -- exactly what a
    Canvas/Excel/Outlook paste looks like in practice. Extended per
    security review B4 (2026-09-30) to cover tab and semicolon, which is
    precisely the separator class that shipped broken."""
    config = app_module.CONFIG
    raw = (
        "  Alice@Crimson.UA.EDU \n bob@ua.edu, ALICE@crimson.ua.edu\n\n"
        "carol@ua.edu ;dave@ua.edu\teve@ua.edu"
    )
    result = app_module.add_preauthorized_emails(config, raw)
    # alice appears twice (different case) but must be added only once.
    assert result.added == (
        "alice@crimson.ua.edu",
        "bob@ua.edu",
        "carol@ua.edu",
        "dave@ua.edu",
        "eve@ua.edu",
    )
    assert result.already_present == ()
    assert result.rejected == ()
    emails = {e.email for e in app_module.list_preauthorized(config)}
    assert emails == {
        "alice@crimson.ua.edu",
        "bob@ua.edu",
        "carol@ua.edu",
        "dave@ua.edu",
        "eve@ua.edu",
    }


def test_add_preauthorized_emails_rejects_multi_field_paste_shapes(app_module):
    """Security review B4 (2026-09-30): a tab- or semicolon-separated
    roster paste (a name in one Excel cell, the email in the next; a
    semicolon-joined Outlook address list) used to authorize NOBODY
    while reporting success -- the suffix-only check let a whole
    "Name\\tEmail" or "email1;email2" line through as one bogus stored
    "email", and nothing was ever reported as rejected. This is the
    exact reproduction from the review, including a stray \\r (Windows
    line ending)."""
    config = app_module.CONFIG
    raw = (
        "a@ua.edu\r\nb@crimson.ua.edu\nSmith\tc@ua.edu\nd@ua.edu;e@ua.edu\n  f@ua.edu  "
    )
    result = app_module.add_preauthorized_emails(config, raw)
    assert set(result.added) == {
        "a@ua.edu",
        "b@crimson.ua.edu",
        "c@ua.edu",
        "d@ua.edu",
        "e@ua.edu",
        "f@ua.edu",
    }
    # "Smith" must be REPORTED, not silently dropped -- that promise
    # (app.py's own render_admin_page help text) was broken before this
    # fix.
    rejected_emails = [e for e, _reason in result.rejected]
    assert "smith" in rejected_emails
    for email in ("c@ua.edu", "d@ua.edu", "e@ua.edu"):
        assert app_module.is_preauthorized(config, email) is True


def test_looks_like_email_rejects_malformed_shapes(app_module):
    """Direct unit coverage of the shape check itself (security review
    B4/N1, 2026-09-30) -- these are the specific lookalikes the reviewer
    traced as inert-but-confusing under the old suffix-only check."""
    config = app_module.CONFIG
    assert app_module._looks_like_email("plain@ua.edu", config) is True
    assert app_module._looks_like_email("@ua.edu", config) is False  # empty local part
    assert app_module._looks_like_email("two@at@ua.edu", config) is False  # 2 "@"s
    assert (
        app_module._looks_like_email("<jane@ua.edu", config) is False
    )  # angle bracket
    assert app_module._looks_like_email("-leading-dash@ua.edu", config) is False


def test_add_preauthorized_emails_rejects_non_ua_domain_and_reports_it(app_module):
    config = app_module.CONFIG
    result = app_module.add_preauthorized_emails(
        config,
        "good@crimson.ua.edu, bad@gmail.com, also-bad@outlook.com, foo@ua.edu.evil.com",
    )
    assert result.added == ("good@crimson.ua.edu",)
    assert len(result.rejected) == 3
    rejected_emails = [e for e, _reason in result.rejected]
    assert "bad@gmail.com" in rejected_emails
    assert "also-bad@outlook.com" in rejected_emails
    # Security review test gap (2026-09-30): the ONLY rejection examples
    # here used to be gmail.com/outlook.com, which contain no "@ua.edu"
    # substring at all -- so a mutant that changed the domain check from
    # `.endswith(suffixes)` to `any(s in email for s in suffixes)` would
    # have passed this test while silently accepting every lookalike
    # domain. "foo@ua.edu.evil.com" DOES contain "@ua.edu" as a
    # substring but must still be rejected -- exact suffix anchoring is
    # the entire point of the check.
    assert "foo@ua.edu.evil.com" in rejected_emails
    for _email, reason in result.rejected:
        assert "crimson.ua.edu or ua.edu" in reason
    # Rejected emails are never silently added.
    stored = {e.email for e in app_module.list_preauthorized(config)}
    assert "bad@gmail.com" not in stored
    assert "also-bad@outlook.com" not in stored
    assert "foo@ua.edu.evil.com" not in stored


def test_add_preauthorized_emails_dedupes_against_already_stored(app_module):
    config = app_module.CONFIG
    app_module.add_preauthorized_emails(config, "repeat@crimson.ua.edu")
    result = app_module.add_preauthorized_emails(
        config, "repeat@crimson.ua.edu, fresh@ua.edu"
    )
    assert result.added == ("fresh@ua.edu",)
    assert result.already_present == ("repeat@crimson.ua.edu",)
    # Still exactly one row for repeat@ -- no duplicate/crash on re-paste.
    matches = [
        e
        for e in app_module.list_preauthorized(config)
        if e.email == "repeat@crimson.ua.edu"
    ]
    assert len(matches) == 1


def test_add_preauthorized_emails_dedupes_against_already_redeemed(
    app_module, mocker, fake_response
):
    """Re-pasting someone who already redeemed must not error or create
    a second row -- it's a harmless no-op, correctly reported."""
    config = app_module.CONFIG
    email = "already-active@crimson.ua.edu"
    app_module.add_preauthorized_emails(config, email)
    mocker.patch(
        "app.httpx.post", return_value=fake_response({"key": "sk-preauth-redeemed"})
    )
    app_module.issue_initial_key(config, email)  # redeems it
    result = app_module.add_preauthorized_emails(config, email)
    assert result.added == ()
    assert result.already_present == (email,)


def test_is_preauthorized_true_for_unredeemed_entry(app_module):
    config = app_module.CONFIG
    app_module.add_preauthorized_emails(config, "waiting@ua.edu")
    assert app_module.is_preauthorized(config, "waiting@ua.edu") is True
    # Case/whitespace on the CALLER's side must also match.
    assert app_module.is_preauthorized(config, " Waiting@UA.EDU ") is True


def test_is_preauthorized_false_when_never_listed(app_module):
    config = app_module.CONFIG
    assert app_module.is_preauthorized(config, "nobody@ua.edu") is False


def test_is_preauthorized_false_once_redeemed(app_module, mocker, fake_response):
    config = app_module.CONFIG
    email = "redeem-once@crimson.ua.edu"
    app_module.add_preauthorized_emails(config, email)
    mocker.patch(
        "app.httpx.post", return_value=fake_response({"key": "sk-redeem-once"})
    )
    app_module.issue_initial_key(config, email)
    assert app_module.is_preauthorized(config, email) is False


def test_issue_initial_key_preauthorized_email_gets_active_students_key(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    email = "roster-student@crimson.ua.edu"
    app_module.add_preauthorized_emails(config, email)
    post_mock = mocker.patch(
        "app.httpx.post", return_value=fake_response({"key": "sk-roster-student"})
    )
    key = app_module.issue_initial_key(config, email)
    assert key == "sk-roster-student"
    assert post_mock.call_args.kwargs["json"]["team_id"] == config.students_team_id
    # Redeemed immediately, in the same call.
    entry = next(e for e in app_module.list_preauthorized(config) if e.email == email)
    assert entry.redeemed is True


def test_issue_initial_key_non_preauthorized_email_gets_pending(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    post_mock = mocker.patch(
        "app.httpx.post", return_value=fake_response({"key": "sk-not-on-roster"})
    )
    key = app_module.issue_initial_key(config, "walk-in@crimson.ua.edu")
    assert key == "sk-not-on-roster"
    assert post_mock.call_args.kwargs["json"]["team_id"] == config.pending_team_id


def test_mark_preauthorized_redeemed_is_atomic_under_concurrency(app_module):
    """Security review B1 (2026-09-30): the actual fix. Two real threads
    race the SAME UPDATE ... WHERE redeemed_at IS NULL for the same
    email -- sqlite's own write locking must ensure exactly one of them
    sees rowcount==1."""
    import threading

    config = app_module.CONFIG
    email = "claim-race@crimson.ua.edu"
    app_module.add_preauthorized_emails(config, email)

    results = []
    results_lock = threading.Lock()

    def worker():
        won = app_module.mark_preauthorized_redeemed(config, email)
        with results_lock:
            results.append(won)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == 8
    assert results.count(True) == 1
    assert results.count(False) == 7


def test_issue_initial_key_concurrent_first_logins_only_one_lands_active(
    app_module, mocker, fake_response
):
    """Security review B1 (2026-09-30) -- THE severe finding: two
    concurrent first logins for the SAME preauthorized email (a
    double-click, two tabs, a browser prefetch) used to both pass a
    check before either finished writing, each mint a real LiteLLM key,
    and then keys.email's PRIMARY KEY + INSERT OR REPLACE silently kept
    only the LAST one -- leaving the FIRST key ACTIVE, untracked by
    `keys`, invisible to list_issued_users()/`/admin`, and unreachable
    by demote_user() for its full 365-day duration. Reproduces the race
    with two real threads and a delay inside the mocked LiteLLM call to
    widen the window, and asserts the OUTCOME that actually matters:
    exactly one of the two /key/generate calls landed on the active
    (students) team, never both."""
    import threading
    import time as time_module

    config = app_module.CONFIG
    email = "race-condition@crimson.ua.edu"
    app_module.add_preauthorized_emails(config, email)

    generate_team_ids = []
    calls_lock = threading.Lock()

    def post_side_effect(url, **kwargs):
        if url.endswith("/key/generate"):
            with calls_lock:
                generate_team_ids.append(kwargs["json"]["team_id"])
                n = len(generate_team_ids)
            time_module.sleep(0.05)  # widen the race window
            return fake_response({"key": f"sk-race{n}"})
        raise AssertionError(f"unexpected POST to {url}")

    mocker.patch("app.httpx.post", side_effect=post_side_effect)

    results = []
    results_lock = threading.Lock()

    def worker():
        key = app_module.issue_initial_key(config, email)
        with results_lock:
            results.append(key)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == 2
    assert results[0] != results[1]
    assert len(generate_team_ids) == 2
    active_calls = [t for t in generate_team_ids if t == config.students_team_id]
    pending_calls = [t for t in generate_team_ids if t == config.pending_team_id]
    assert len(active_calls) == 1
    assert len(pending_calls) == 1
    # The roster entry is claimed exactly once, by whichever thread won.
    entry = next(e for e in app_module.list_preauthorized(config) if e.email == email)
    assert entry.redeemed is True


def test_revoke_and_reissue_concurrent_calls_no_orphaned_active_key(
    app_module, mocker, fake_response
):
    """Security review B1 (2026-09-30): the same check-then-act race
    exists in revoke_and_reissue() -- for an ALREADY-PROMOTED student,
    two concurrent /regenerate calls used to both read the same old
    key's team_id, both delete it, and both issue a new key onto that
    team, orphaning whichever one lost the `keys` table's last write.
    With _lock_for_email() serializing the whole function, the second
    call only starts once the first has fully committed, so every
    /key/delete call targets a key that is genuinely still the current
    one at the moment it runs -- never two deletes racing the same
    stale key."""
    import threading
    import time as time_module

    config = app_module.CONFIG
    email = "regen-race@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-regenold"):
        pass

    mocker.patch(
        "app.httpx.get",
        return_value=fake_response({"info": {"team_id": config.students_team_id}}),
    )

    generate_count = {"n": 0}
    count_lock = threading.Lock()
    delete_targets = []

    def post_side_effect(url, **kwargs):
        if url.endswith("/key/delete"):
            with count_lock:
                delete_targets.append(kwargs["json"]["keys"][0])
            return fake_response({"deleted_keys": kwargs["json"]["keys"]})
        if url.endswith("/key/generate"):
            with count_lock:
                generate_count["n"] += 1
                n = generate_count["n"]
            time_module.sleep(0.05)
            return fake_response({"key": f"sk-regennew{n}"})
        raise AssertionError(f"unexpected POST to {url}")

    mocker.patch("app.httpx.post", side_effect=post_side_effect)

    results = []
    results_lock = threading.Lock()

    def worker():
        key = app_module.revoke_and_reissue(config, email)
        with results_lock:
            results.append(key)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == 2
    # The two deletes must target DIFFERENT keys -- if the lock failed
    # to serialize, both would delete the SAME original "sk-regenold".
    assert len(set(delete_targets)) == 2
    # Whichever key is cached at the end is one of the two issued.
    final_cached = app_module.get_cached_key(config.db_path, email)
    assert final_cached in results


def test_issue_initial_key_holds_lock_across_entire_body(
    app_module, mocker, fake_response
):
    """Security review B1 hardening (2026-09-30): a refactor that
    narrowed _lock_for_email()'s scope -- e.g. releasing it before the
    LiteLLM call -- would silently reopen the race with no other test
    failing, since the concurrency tests above only check the OUTCOME.
    Assert the lock is actually HELD while the LiteLLM call happens, not
    just that concurrent calls happen to produce the right result."""
    config = app_module.CONFIG
    email = "lock-scope-initial@crimson.ua.edu"
    app_module.add_preauthorized_emails(config, email)
    lock = app_module._lock_for_email(email)

    def post_side_effect(url, **kwargs):
        assert lock.locked(), "LiteLLM call happened OUTSIDE the per-email lock"
        return fake_response({"key": "sk-lockscope"})

    mocker.patch("app.httpx.post", side_effect=post_side_effect)
    assert not lock.locked()
    app_module.issue_initial_key(config, email)
    assert not lock.locked()  # released afterward


def test_revoke_and_reissue_holds_lock_across_entire_body(
    app_module, mocker, fake_response
):
    config = app_module.CONFIG
    email = "lock-scope-regen@crimson.ua.edu"
    with mocker_seed_cache(app_module, config, email, "sk-lockold"):
        pass
    lock = app_module._lock_for_email(email)

    def get_side_effect(url, **kwargs):
        assert lock.locked(), "LiteLLM GET happened OUTSIDE the per-email lock"
        return fake_response({"info": {"team_id": config.pending_team_id}})

    def post_side_effect(url, **kwargs):
        assert lock.locked(), "LiteLLM POST happened OUTSIDE the per-email lock"
        if url.endswith("/key/delete"):
            return fake_response({"deleted_keys": kwargs["json"]["keys"]})
        return fake_response({"key": "sk-locknew"})

    mocker.patch("app.httpx.get", side_effect=get_side_effect)
    mocker.patch("app.httpx.post", side_effect=post_side_effect)
    assert not lock.locked()
    app_module.revoke_and_reissue(config, email)
    assert not lock.locked()  # released afterward


def test_index_preauthorized_first_login_is_active(
    app_module, client, mocker, fake_response
):
    config = app_module.CONFIG
    email = "http-roster@crimson.ua.edu"
    app_module.add_preauthorized_emails(config, email)
    mocker.patch.object(app_module, "verify_access_jwt", return_value=email)
    mocker.patch(
        "app.httpx.post", return_value=fake_response({"key": "sk-http-roster"})
    )
    mocker.patch(
        "app.httpx.get",
        return_value=fake_response(
            {
                "info": {"team_id": config.students_team_id},
                "team_info": {"models": ["qwen3.8-27b"]},
            }
        ),
    )
    resp = client.get("/", headers={"Cf-Access-Jwt-Assertion": "irrelevant-mocked"})
    assert resp.status_code == 200
    assert "sk-http-roster" in resp.text
    assert "not yet activated" not in resp.text


def test_remove_preauthorized_unredeemed_deletes_row(app_module):
    config = app_module.CONFIG
    app_module.add_preauthorized_emails(config, "remove-me@ua.edu")
    app_module.remove_preauthorized_email(config, "remove-me@ua.edu")
    assert app_module.list_preauthorized(config) == []


def test_remove_preauthorized_unknown_email_404(app_module):
    config = app_module.CONFIG
    with pytest.raises(HTTPException) as exc_info:
        app_module.remove_preauthorized_email(config, "never-added@ua.edu")
    assert exc_info.value.status_code == 404


def test_remove_preauthorized_redeemed_refuses_with_409(
    app_module, mocker, fake_response
):
    """Design decision (team-lead asked for one, deliberately): removing
    an already-redeemed entry is REFUSED, not auto-demoted -- see
    remove_preauthorized_email()'s docstring for the full rationale.
    The entry must still be there afterward, untouched, and no LiteLLM
    call may have been made."""
    config = app_module.CONFIG
    email = "already-live@crimson.ua.edu"
    app_module.add_preauthorized_emails(config, email)
    mocker.patch(
        "app.httpx.post", return_value=fake_response({"key": "sk-already-live"})
    )
    app_module.issue_initial_key(config, email)  # redeems it

    post_mock = mocker.patch("app.httpx.post")  # re-patch: must NOT be called below
    with pytest.raises(HTTPException) as exc_info:
        app_module.remove_preauthorized_email(config, email)
    assert exc_info.value.status_code == 409
    assert "Demote" in exc_info.value.detail
    post_mock.assert_not_called()
    # Still there, still redeemed -- refusal did not mutate anything.
    entry = next(e for e in app_module.list_preauthorized(config) if e.email == email)
    assert entry.redeemed is True


# ---------------------------------------------------------------------------
# HTTP-level /admin/preauthorize* routes
# ---------------------------------------------------------------------------


def test_admin_preauthorize_no_jwt_returns_401(client):
    resp = client.post(
        "/admin/preauthorize",
        data={"emails": "x@ua.edu"},
        headers=VALID_ORIGIN_HEADER,
    )
    assert resp.status_code == 401


def test_admin_preauthorize_remove_no_jwt_returns_401(client):
    resp = client.post(
        "/admin/preauthorize/remove",
        data={"target_email": "x@ua.edu"},
        headers=VALID_ORIGIN_HEADER,
    )
    assert resp.status_code == 401


def test_admin_preauthorize_non_admin_returns_403(app_module, client, mocker):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=NON_ADMIN_EMAIL)
    resp = client.post(
        "/admin/preauthorize",
        data={"emails": "x@crimson.ua.edu"},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 403
    assert app_module.is_preauthorized(app_module.CONFIG, "x@crimson.ua.edu") is False


def test_admin_preauthorize_remove_non_admin_returns_403(app_module, client, mocker):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=NON_ADMIN_EMAIL)
    resp = client.post(
        "/admin/preauthorize/remove",
        data={"target_email": "x@crimson.ua.edu"},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 403


def test_admin_preauthorize_route_happy_path_reports_rejections(
    app_module, client, mocker
):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    resp = client.post(
        "/admin/preauthorize",
        data={"emails": "good@crimson.ua.edu\nbad@gmail.com"},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 200
    assert "good@crimson.ua.edu" in resp.text
    assert "bad@gmail.com" in resp.text
    assert "Rejected" in resp.text
    assert app_module.is_preauthorized(app_module.CONFIG, "good@crimson.ua.edu") is True


def test_admin_preauthorize_remove_route_happy_path(app_module, client, mocker):
    config = app_module.CONFIG
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    app_module.add_preauthorized_emails(config, "route-remove@ua.edu")
    resp = client.post(
        "/admin/preauthorize/remove",
        data={"target_email": "route-remove@ua.edu"},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 200
    assert app_module.list_preauthorized(config) == []


def test_admin_index_shows_preauthorized_section(app_module, client, mocker):
    config = app_module.CONFIG
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    app_module.add_preauthorized_emails(config, "listed-roster@ua.edu")
    resp = client.get("/admin", headers={"Cf-Access-Jwt-Assertion": "irrelevant"})
    assert resp.status_code == 200
    assert "listed-roster@ua.edu" in resp.text
    assert "Waiting" in resp.text


# ---------------------------------------------------------------------------
# B3 delta (security review, 2026-09-30): the mutation (and its report --
# for /admin/preauthorize, the ONLY channel telling the admin what a
# paste did) must be computed and captured, and the roster must be read,
# INDEPENDENTLY of whatever the key list is doing. Forces
# list_issued_users() itself to raise (not just a per-row HTTPError) to
# isolate this from the per-row resilience fix already covered above.
# ---------------------------------------------------------------------------


def test_admin_preauthorize_reports_result_even_if_key_list_fails(
    app_module, client, mocker
):
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    mocker.patch.object(
        app_module, "list_issued_users", side_effect=RuntimeError("boom")
    )
    resp = client.post(
        "/admin/preauthorize",
        data={"emails": "good@crimson.ua.edu, bad@gmail.com"},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 200
    # The mutation's report -- both halves -- survives the key-list crash.
    assert "good@crimson.ua.edu" in resp.text
    assert "bad@gmail.com" in resp.text
    assert "unavailable" in resp.text.lower()
    # And the mutation genuinely applied, not just its report.
    assert app_module.is_preauthorized(app_module.CONFIG, "good@crimson.ua.edu") is True


def test_admin_preauthorize_remove_succeeds_even_if_key_list_fails(
    app_module, client, mocker
):
    config = app_module.CONFIG
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    app_module.add_preauthorized_emails(config, "remove-amid-failure@ua.edu")
    mocker.patch.object(
        app_module, "list_issued_users", side_effect=RuntimeError("boom")
    )
    resp = client.post(
        "/admin/preauthorize/remove",
        data={"target_email": "remove-amid-failure@ua.edu"},
        headers={"Cf-Access-Jwt-Assertion": "irrelevant", **VALID_ORIGIN_HEADER},
    )
    assert resp.status_code == 200
    assert app_module.list_preauthorized(config) == []  # the mutation applied
    assert "unavailable" in resp.text.lower()


def test_admin_index_shows_roster_even_if_key_list_fails(app_module, client, mocker):
    config = app_module.CONFIG
    mocker.patch.object(app_module, "verify_access_jwt", return_value=ADMIN_EMAIL)
    app_module.add_preauthorized_emails(config, "roster-visible@ua.edu")
    mocker.patch.object(
        app_module, "list_issued_users", side_effect=RuntimeError("boom")
    )
    resp = client.get("/admin", headers={"Cf-Access-Jwt-Assertion": "irrelevant"})
    assert resp.status_code == 200
    assert "roster-visible@ua.edu" in resp.text
    assert "unavailable" in resp.text.lower()
