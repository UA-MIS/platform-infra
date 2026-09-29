"""UA-MIS Local LLM self-service key portal.

Implements D11 (artifacts/design/2026-09-28-gb10-local-llm-design.md, S4.3):
a first-time authenticated UA identity (crimson or ua.edu) gets a real
LiteLLM key immediately, but that key is placed in the `pending` team,
which grants zero model access. An admin promotes a person later by
changing only their key's team_id in LiteLLM's admin UI/API -- this
portal deliberately never bakes models/limits onto the key itself, and
never re-issues a key on promotion. Every page load re-checks the key's
CURRENT team live; it never assumes "issued" means "working".

See also: artifacts/planning/2026-09-28-gb10-local-llm-plan-a.md Task 12.
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from html import escape
from typing import Optional

import httpx
import jwt
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from jwt import PyJWKClient

# The onboarding scripts already live in this same repo/branch -- link to
# them rather than duplicating their install instructions here.
ONBOARDING_URL = (
    "https://github.com/UA-MIS/platform-infra/tree/gb10-appliance"
    "/appliances/gb10/onboarding"
)
MODEL_NAME = "qwen3.8-27b"
MODEL_ENDPOINT = "https://local-llm.uamishub.com/v1"
# Keep this in lockstep with onboarding/setup-macos-linux.sh's build_block()
# and setup-windows.ps1. "agent" was added after tool calling started
# working on vLLM (--enable-auto-tool-choice / --tool-call-parser=
# qwen3_xml, see docker-compose.yml's vllm service). The onboarding
# scripts still say `[chat, edit, apply]` as of this writing and are
# known-stale (Task 12 team-lead brief, 2026-09-29) -- do not "fix" this
# constant to match them; fix them to match this instead.
CONTINUE_ROLES = "[chat, edit, apply, agent]"


def _require_env(name: str, *, hint: str = "") -> str:
    """Read a required env var, failing loudly if it is unset OR blank.

    Blank matters as much as missing: docker-compose.yml passes through
    CF_ACCESS_AUD=${CF_ACCESS_AUD_KEYPORTAL}, which is *present* but
    empty until the owner fills CF_ACCESS_AUD_KEYPORTAL into .env -- a
    bare `os.environ[name]` lookup would not catch that, and silently
    running with an empty audience would mean JWT verification never
    actually authenticates anyone. Raising here means the container
    exits non-zero and `docker compose ps` shows it restart-looping
    with this message in `docker compose logs keyportal`, instead of
    quietly serving keys to anyone who can reach the port.
    """
    value = os.environ.get(name, "").strip()
    if not value:
        message = f"{name} is unset or blank -- keyportal refuses to start without it."
        if hint:
            message = f"{message} {hint}"
        raise RuntimeError(message)
    return value


@dataclass(frozen=True)
class Config:
    litellm_base_url: str
    litellm_master_key: str
    pending_team_id: str
    students_team_id: str
    faculty_team_id: str
    cf_access_team_domain: str
    cf_access_aud: str
    allowed_email_suffixes: tuple
    admin_contact: str
    admin_emails: tuple
    db_path: str

    @property
    def jwks_url(self) -> str:
        return f"https://{self.cf_access_team_domain}/cdn-cgi/access/certs"


def load_config() -> Config:
    return Config(
        litellm_base_url=_require_env("LITELLM_BASE_URL"),
        litellm_master_key=_require_env("LITELLM_MASTER_KEY"),
        pending_team_id=_require_env("PENDING_TEAM_ID"),
        students_team_id=_require_env("STUDENTS_TEAM_ID"),
        faculty_team_id=_require_env("FACULTY_TEAM_ID"),
        cf_access_team_domain=_require_env("CF_ACCESS_TEAM_DOMAIN"),
        cf_access_aud=_require_env(
            "CF_ACCESS_AUD",
            hint=(
                "Set CF_ACCESS_AUD_KEYPORTAL in .env on the box to the "
                "Application Audience Tag from Cloudflare Zero Trust > "
                "Access > Applications > local-llm-keys.uamishub.com, "
                "then run: docker compose up -d keyportal"
            ),
        ),
        allowed_email_suffixes=tuple(
            s.strip()
            for s in os.environ.get(
                "ALLOWED_EMAIL_SUFFIXES", "@crimson.ua.edu,@ua.edu"
            ).split(",")
            if s.strip()
        ),
        admin_contact=os.environ.get("ADMIN_CONTACT", "your course instructor"),
        admin_emails=_load_admin_emails(),
        db_path=os.environ.get("KEYPORTAL_DB_PATH", "/data/keyportal.db"),
    )


def _load_admin_emails() -> tuple:
    """Same "fail loudly, not silently" contract as CF_ACCESS_AUD (see
    _require_env's docstring): an admin panel that comes up with an empty
    allowlist would be an admin panel open to every crimson.ua.edu/ua.edu
    visitor, not a disabled one -- so this must raise, never fall back to
    "nobody's an admin" or "everybody is." Matched case-insensitively and
    whitespace-stripped in require_admin(), since CF Access email
    casing/whitespace is not something this service controls.
    """
    hint = (
        "Set ADMIN_EMAILS in .env on the box to a comma-separated list of "
        "the UA identities allowed to see /admin, e.g. "
        "ADMIN_EMAILS=labmx@ua.edu,someone@crimson.ua.edu -- then run: "
        "docker compose up -d keyportal"
    )
    raw = _require_env("ADMIN_EMAILS", hint=hint)
    emails = tuple(e.strip().lower() for e in raw.split(",") if e.strip())
    if not emails:
        # raw was non-blank (_require_env already checked that) but
        # contained nothing except commas/whitespace, e.g. " , " --
        # same failure as unset, just spelled differently.
        raise RuntimeError(
            f"ADMIN_EMAILS is unset or blank -- keyportal refuses to start without it. {hint}"
        )
    return emails


def init_db(db_path: str) -> None:
    """Create the keys table if needed, and lock the db file down to
    owner-only (0600) and its parent directory to 0700.

    This file holds RAW LiteLLM keys in the clear (see issue_key()) --
    a deliberate tradeoff for the "come back to this page and see your
    key again" UX, not an oversight. Tightening permissions is the one
    mitigation available at this layer; see README.md's "Key storage"
    section for the full tradeoff and who else can already reach this
    file (docker/root on the box).
    """
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
        os.chmod(parent, 0o700)
    with closing(sqlite3.connect(db_path)) as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS keys (
                email TEXT PRIMARY KEY,
                litellm_key TEXT NOT NULL,
                key_id TEXT NOT NULL,
                created_at REAL NOT NULL
            )"""
        )
        # Roster pre-authorization (team-lead brief, 2026-09-30): an admin
        # pastes a class roster before anyone has signed in. redeemed_at
        # is NULL until that email's first real login -- see
        # is_preauthorized()/issue_initial_key(). No litellm_key column
        # here on purpose: this table only ever holds emails an admin
        # typed in, never a credential.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS preauthorized (
                email TEXT PRIMARY KEY,
                added_at REAL NOT NULL,
                redeemed_at REAL
            )"""
        )
        conn.commit()
    os.chmod(db_path, 0o600)


def verify_access_jwt(
    request: Request, config: Config, jwks_client: PyJWKClient
) -> str:
    """Validate Cloudflare Access's JWT ourselves -- never just trust the
    Cf-Access-Authenticated-User-Email header.

    That header is only safe to trust if nothing can ever reach this
    service except through cloudflared -- an assumption about network
    topology, not a guarantee. Verifying the signed assertion here means
    a stray public route added later (e.g. a hand-edited Cloudflare
    ingress rule) still cannot get a key out of this service without a
    signature- and audience-valid token from CF_ACCESS_TEAM_DOMAIN.
    """
    assertion = request.headers.get("Cf-Access-Jwt-Assertion")
    if not assertion:
        raise HTTPException(
            status_code=401, detail="Missing Cloudflare Access assertion"
        )
    try:
        signing_key = jwks_client.get_signing_key_from_jwt(assertion)
        claims = jwt.decode(
            assertion,
            signing_key.key,
            algorithms=["RS256"],
            audience=config.cf_access_aud,
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid Access assertion: {exc}")
    email = claims.get("email", "")
    if not email.endswith(config.allowed_email_suffixes):
        raise HTTPException(
            status_code=403, detail="Not a crimson.ua.edu or ua.edu account"
        )
    return email


_ADMIN_FORBIDDEN_DETAIL = "Not authorized"


def require_admin(email: str, config: Config) -> None:
    """Fail closed: only a verified email on the ADMIN_EMAILS allowlist
    may proceed past this call. Matched case-insensitively and with
    whitespace stripped, since CF Access's email claim casing is not
    something this service controls and config.admin_emails is already
    normalized the same way by _load_admin_emails().

    Every /admin* route calls this immediately after verify_access_jwt
    and before doing anything else (looking up a user, touching
    LiteLLM, etc.) -- a non-admin gets the exact same 403 with the exact
    same detail message regardless of which route or payload they hit,
    so nothing about the response shape lets a non-admin distinguish
    "you're not an admin" from "you're not an admin AND also got
    something else wrong." Do not add route- or payload-specific detail
    to this error.
    """
    if email.strip().lower() not in config.admin_emails:
        raise HTTPException(status_code=403, detail=_ADMIN_FORBIDDEN_DETAIL)


def get_cached_key(db_path: str, email: str) -> Optional[str]:
    with closing(sqlite3.connect(db_path)) as conn:
        row = conn.execute(
            "SELECT litellm_key FROM keys WHERE email = ?", (email,)
        ).fetchone()
        return row[0] if row else None


def issue_key(config: Config, email: str, team_id: str) -> str:
    """Issue a key into `team_id`.

    Deliberately does NOT set models/rpm_limit/tpm_limit/
    max_parallel_requests on the key itself -- those are left unset so
    the key inherits whatever its CURRENT team allows. That is what
    makes promotion-without-reissue (D11) work at all, and symmetrically
    what makes revoke_and_reissue() below safe to call on an
    already-promoted key without silently un-promoting it.

    Deliberately does NOT set `user_id` either, even though it's tempting
    to bind the key to the visitor's email for traceability -- DO NOT
    ADD THIS BACK. `email` is carried in `key_alias`/`metadata` instead.

    This was a real, shipped bug (2026-09-29): a key generated with
    `user_id=email` gets that string written onto
    LiteLLM_VerificationToken.user_id, but /key/generate does NOT create
    a matching LiteLLM_UserTable row for an arbitrary string -- so no
    team membership can ever exist for it. LiteLLM's /key/update then
    hard-fails every promotion with `User=<email> is not a member of the
    team=<team_id>` (see key_management_endpoints.py's
    `_get_user_in_team`, which is only even consulted `if key.user_id is
    not None`). /team/member_add doesn't fix it either: given
    `user_email` for a user who doesn't already exist, LiteLLM mints a
    *new* User row with a fresh random UUID as user_id -- which will
    never equal the email string sitting on the key, permanently. Omit
    `user_id` and the whole membership check is skipped (`key.user_id is
    None`), which is exactly what `provision-teams.sh` already does for
    the `ungraded` key -- this makes the portal consistent with that,
    not a new pattern. Verified live against this deployment's actual
    LiteLLM 1.103.0, both ways: with `user_id` set, `/key/update
    {"team_id": ...}` 403s; without it, the same call succeeds in one
    step, same key string, team_id flips immediately.
    """
    resp = httpx.post(
        f"{config.litellm_base_url}/key/generate",
        headers={"Authorization": f"Bearer {config.litellm_master_key}"},
        json={
            "team_id": team_id,
            "key_alias": email,
            "metadata": {"portal_email": email},
            "duration": "365d",
        },
        timeout=15.0,
    )
    resp.raise_for_status()
    data = resp.json()
    key = data["key"]
    key_id = data.get("token_id") or data.get("key_name") or email
    with closing(sqlite3.connect(config.db_path)) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO keys (email, litellm_key, key_id, created_at) "
            "VALUES (?, ?, ?, ?)",
            (email, key, key_id, time.time()),
        )
        conn.commit()
    return key


def get_current_team_id(config: Config, key: str) -> Optional[str]:
    """Look up a key's CURRENT team_id, live, from LiteLLM.

    Verified live against this deployment's actual LiteLLM build
    (2026-09-29): GET /key/info nests key fields under "info" --
    {"info": {..., "team_id": "..."}}. Handled defensively (falls back
    to a flat shape) in case a future LiteLLM version changes this.

    Passes the key's SHA256 hash, never the raw key, as the `key` query
    parameter -- security review finding F4 (2026-09-30). LiteLLM's own
    /key/info docs say exactly this: "Pass the key's sha256 hash so the
    raw key stays out of URLs and access logs" (a query parameter is
    recorded verbatim by any HTTP access log in front of the proxy,
    unlike a POST body). Verified live: a hash lookup returns the
    identical `info` as a raw-key lookup for the same key. This is the
    ONLY place in this file that ever put a raw key in a URL -- every
    other LiteLLM call (/key/generate, /key/update, /key/delete) already
    sends the key in a JSON body, not a query string.
    """
    key_hash = hashlib.sha256(key.encode()).hexdigest()
    resp = httpx.get(
        f"{config.litellm_base_url}/key/info",
        headers={"Authorization": f"Bearer {config.litellm_master_key}"},
        params={"key": key_hash},
        timeout=15.0,
    )
    resp.raise_for_status()
    data = resp.json()
    key_info = data.get("info", data)
    return key_info.get("team_id")


def team_grants_access(config: Config, team_id: Optional[str]) -> bool:
    """A team "grants access" if it is not the pending team AND its model
    list is non-empty.

    Verified live (2026-09-29): GET /team/info returns
    {"team_id": ..., "team_info": {..., "models": [...]}, "keys": [...]}
    -- the pending team's team_info.models is [], a promoted team's (e.g.
    students) is ["qwen3.8-27b"]. Handled defensively (flat-shape
    fallback) in case a future LiteLLM version changes this.
    """
    if not team_id or team_id == config.pending_team_id:
        return False
    resp = httpx.get(
        f"{config.litellm_base_url}/team/info",
        headers={"Authorization": f"Bearer {config.litellm_master_key}"},
        params={"team_id": team_id},
        timeout=15.0,
    )
    resp.raise_for_status()
    data = resp.json()
    team_info = data.get("team_info", data)
    return len(team_info.get("models") or []) > 0


def revoke_and_reissue(config: Config, email: str) -> str:
    """Regenerate a key IN PLACE ON ITS CURRENT TEAM.

    This looks up the OLD key's live team_id BEFORE deleting it, and
    re-issues the new key into that SAME team -- it never defaults to
    PENDING_TEAM_ID. An already-promoted student clicking "Regenerate"
    must stay promoted; silently dropping them back to `pending` would
    be a strictly worse bug than the one the key-caching design exists
    to avoid (a support ticket that reads as "activation didn't work"
    instead of one that reads as "I lost my key").
    """
    old_key = get_cached_key(config.db_path, email)
    team_id = config.pending_team_id
    if old_key:
        team_id = get_current_team_id(config, old_key) or config.pending_team_id
        delete_resp = httpx.post(
            f"{config.litellm_base_url}/key/delete",
            headers={"Authorization": f"Bearer {config.litellm_master_key}"},
            json={"keys": [old_key]},
            timeout=15.0,
        )
        # Security review F2 (2026-09-30): a silently-failed delete here
        # is exactly how a stale row that no longer matches a live
        # LiteLLM key ends up sitting in `keys` -- the old key would
        # still exist in LiteLLM (never actually deleted) while a NEW
        # key also gets issued and cached below, or worse, the delete
        # partially succeeds server-side but reports failure. Fail
        # loudly here instead of proceeding to issue a second key on
        # top of an old one whose deletion status is unknown.
        delete_resp.raise_for_status()
    return issue_key(config, email, team_id)


# ---------------------------------------------------------------------------
# Admin: list issued users, promote/demote. This is a straight port of
# promote-user.sh's verified-live logic into the portal itself (team-lead
# brief, 2026-09-29) -- same two LiteLLM calls, same reason for two calls,
# same idempotency. See promote-user.sh's own header comment for the full
# postmortem on why step 1 (clearing user_id) is not optional.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IssuedUser:
    """Everything /admin is allowed to show about one issued key --
    deliberately has NO field for the raw key itself. render_admin_page()
    only ever receives IssuedUser instances, never a raw key string, so
    there is no code path in the admin view that could leak one, not even
    by accident.

    `lookup_error` is set (security review F2, 2026-09-30) when LiteLLM
    no longer recognizes this row's key -- deleted out-of-band through
    LiteLLM's own UI, expired past issue_key()'s 365d duration, or left
    behind by a delete that failed partway. Such a row is shown, not
    hidden: an admin needs to SEE a broken row to clean it up, and a
    silently-dropped row is how someone concludes a student "isn't in
    the system" instead of "is stuck."
    """

    email: str
    team_id: Optional[str]
    team_label: str
    active: bool
    created_at: float
    lookup_error: Optional[str] = None

    @property
    def stale(self) -> bool:
        return self.lookup_error is not None


def _team_label(team_id: Optional[str], config: Config) -> str:
    if team_id == config.pending_team_id:
        return "pending"
    if team_id == config.students_team_id:
        return "students"
    if team_id == config.faculty_team_id:
        return "faculty"
    if not team_id:
        return "(none)"
    return team_id


def list_issued_users(config: Config) -> list:
    """Every user the portal has ever issued a key to, newest first, with
    their CURRENT team looked up live from LiteLLM (same "never assume
    issued means working" rule as index() -- an admin viewing a stale
    cached state would be worse than an admin viewing nothing). The raw
    `litellm_key` from the keys table never leaves this function.

    Security review F2 (2026-09-30): a per-row LiteLLM lookup failure
    (a key LiteLLM no longer recognizes -- deleted out-of-band, expired
    past 365d, or left dangling by a failed delete) used to raise
    unhandled, which 500'd this ENTIRE function -- permanently, for as
    long as that one row existed. Concretely that meant (a) GET /admin
    was unusable for EVERY admin, and (b) inside admin_promote(),
    promote_user() would run and SUCCEED and then this call would still
    throw, so a successful promotion was reported as a failure with no
    way to tell what state the student was actually left in. A per-row
    failure is now caught and rendered as an explicit stale row (see
    IssuedUser.lookup_error) instead of aborting the whole listing.

    Also caches team_grants_access() per team_id within one call --
    there are only a handful of distinct teams (pending/students/
    faculty) no matter how many rows are in `keys`, so a 300-row roster
    now costs at most 300 /key/info calls plus a few /team/info calls,
    not 300 of each, repeated on every /admin load and every promote/
    demote.
    """
    with closing(sqlite3.connect(config.db_path)) as conn:
        rows = conn.execute(
            "SELECT email, litellm_key, created_at FROM keys ORDER BY created_at DESC"
        ).fetchall()
    team_active_cache: dict = {}
    users = []
    for email, key, created_at in rows:
        try:
            team_id = get_current_team_id(config, key)
            if team_id not in team_active_cache:
                team_active_cache[team_id] = team_grants_access(config, team_id)
            active = team_active_cache[team_id]
        except httpx.HTTPError as exc:
            users.append(
                IssuedUser(
                    email=email,
                    team_id=None,
                    team_label="(unknown -- LiteLLM does not recognize this key)",
                    active=False,
                    created_at=created_at,
                    lookup_error=str(exc),
                )
            )
            continue
        users.append(
            IssuedUser(
                email=email,
                team_id=team_id,
                team_label=_team_label(team_id, config),
                active=active,
                created_at=created_at,
            )
        )
    return users


def _litellm_clear_legacy_user_id(config: Config, key: str) -> None:
    """Step 1 of promote-user.sh, verbatim: POST /key/update with
    user_id explicitly set to None. A no-op for any key issued by the
    current issue_key() (which never sets user_id), and the fix for any
    key issued before the 2026-09-29 postmortem in issue_key()'s
    docstring. Always sends user_id=None here -- NEVER the email or any
    other non-None value; that is the exact bug this exists to undo."""
    resp = httpx.post(
        f"{config.litellm_base_url}/key/update",
        headers={"Authorization": f"Bearer {config.litellm_master_key}"},
        json={"key": key, "user_id": None},
        timeout=15.0,
    )
    resp.raise_for_status()


def _litellm_set_team(config: Config, key: str, team_id: str) -> None:
    """Step 2 of promote-user.sh, verbatim: POST /key/update with only
    team_id -- no user_id field at all in this call's payload. No key
    reissue, so an already-promoted user re-promoted to the same team is
    a harmless no-op (LiteLLM just re-writes the same value)."""
    resp = httpx.post(
        f"{config.litellm_base_url}/key/update",
        headers={"Authorization": f"Bearer {config.litellm_master_key}"},
        json={"key": key, "team_id": team_id},
        timeout=15.0,
    )
    resp.raise_for_status()


def promote_user(config: Config, email: str, target: str) -> None:
    """Move `email`'s existing key onto the students or faculty team --
    never reissues the key (see module docstring's D11 contract).
    Idempotent: promoting an already-promoted user re-sends the same two
    calls with the same target team_id, which LiteLLM accepts as a no-op
    (same key, same team, no new membership row, no new key).
    """
    if target not in ("students", "faculty"):
        raise HTTPException(
            status_code=400, detail="target must be 'students' or 'faculty'"
        )
    team_id = (
        config.students_team_id if target == "students" else config.faculty_team_id
    )
    key = get_cached_key(config.db_path, email)
    if not key:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No key issued for {email} -- they haven't visited the "
                f"portal yet, so there is nothing to promote."
            ),
        )
    _litellm_clear_legacy_user_id(config, key)
    _litellm_set_team(config, key, team_id)


def demote_user(config: Config, email: str) -> None:
    """Move `email`'s existing key back onto the pending team -- same
    two-call shape, same idempotency, as promote_user()."""
    key = get_cached_key(config.db_path, email)
    if not key:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No key issued for {email} -- they haven't visited the "
                f"portal yet, so there is nothing to demote."
            ),
        )
    _litellm_clear_legacy_user_id(config, key)
    _litellm_set_team(config, key, config.pending_team_id)


# ---------------------------------------------------------------------------
# Pre-authorization: an admin pastes a class roster BEFORE anyone has
# signed in (team-lead brief, 2026-09-30). "Manually adding people by
# email" turned out to mean two different things -- promote_user/
# demote_user above cover promoting someone already sitting in
# `pending`; this covers authorizing someone who hasn't visited yet, so
# their FIRST login lands them directly on the students team instead of
# pending. One mechanism, both flows: pasting 60 emails before the first
# lab is just this with a big textarea.
# ---------------------------------------------------------------------------

# Deliberately targets the students team only -- the described use case
# (team-lead brief) is "paste a class roster before the first lab."
# Pre-authorizing a faculty member ahead of time is not a use case
# anyone has asked for; if it comes up, this is the one constant to
# extend into a form field, not a design that needs restructuring.
_PREAUTHORIZE_TARGET_TEAM_ATTR = "students_team_id"


@dataclass(frozen=True)
class PreauthorizedEntry:
    """One roster row for the admin view. `redeemed_at` is None until
    that email's first real login (see issue_initial_key())."""

    email: str
    added_at: float
    redeemed_at: Optional[float]

    @property
    def redeemed(self) -> bool:
        return self.redeemed_at is not None


@dataclass(frozen=True)
class PreauthorizeResult:
    """What happened to one textarea paste -- shown back to the admin so
    a typo in a 60-line paste is never silently dropped."""

    added: tuple
    already_present: tuple
    rejected: tuple  # tuple of (email, reason) pairs


def _split_pasted_emails(raw_text: str) -> list:
    """Newline AND/OR comma separated -- people paste out of Excel and
    Canvas and the separators are never consistent. Trim, lowercase,
    drop blanks; does NOT dedupe (add_preauthorized_emails() does that
    against both this paste and the existing table in one pass)."""
    return [e.strip().lower() for e in re.split(r"[,\n]+", raw_text) if e.strip()]


def add_preauthorized_emails(config: Config, raw_text: str) -> PreauthorizeResult:
    """Parse, normalize, validate, and store a pasted roster.

    Order of operations matters for correct reporting: reject invalid
    domains BEFORE checking "already stored", so a re-pasted invalid
    address is reported as rejected (actionable: "this is a typo"), not
    silently swallowed as "already present". Dedupes both within THIS
    paste (a roster copy/pasted twice) and against rows already in the
    table (redeemed or not -- either way there is nothing new to do).
    """
    candidates = _split_pasted_emails(raw_text)
    seen_this_paste = set()
    to_insert = []
    rejected = []
    for email in candidates:
        if email in seen_this_paste:
            continue
        seen_this_paste.add(email)
        if not email.endswith(config.allowed_email_suffixes):
            rejected.append((email, "not a crimson.ua.edu or ua.edu address"))
            continue
        to_insert.append(email)

    added = []
    already_present = []
    with closing(sqlite3.connect(config.db_path)) as conn:
        for email in to_insert:
            existing = conn.execute(
                "SELECT 1 FROM preauthorized WHERE email = ?", (email,)
            ).fetchone()
            if existing:
                already_present.append(email)
                continue
            conn.execute(
                "INSERT INTO preauthorized (email, added_at, redeemed_at) "
                "VALUES (?, ?, NULL)",
                (email, time.time()),
            )
            added.append(email)
        conn.commit()
    return PreauthorizeResult(
        added=tuple(added),
        already_present=tuple(already_present),
        rejected=tuple(rejected),
    )


def list_preauthorized(config: Config) -> list:
    with closing(sqlite3.connect(config.db_path)) as conn:
        rows = conn.execute(
            "SELECT email, added_at, redeemed_at FROM preauthorized "
            "ORDER BY added_at DESC"
        ).fetchall()
    return [PreauthorizedEntry(email=e, added_at=a, redeemed_at=r) for e, a, r in rows]


def is_preauthorized(config: Config, email: str) -> bool:
    """True only for an email on the list that has NOT redeemed it yet.
    A redeemed entry answers False here -- it has already done its one
    job (see issue_initial_key()); is_preauthorized() is never consulted
    again for a returning visitor, since index() only calls it when
    get_cached_key() found nothing.
    """
    with closing(sqlite3.connect(config.db_path)) as conn:
        row = conn.execute(
            "SELECT redeemed_at FROM preauthorized WHERE email = ?",
            (email.strip().lower(),),
        ).fetchone()
    return row is not None and row[0] is None


def mark_preauthorized_redeemed(config: Config, email: str) -> None:
    with closing(sqlite3.connect(config.db_path)) as conn:
        conn.execute(
            "UPDATE preauthorized SET redeemed_at = ? WHERE email = ? "
            "AND redeemed_at IS NULL",
            (time.time(), email.strip().lower()),
        )
        conn.commit()


def issue_initial_key(config: Config, email: str) -> str:
    """Issue a brand-new visitor's first key. This is the ONLY place
    pre-authorization has any effect: index() only calls this when
    get_cached_key() found nothing, so a returning visitor's existing
    key (and its current team, whatever an admin has since set it to)
    is never touched by this function.

    Pending by default -- unless `email` is on the pre-authorized list
    and hasn't redeemed it yet, in which case they get an ACTIVE
    students-team key immediately and the entry is marked redeemed in
    the same call. No separate "reissue" step, ever: this is the one
    and only issue_key() call for this visitor, straight onto the
    right team from the start.
    """
    if is_preauthorized(config, email):
        team_id = getattr(config, _PREAUTHORIZE_TARGET_TEAM_ATTR)
        key = issue_key(config, email, team_id)
        mark_preauthorized_redeemed(config, email)
        return key
    return issue_key(config, email, config.pending_team_id)


def remove_preauthorized_email(config: Config, email: str) -> None:
    """Take an email back off the pre-authorized list.

    Design decision (team-lead brief explicitly asked for one, with a
    reason): an UNREDEEMED entry is just deleted -- nothing else has
    happened yet, so there is nothing else to undo. A REDEEMED entry is
    REFUSED (409) rather than silently auto-demoted, on purpose:

    - "Remove from the roster list" and "revoke someone's live,
      currently-working key" are two different admin intentions that
      happen to share a button if we let this one silently cascade.
      An admin cleaning up a stale roster paste (e.g. removing a
      preauthorized-but-never-used duplicate) should never have that
      accidentally cut off a *different* student's live session just
      because their email happened to already be marked redeemed.
    - This mirrors the rest of this file's "fail loudly, never
      silently" contract (_require_env, require_admin's fail-closed
      startup check, D11's "never assume issued means working"): an
      action with a real side effect on a live key gets its own
      explicit, named button (Demote, already in the issued-users
      table above), not a side door.
    - The 409 message says exactly what to do instead, so this is a
      one-extra-click cost for the admin, not a dead end.
    """
    email = email.strip().lower()
    with closing(sqlite3.connect(config.db_path)) as conn:
        row = conn.execute(
            "SELECT redeemed_at FROM preauthorized WHERE email = ?", (email,)
        ).fetchone()
        if row is None:
            raise HTTPException(
                status_code=404,
                detail=f"{email} is not on the pre-authorized list.",
            )
        redeemed_at = row[0]
        if redeemed_at is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{email} already redeemed this pre-authorization and has "
                    f"a live key. Removing it here would not revoke that key -- "
                    f"use Demote (in the issued-users table above) instead."
                ),
            )
        conn.execute("DELETE FROM preauthorized WHERE email = ?", (email,))
        conn.commit()


