"""Live integration test against a REAL LiteLLM proxy.

Opt-in only -- this hits a real server over the network and creates and
deletes real LiteLLM keys, so it never runs as part of the ordinary
`pytest` unit suite. It exists because the ordinary suite (test_app.py)
mocks httpx entirely, which is exactly why a real, shipped bug slipped
past it: LiteLLM's /key/update rejects a promotion for a key whose
user_id has no matching team-membership row (see the postmortem in
issue_key()'s docstring in app.py). A mocked httpx.post/.get always
"succeeds" regardless of payload -- only a real server can validate a
payload the way LiteLLM's own management endpoints actually do.

This test reproduces the PRODUCTION SHAPE end to end: it calls the
portal's own issue_key()/get_current_team_id()/team_grants_access()/
revoke_and_reissue() functions -- not hand-rolled curl -- against a real
LiteLLM instance, with a real team-membership check in the loop, using a
disposable synthetic identity (never a real student/faculty email).

Run explicitly, from the box, with the real .env sourced:

    cd appliances/gb10/keyportal
    set -a; source ../.env; set +a
    export LITELLM_BASE_URL=http://localhost:4000
    export KEYPORTAL_RUN_LIVE_TESTS=1
    python3 -m pytest tests/test_live_integration.py -v -s

Requires: LITELLM_BASE_URL, LITELLM_MASTER_KEY, PENDING_TEAM_ID,
STUDENTS_TEAM_ID (or FACULTY_TEAM_ID) already set in the environment
(exactly what `.env` provides), plus KEYPORTAL_RUN_LIVE_TESTS=1 as the
explicit "yes, hit the real server" opt-in.
"""

import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Captured at MODULE IMPORT time deliberately -- pytest imports every test
# module during collection, before any fixture (even a session-scoped
# autouse one) runs its body. conftest.py's `_required_env` autouse
# fixture overwrites LITELLM_BASE_URL/etc with fake unit-test values
# ("http://litellm.test:4000", which resolves nowhere); capturing the
# real values here, before that fixture ever executes, is what lets this
# file share a tests/ directory with the mocked suite without the real
# values getting clobbered.
_REQUIRED_LIVE_ENV = (
    "LITELLM_BASE_URL",
    "LITELLM_MASTER_KEY",
    "PENDING_TEAM_ID",
    "STUDENTS_TEAM_ID",
)
_REAL_ENV = {name: os.environ.get(name) for name in _REQUIRED_LIVE_ENV}

pytestmark = pytest.mark.skipif(
    os.environ.get("KEYPORTAL_RUN_LIVE_TESTS") != "1",
    reason=(
        "Live integration test against a real LiteLLM proxy -- opt-in "
        "only. Set KEYPORTAL_RUN_LIVE_TESTS=1 (with a real LITELLM_BASE_URL"
        "/LITELLM_MASTER_KEY/PENDING_TEAM_ID/STUDENTS_TEAM_ID sourced from "
        ".env) to run it."
    ),
)


@pytest.fixture(scope="module")
def live_config():
    import app as app_module

    missing = [name for name in _REQUIRED_LIVE_ENV if not _REAL_ENV.get(name)]
    if missing:
        pytest.skip(f"live test requires env vars: {', '.join(missing)}")

    return app_module.Config(
        litellm_base_url=_REAL_ENV["LITELLM_BASE_URL"],
        litellm_master_key=_REAL_ENV["LITELLM_MASTER_KEY"],
        pending_team_id=_REAL_ENV["PENDING_TEAM_ID"],
        students_team_id=_REAL_ENV["STUDENTS_TEAM_ID"],
        # Not exercised by this test file (it only covers the D11
        # promotion lifecycle, not the admin view) -- placeholders are
        # fine here, same as cf_access_aud below.
        faculty_team_id="unused-for-this-test",
        cf_access_team_domain="unused-for-this-test.cloudflareaccess.com",
        cf_access_aud="unused-for-this-test",
        allowed_email_suffixes=("@crimson.ua.edu", "@ua.edu"),
        admin_contact="Test Admin",
        admin_emails=("unused-for-this-test@ua.edu",),
        keyportal_hostname="unused-for-this-test.example",
        # 2026-09-30 fix: init_db() locks the db file's PARENT directory
        # down to 0700 (see its own docstring) -- a bare file directly
        # under /tmp made that target /tmp ITSELF, which os.chmod()
        # correctly refuses (PermissionError: Operation not permitted),
        # since chmod'ing a shared system directory to owner-only would
        # break it for every other process on the box. tempfile.mkdtemp()
        # creates a fresh directory this process already owns at 0700,
        # so init_db()'s chmod is a no-op on an already-correct target
        # rather than an attempt to relock a directory it does not own.
        db_path=os.path.join(
            tempfile.mkdtemp(prefix="keyportal-live-test-"), "keyportal.db"
        ),
    )


@pytest.fixture
def synthetic_email():
    # Never a real UA identity -- clearly synthetic and disposable.
    return f"live-integration-test-{uuid.uuid4().hex[:12]}@crimson.ua.edu"