# Shared, plain, dependency-free CSS -- no framework, no CDN, no build
# step. UA crimson used sparingly as an accent (headings, links, the
# course-policy rule, button outline) -- not an attempt to reproduce an
# official UA page. The viewport meta tag (in _PAGE_HEAD) matters as much
# as this: without it, phones render at a virtual ~980px width and the
# font-size rules below are meaningless.
_STYLE = """
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; max-width: 680px; margin: 32px auto; padding: 0 16px; line-height: 1.55; color: #1a1a1a; background: #ffffff; overflow-wrap: break-word; word-wrap: break-word; }
h1 { color: #9E1B32; margin-bottom: 4px; font-size: 1.6rem; }
h2 { margin-top: 28px; font-size: 1.15rem; }
.intro { background: #faf9f7; border: 1px solid #e6e1da; padding: 16px 18px; border-radius: 8px; }
.policy { border-left: 4px solid #9E1B32; padding: 4px 0 4px 12px; margin: 16px 0; }
.pending { background: #fff3cd; border: 1px solid #ffe69c; padding: 16px; border-radius: 8px; }
pre { background: #f4f4f4; padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; border-radius: 6px; font-size: 0.9rem; }
code { background: #f0f0f0; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
button { padding: 10px 18px; cursor: pointer; font-size: 1rem; border-radius: 6px; border: 1px solid #9E1B32; background: #ffffff; color: #9E1B32; }
button:hover { background: #9E1B32; color: #ffffff; }
a { color: #7a1526; }
@media (max-width: 480px) {
  body { margin: 20px auto; }
  h1 { font-size: 1.4rem; }
}
"""


def _manual_config_block(api_key_placeholder: str = "&lt;your key&gt;") -> str:
    """The same shape as the personalized block below, but with a
    placeholder key -- shown to EVERY visitor (pending or active) so a
    beginner can see exactly what the file should look like even before
    their key is usable, without leaving this page."""
    return f"""models:
  - name: UA MIS Local
    provider: openai
    model: {MODEL_NAME}
    apiBase: {MODEL_ENDPOINT}
    apiKey: {api_key_placeholder}
    roles: {CONTINUE_ROLES}"""


def render_intro(email: str, config: Config) -> str:
    """The student-landing-page content, shown above the key section in
    BOTH the pending and active states (D-<team-lead-brief>, 2026-09-29):
    what this is, how to use it, honest performance expectations, the
    course-policy line, and who to contact. `config.admin_contact` is the
    ADMIN_CONTACT env var -- never hardcode a name here.
    """
    return f"""<h1>UA MIS Local LLM</h1>
<p>Signed in as <strong>{email}</strong>.</p>
<section class="intro">
<p>This is a private AI coding assistant that runs on a computer owned by
the MIS program. It's free for you to use, and your code and questions
are never sent to any outside company -- everything stays on this
machine.</p>

<h2>How to use it</h2>
<ol>
<li>Get your API key -- it's below on this page.</li>
<li>Install the free <strong>Continue</strong> extension in VS Code
(Extensions panel &rarr; search &quot;Continue&quot; &rarr; Install).</li>
<li>Paste the configuration below into <code>~/.continue/config.yaml</code>.</li>
</ol>
<p>Setup scripts that do steps 2 and 3 for you (macOS, Linux, Windows):
<a href="{ONBOARDING_URL}">{ONBOARDING_URL}</a></p>
<pre>{_manual_config_block()}</pre>

<h2>What to expect</h2>
<p>This one machine serves the whole MIS program -- it is not a
datacenter, and it is noticeably slower than ChatGPT or Claude. A full
answer usually takes <strong>30-60 seconds</strong>, and the text streams
in as it's generated rather than appearing all at once. That's normal,
not a sign that something is broken.</p>

<p class="policy"><strong>Course policy:</strong> using this tool does not override your course's rules on AI assistance -- always follow your
assignment's instructions.</p>

<p>Questions or problems? Contact <strong>{config.admin_contact}</strong>.</p>
</section>
<hr>
"""