def _delete_key(config, key):
    httpx.post(
        f"{config.litellm_base_url}/key/delete",
        headers={"Authorization": f"Bearer {config.litellm_master_key}"},
        json={"keys": [key]},
        timeout=15.0,
    )


def test_real_promotion_and_regenerate_lifecycle(live_config, synthetic_email):
    """The actual regression test for the 2026-09-29 promotion bug.

    Exercises the exact production call sequence:
      1. issue_key() into pending -- as a first-time portal visit does.
      2. Confirm pending: team_grants_access() is False.
      3. promote_user() -- the actual function admin_promote() and
         promote-user.sh call, not a hand-rolled request. This is
         TWO calls (_litellm_clear_legacy_user_id() then
         _litellm_set_team()), and the first of those two is the step
         that made the second one's /key/update 403 before the fix
         (see app.py's issue_key() docstring for the full postmortem)
         -- a test that skips straight to a single /key/update call
         never exercises the call this regression test exists for.
      4. Confirm active: team_grants_access() is True, SAME key string
         (no reissue).
      5. revoke_and_reissue() -- confirm it lands on the SAME (promoted)
         team, not pending; old key rejected by LiteLLM, new key active.

    2026-09-30 fix (security review round 5, audit finding, step 7):
    this test previously called httpx.post(/key/update) directly instead
    of promote_user() -- exercising only ONE of the two calls the real
    admin_promote() route makes, and specifically not the
    _litellm_clear_legacy_user_id() call the 2026-09-29 postmortem is
    actually about. Fixed to call promote_user() itself.
    """
    import app as app_module

    app_module.init_db(live_config.db_path)
    issued_keys = []
    try:
        # Step 1: issue into pending, exactly as index() does on a
        # first-time visit.
        key = app_module.issue_key(
            live_config, synthetic_email, live_config.pending_team_id
        )
        issued_keys.append(key)
        assert key.startswith("sk-")

        # Step 2: pending -- zero access.
        team_id = app_module.get_current_team_id(live_config, key)
        assert team_id == live_config.pending_team_id
        assert app_module.team_grants_access(live_config, team_id) is False

        # Step 3: promote via the REAL promote_user() -- the production
        # shape admin_promote()/promote-user.sh actually use, TWO calls
        # (_litellm_clear_legacy_user_id() then _litellm_set_team()), not
        # a hand-rolled single /key/update. The first of those two calls
        # is the step whose absence made the second one 403 with
        # {"error": "User=<email> is not a member of the team=<id>"}
        # before the fix (verified live, 2026-09-29, with the old
        # user_id=email payload -- see app.py's issue_key() docstring).
        # A test that only sent the second call could pass even if the
        # first one silently stopped happening.
        app_module.promote_user(live_config, synthetic_email, "students")

        # Step 4: active now, SAME key.
        team_id_after = app_module.get_current_team_id(live_config, key)
        assert team_id_after == _REAL_ENV["STUDENTS_TEAM_ID"]
        assert app_module.team_grants_access(live_config, team_id_after) is True

        # Step 5: regenerate must preserve the promoted team.
        new_key = app_module.revoke_and_reissue(live_config, synthetic_email)
        issued_keys.append(new_key)
        assert new_key != key
        new_team_id = app_module.get_current_team_id(live_config, new_key)
        assert new_team_id == _REAL_ENV["STUDENTS_TEAM_ID"]
        assert app_module.team_grants_access(live_config, new_team_id) is True

        # The OLD key must now be rejected -- LiteLLM keeps /key/info
        # returning 200 for a deleted key but flips status to "deleted"
        # (verified live, 2026-09-29: deleted_at/deleted_by get set,
        # status_code stays 200 -- do not assert on status_code here).
        old_key_info = httpx.get(
            f"{live_config.litellm_base_url}/key/info",
            headers={"Authorization": f"Bearer {live_config.litellm_master_key}"},
            params={"key": key},
            timeout=15.0,
        )
        # 2026-09-30 fix (security review round 5, audit finding, step 7):
        # this used to also assert `old_key_info.status_code == 200` --
        # which is true, but it asserts WHAT LITELLM DOES (a soft-delete
        # detail, confirmed live and stated three lines above as
        # observational context, not a requirement), not what this test
        # requires. The requirement is that the old key reads as
        # deleted; asserting the incidental status code alongside it is
        # exactly the "encodes what the code does rather than what the
        # requirement demands" pattern this whole review has been
        # naming -- if LiteLLM ever changed to a real 404 here instead
        # of a soft-delete 200, that would still correctly satisfy "the
        # old key is rejected", and the removed assertion would have
        # failed a change that made nothing worse.
        old_info = old_key_info.json().get("info", old_key_info.json())
        assert old_info.get("status") == "deleted"
    finally:
        for k in issued_keys:
            _delete_key(live_config, k)
        # Removes the whole mkdtemp() directory, not just the db file --
        # matches the fixture creating a dedicated directory rather than
        # a bare file, so nothing is left behind under /tmp.
        shutil.rmtree(os.path.dirname(live_config.db_path), ignore_errors=True)