_PAGE_HEAD = """<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UA-MIS Local LLM Key</title>
<style>{style}</style>"""


def render_page(email: str, key: str, active: bool, config: Config) -> str:
    intro = render_intro(email, config)
    head = _PAGE_HEAD.format(style=_STYLE)
    if not active:
        return f"""<!doctype html>
<html><head>{head}</head>
<body>
{intro}
<div class="pending">
<p><strong>Your key is issued but not yet activated -- contact
{config.admin_contact} to be added to a course team.</strong></p>
<p>Once you're added, come back to this same page -- the same key you
already have will start working, and you'll see the
<code>~/.continue/config.yaml</code> block to paste. You do not need to
do anything else right now, and you do not need to regenerate anything.</p>
</div>
</body></html>"""
    config_snippet = f"""models:
  - name: UA MIS Local
    provider: openai
    model: {MODEL_NAME}
    apiBase: {MODEL_ENDPOINT}
    apiKey: {key}
    roles: {CONTINUE_ROLES}
    # Deliberately no "autocomplete" role: GitHub Copilot Free already
    # handles inline completions; this shared GPU box shouldn't spend
    # capacity on every keystroke."""
    return f"""<!doctype html>
<html><head>{head}</head>
<body>
{intro}
<h2>Your key</h2>
<p>Your LiteLLM key:</p>
<pre id="key">{key}</pre>
<button type="button" onclick="navigator.clipboard.writeText(document.getElementById('key').textContent)">Copy key</button>
<p>Paste this into <code>~/.continue/config.yaml</code>:</p>
<pre>{config_snippet}</pre>
<form method="post" action="/regenerate">
<button type="submit">Regenerate key (invalidates the one above)</button>
</form>
</body></html>"""


def _fmt_issued_at(created_at: float) -> str:
    return datetime.fromtimestamp(created_at, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M UTC"
    )


def _admin_row(user: "IssuedUser") -> str:
    # escape() everywhere an email/team value lands in HTML -- these are
    # UA identities and LiteLLM team ids, not attacker-controlled in the
    # ordinary case, but this route is the one place on the whole site an
    # admin acts on OTHER people's data, so it gets the same treatment a
    # public-facing admin panel would.
    email = escape(user.email)
    if user.stale:
        # Security review F2 (2026-09-30): promote/demote on a row like
        # this would just fail too (they hit the same LiteLLM key that
        # /key/info already couldn't find), producing a confusing error
        # from a DIFFERENT code path than this one. Say so plainly and
        # don't offer buttons that can't work, rather than let an admin
        # discover that by clicking.
        state = "Unknown"
        state_class = "state-stale"
        actions = (
            '<span class="hint">Not recognized by LiteLLM -- promote/'
            "demote won't work on this row. Check LiteLLM's key "
            "list directly to clean it up.</span>"
        )
    else:
        state = "Active" if user.active else "Pending"
        state_class = "state-active" if user.active else "state-pending"
        actions = f"""<form method="post" action="/admin/promote">
<input type="hidden" name="target_email" value="{email}">
<input type="hidden" name="target_team" value="students">
<button type="submit">Promote: Students</button>
</form>
<form method="post" action="/admin/promote">
<input type="hidden" name="target_email" value="{email}">
<input type="hidden" name="target_team" value="faculty">
<button type="submit">Promote: Faculty</button>
</form>
<form method="post" action="/admin/demote">
<input type="hidden" name="target_email" value="{email}">
<button type="submit" class="demote">Demote to pending</button>
</form>"""
    return f"""<tr>
<td data-label="Email">{email}</td>
<td data-label="Team">{escape(user.team_label)}</td>
<td data-label="State"><span class="{state_class}">{state}</span></td>
<td data-label="Issued">{_fmt_issued_at(user.created_at)}</td>
<td data-label="Actions" class="actions">
{actions}
</td>
</tr>"""


def _preauth_row(entry: "PreauthorizedEntry") -> str:
    email = escape(entry.email)
    if entry.redeemed:
        status = '<span class="state-active">Redeemed</span>'
        action = '<span class="hint">Use Demote above to revoke</span>'
    else:
        status = '<span class="state-pending">Waiting</span>'
        action = f"""<form method="post" action="/admin/preauthorize/remove">
<input type="hidden" name="target_email" value="{email}">
<button type="submit" class="demote">Remove</button>
</form>"""
    return f"""<tr>
<td data-label="Email">{email}</td>
<td data-label="Added">{_fmt_issued_at(entry.added_at)}</td>
<td data-label="Status">{status}</td>
<td data-label="Actions" class="actions">{action}</td>
</tr>"""


def _preauth_result_banner(result: "PreauthorizeResult") -> str:
    parts = []
    if result.added:
        parts.append(
            f"<p><strong>Added ({len(result.added)}):</strong> "
            f"{escape(', '.join(result.added))}</p>"
        )
    if result.already_present:
        parts.append(
            f"<p><strong>Already on the list ({len(result.already_present)}):"
            f"</strong> {escape(', '.join(result.already_present))}</p>"
        )
    if result.rejected:
        rejected_str = ", ".join(f"{e} ({reason})" for e, reason in result.rejected)
        parts.append(
            f'<p class="policy"><strong>Rejected -- not a UA address '
            f"({len(result.rejected)}):</strong> {escape(rejected_str)}</p>"
        )
    if not parts:
        return ""
    return f'<div class="preauth-result">{"".join(parts)}</div>'


def render_admin_page(
    admin_email: str,
    users: list,
    preauthorized: list,
    config: Config,
    preauthorize_result: Optional["PreauthorizeResult"] = None,
) -> str:
    """The admin access-management view (team-lead brief, 2026-09-29 and
    2026-09-30): every user the portal has issued a key to (one-click
    promote/demote), plus the pre-authorized roster (one-click remove,
    or a "use Demote" hint for an already-redeemed entry -- see
    remove_preauthorized_email()'s docstring for why that's a refusal,
    not a silent auto-demote). Deliberately takes `users:
    list[IssuedUser]` and `preauthorized: list[PreauthorizedEntry]`,
    never raw rows or a raw key string -- see IssuedUser's docstring for
    why that is the actual mechanism that keeps a key from ever reaching
    this page. `preauthorize_result` is only set right after a POST
    /admin/preauthorize, to report exactly what happened to that paste.
    """
    head = _PAGE_HEAD.format(style=_STYLE + _ADMIN_STYLE)
    if users:
        rows = "\n".join(_admin_row(u) for u in users)
        table = f"""<table>
<thead><tr><th>Email</th><th>Team</th><th>State</th><th>Issued</th><th>Actions</th></tr></thead>
<tbody>
{rows}
</tbody>
</table>"""
    else:
        table = "<p>No one has visited the portal yet.</p>"

    if preauthorized:
        preauth_rows = "\n".join(_preauth_row(e) for e in preauthorized)
        preauth_table = f"""<table>
<thead><tr><th>Email</th><th>Added</th><th>Status</th><th>Actions</th></tr></thead>
<tbody>
{preauth_rows}
</tbody>
</table>"""
    else:
        preauth_table = "<p>No one is pre-authorized yet.</p>"

    result_banner = (
        _preauth_result_banner(preauthorize_result) if preauthorize_result else ""
    )

    return f"""<!doctype html>
<html><head>{head}</head>
<body>
<h1>UA MIS Local LLM &mdash; Admin</h1>
<p>Signed in as <strong>{escape(admin_email)}</strong>.</p>
<p>Every LiteLLM key ever issued by <a href="/">the student portal</a>.
The key itself is never shown here -- it's a bearer credential, and
promote/demote never need it.</p>
{table}

<h2>Pre-authorize a roster</h2>
<p>Paste emails below -- one per line, or comma-separated, mixed
separators are fine. Anyone on this list gets an <strong>active</strong>
key the moment they first sign in, skipping the pending step entirely.
Only @crimson.ua.edu / @ua.edu addresses are accepted; anything else is
rejected and reported below, not silently dropped.</p>
{result_banner}
<form method="post" action="/admin/preauthorize">
<textarea name="emails" rows="6" placeholder="student1@crimson.ua.edu, student2@crimson.ua.edu&#10;student3@ua.edu"></textarea>
<button type="submit">Add to pre-authorized list</button>
</form>
{preauth_table}
</body></html>"""


_ADMIN_STYLE = """
table { border-collapse: collapse; width: 100%; margin-top: 16px; font-size: 0.9rem; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e6e1da; vertical-align: top; }
th { color: #6b6b6b; font-weight: 600; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.03em; }
.state-active { color: #1a7a3c; font-weight: 600; }
.state-pending { color: #9a7b00; font-weight: 600; }
.state-stale { color: #9E1B32; font-weight: 600; }
td.actions { display: flex; flex-wrap: wrap; gap: 6px; }
td.actions form { margin: 0; }
td.actions button { padding: 6px 10px; font-size: 0.85rem; }
td.actions button.demote { border-color: #6b6b6b; color: #6b6b6b; }
td.actions button.demote:hover { background: #6b6b6b; color: #ffffff; }
.hint { color: #6b6b6b; font-size: 0.85rem; font-style: italic; }
textarea { width: 100%; box-sizing: border-box; font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 0.9rem; padding: 10px; border: 1px solid #e6e1da; border-radius: 6px; resize: vertical; }
.preauth-result { background: #f4f4f4; border-radius: 6px; padding: 4px 16px; margin: 12px 0; }
@media (max-width: 480px) {
  table, thead, tbody, th, td, tr { display: block; }
  thead { display: none; }
  tr { border-bottom: 2px solid #e6e1da; padding-bottom: 8px; margin-bottom: 8px; }
  td { border-bottom: none; padding: 4px 0; }
  td::before { content: attr(data-label); display: block; color: #6b6b6b; font-size: 0.75rem; text-transform: uppercase; }
}
"""


def _required_form_field(form, name: str) -> str:
    """Read one required field from an already-parsed form body.

    Deliberately NOT a FastAPI `Form(...)` parameter -- see F3's note on
    the /admin* routes below for why. `form.get(name)` can return
    anything a multipart body puts under that name (e.g. an
    UploadFile), so this only accepts a plain string; anything else is
    treated the same as missing.
    """
    value = form.get(name)
    value = value.strip() if isinstance(value, str) else ""
    if not value:
        raise HTTPException(status_code=422, detail=f"{name} is required")
    return value


CONFIG = load_config()
JWKS_CLIENT = PyJWKClient(CONFIG.jwks_url)
init_db(CONFIG.db_path)

app = FastAPI()


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> str:
    email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    key = get_cached_key(CONFIG.db_path, email)
    if key is None:
        # issue_initial_key() -- not a bare issue_key() -- so a
        # pre-authorized first-time visitor lands active immediately
        # instead of pending. See its docstring: this is the only call
        # site, so pre-authorization can never affect a returning
        # visitor's already-issued key.
        key = issue_initial_key(CONFIG, email)
    team_id = get_current_team_id(CONFIG, key)
    active = team_grants_access(CONFIG, team_id)
    return render_page(email, key, active, CONFIG)


@app.post("/regenerate", response_class=HTMLResponse)
def regenerate(request: Request) -> str:
    email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    key = revoke_and_reissue(CONFIG, email)
    team_id = get_current_team_id(CONFIG, key)
    active = team_grants_access(CONFIG, team_id)
    return render_page(email, key, active, CONFIG)


@app.get("/admin", response_class=HTMLResponse)
def admin_index(request: Request) -> str:
    email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    require_admin(email, CONFIG)
    users = list_issued_users(CONFIG)
    preauthorized = list_preauthorized(CONFIG)
    return render_admin_page(email, users, preauthorized, CONFIG)


@app.post("/admin/promote", response_class=HTMLResponse)
async def admin_promote(request: Request) -> str:
    # Re-verify and re-check the allowlist here too -- never assume the
    # GET that rendered the form already gated this POST. Every /admin*
    # route is independently authorized.
    #
    # Security review F3 (2026-09-30): target_email/target_team used to
    # be Form(...) parameters, which FastAPI resolves and validates
    # BEFORE this function body runs -- a malformed body got a 422 with
    # field names in it before verify_access_jwt/require_admin ever
    # executed, so a non-admin sending a bad payload got a DIFFERENT
    # failure mode (422) than one sending a good payload (403), and
    # require_admin's own docstring claim of an identical response
    # regardless of payload didn't actually hold. Form data is now read
    # manually, strictly AFTER both auth checks below, so authorization
    # is the first thing that can fail on this route, for any request.
    admin_email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    require_admin(admin_email, CONFIG)
    form = await request.form()
    target_email = _required_form_field(form, "target_email")
    target_team = _required_form_field(form, "target_team")
    promote_user(CONFIG, target_email, target_team)
    users = list_issued_users(CONFIG)
    preauthorized = list_preauthorized(CONFIG)
    return render_admin_page(admin_email, users, preauthorized, CONFIG)


@app.post("/admin/demote", response_class=HTMLResponse)
async def admin_demote(request: Request) -> str:
    admin_email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    require_admin(admin_email, CONFIG)
    form = await request.form()
    target_email = _required_form_field(form, "target_email")
    demote_user(CONFIG, target_email)
    users = list_issued_users(CONFIG)
    preauthorized = list_preauthorized(CONFIG)
    return render_admin_page(admin_email, users, preauthorized, CONFIG)


@app.post("/admin/preauthorize", response_class=HTMLResponse)
async def admin_preauthorize(request: Request) -> str:
    admin_email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    require_admin(admin_email, CONFIG)
    form = await request.form()
    emails = _required_form_field(form, "emails")
    result = add_preauthorized_emails(CONFIG, emails)
    users = list_issued_users(CONFIG)
    preauthorized = list_preauthorized(CONFIG)
    return render_admin_page(
        admin_email, users, preauthorized, CONFIG, preauthorize_result=result
    )


@app.post("/admin/preauthorize/remove", response_class=HTMLResponse)
async def admin_preauthorize_remove(request: Request) -> str:
    admin_email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    require_admin(admin_email, CONFIG)
    form = await request.form()
    target_email = _required_form_field(form, "target_email")
    remove_preauthorized_email(CONFIG, target_email)
    users = list_issued_users(CONFIG)
    preauthorized = list_preauthorized(CONFIG)
    return render_admin_page(admin_email, users, preauthorized, CONFIG)


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}
