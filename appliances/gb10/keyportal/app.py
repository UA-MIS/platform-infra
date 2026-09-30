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
import sys
import threading
import time
import uuid
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from html import escape
from typing import Optional
from urllib.parse import urlsplit

import httpx
import jwt
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from starlette.concurrency import run_in_threadpool
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


def _normalize_keyportal_hostname(raw: str) -> str:
    """Normalize KEYPORTAL_HOSTNAME so verify_same_origin()'s comparison
    is not silently defeated by operator input variance.

    Security review round 3, same-pass item (2026-09-30): the origin
    check built `expected` as `_scheme_and_netloc(f"https://{hostname}")`
    with the raw env value spliced in verbatim. Two real gaps:

    1. Case: host names are case-insensitive (RFC 3986 3.2.2) and real
       browsers normalize Origin/Referer to lowercase, but urlsplit()
       does NOT lowercase for you, and nothing stopped an operator from
       typing KEYPORTAL_HOSTNAME=Local-LLM-Keys.UAMISHub.com in .env. A
       correctly-configured browser sending a lowercase Origin would
       then fail a byte-exact comparison against that mixed-case
       `expected` on every single state-changing request -- CSRF
       protection would look "on" but reject 100% of legitimate traffic.
       Fixed by lowercasing here, once, at config-load time, and again
       defensively on both sides of the comparison in
       verify_same_origin() itself (in case a future caller builds
       `expected` from something other than this field).

    2. Port / scheme contamination: if an operator pastes the value with
       a stray scheme or path, e.g. KEYPORTAL_HOSTNAME=
       https://local-llm-keys.uamishub.com/, the old code would splice
       it into f"https://{that}" producing a malformed URL that
       urlsplit() parses into a netloc nobody intended (or empty) --
       failing far from the operator's typo, as a confusing 403 on every
       admin action, with no indication why. Fail loudly here instead,
       at startup, with a message that names the exact problem.

    Deliberately does NOT strip a port: a real deployment on a
    non-default port needs KEYPORTAL_HOSTNAME to include it (e.g.
    "host:8443") so `expected` matches what browsers actually send --
    stripping it would silently break that case instead.
    """
    if "://" in raw or "/" in raw:
        raise RuntimeError(
            f"KEYPORTAL_HOSTNAME={raw!r} looks like a URL, not a bare "
            "hostname[:port] -- keyportal refuses to start with a value "
            "that would corrupt the CSRF same-origin check. Set it to "
            "just the host (and port, if not 443), e.g. "
            "KEYPORTAL_HOSTNAME=local-llm-keys.uamishub.com"
        )
    return raw.lower()


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
    keyportal_hostname: str
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
        # The portal's real external hostname, for the same-origin check
        # on state-changing POSTs (security review F5, 2026-09-30).
        # Deliberately NOT derived from the Host header, which an
        # attacker controls and which behind the cloudflared tunnel
        # reflects internal routing, not the portal's real identity.
        keyportal_hostname=_normalize_keyportal_hostname(
            _require_env(
                "KEYPORTAL_HOSTNAME",
                hint=(
                    "Set KEYPORTAL_HOSTNAME in .env on the box to the keys "
                    "portal's real external hostname, e.g. "
                    "KEYPORTAL_HOSTNAME=local-llm-keys.uamishub.com -- then "
                    "run: docker compose up -d keyportal"
                ),
            )
        ),
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


def _scheme_and_netloc(url: str) -> str:
    """Lowercased, for the same reason config-load normalizes
    KEYPORTAL_HOSTNAME (see _normalize_keyportal_hostname's docstring):
    host names are case-insensitive and real browsers send Origin/
    Referer already lowercased, but urlsplit() does not lowercase for
    you. Lowercasing here too (not just at config load) means this
    comparison stays correct even if `expected` is ever built from a
    value that did not go through that normalization."""
    parsed = urlsplit(url)
    return f"{parsed.scheme}://{parsed.netloc}".lower()


def verify_same_origin(request: Request, config: Config) -> None:
    """CSRF defense for every state-changing POST (security review F5,
    2026-09-30): /regenerate, /admin/promote, /admin/demote,
    /admin/preauthorize, /admin/preauthorize/remove.

    Cloudflare Access's default SameSite cookie behavior already makes
    a cross-site forged POST non-exploitable today -- but that safety
    rests entirely on an off-box Zero Trust dashboard toggle nobody on
    this team controls, that no test here can pin down, and that
    someone could flip years from now while debugging an unrelated
    embedding problem. Defend at the application layer too, rather than
    depend on a setting outside this codebase. Concrete threat model:
    a student emails an admin a support-request link; the page the
    admin's browser is tricked into visiting auto-submits
    target_email=<the attacker's own email>&target_team=faculty. No
    enumeration needed -- the attacker already knows their own email.

    Validates the Origin header when present; falls back to Referer
    ONLY when Origin is absent (some older clients omit Origin on
    same-origin POSTs -- Referer is the fallback, not a second chance
    for a mismatched Origin). A request with NEITHER header present is
    REJECTED, not allowed through -- this is a state-changing POST, and
    failing open here would silently defeat the entire point, the same
    "fail loudly, never silently" contract as the rest of this file.

    Compares scheme+host+port EXACTLY against config.keyportal_hostname
    (never the Host header, which an attacker controls and which,
    behind the cloudflared tunnel, reflects internal routing rather
    than the portal's real external identity) via urlsplit()'s own
    parsing -- not a substring or `startswith` check, which is the same
    class of bug as the require_admin substring mutant that survived
    testing earlier in this review:
    "https://local-llm-keys.uamishub.com.attacker.example" must fail,
    and would pass a naive `.startswith(expected)` or `expected in
    origin` check.
    """
    expected = _scheme_and_netloc(f"https://{config.keyportal_hostname}")
    origin = request.headers.get("Origin")
    if origin is not None:
        candidate = _scheme_and_netloc(origin)
    else:
        referer = request.headers.get("Referer")
        if referer is None:
            raise HTTPException(
                status_code=403,
                detail=(
                    "Origin mismatch -- no Origin or Referer header on a "
                    "state-changing request."
                ),
            )
        candidate = _scheme_and_netloc(referer)
    if candidate != expected:
        raise HTTPException(
            status_code=403,
            detail=f"Origin mismatch -- expected {expected}, got {candidate}.",
        )


def get_cached_key(db_path: str, email: str) -> Optional[str]:
    """The one place every caller reads "does this email have a usable
    key". Security review round 4, B5 fix 1 (2026-09-30): a claim token
    (see _CLAIM_PREFIX below) is NOT a usable key -- it is a row mid-
    flight, either genuinely in progress or abandoned by a process that
    crashed between claiming and finalizing. Before this fix, a stuck
    claim was indistinguishable from a real key to every caller of this
    function: index()/regenerate() would hand it straight to
    get_current_team_id(), which raises on a key LiteLLM does not
    recognize (a claim token is never a valid LiteLLM key shape) --
    turning a crashed mint into a PERMANENT 500 on every reload for that
    student, forever, with no self-service recovery. Filtering it out
    here means every caller correctly sees "no key yet", the same state
    as a brand-new visitor -- issue_initial_key()'s own claim (fix 2,
    same review) then either reclaims the stale slot or discovers a
    genuinely live one in progress, rather than this function ever
    handing out a value nothing can use.
    """
    with closing(sqlite3.connect(db_path)) as conn:
        row = conn.execute(
            "SELECT litellm_key FROM keys WHERE email = ?", (email,)
        ).fetchone()
    if row is None:
        return None
    key = row[0]
    if key.startswith(_CLAIM_PREFIX):
        return None
    return key


# A claim token is never a valid LiteLLM key shape (real keys are
# "sk-..."), so get_current_team_id()'s /key/info lookup will correctly
# fail to recognize one -- which is exactly what makes a STUCK claim
# (a winner that crashed mid-flight) visible as a stale row in
# list_issued_users()/`/admin`. That admin-side visibility is real but
# was NOT a fix on its own (security review round 4, B5, 2026-09-30):
# an admin has no button for it (promote/demote are suppressed on a
# stale row) and its own hint pointed at LiteLLM's key list, which is
# the wrong system -- the bad data lives in THIS database, not there.
# get_cached_key() now filters this prefix out (treats a claim as "no
# key"), and _claim_key_row() below reclaims a claim old enough to be
# abandoned rather than leaving it stuck forever.
_CLAIM_PREFIX = "__claiming__"

# How long a claim is trusted before it is treated as abandoned (a
# process that crashed between claiming and finalizing) rather than
# genuinely in progress. issue_key()'s LiteLLM round trip is a fast
# management-API call, not slow inference -- comfortably done in well
# under this window in the ordinary case, so anything still unresolved
# past it is far more likely a crash than a slow winner.
_CLAIM_TTL_SECONDS = 60


def _claim_key_row(
    config: Config, email: str, previous_key: Optional[str]
) -> Optional[str]:
    """Atomically claim the right to (re)issue a key for `email`, BEFORE
    calling LiteLLM (security review B1, hardening round 2, 2026-09-30).
    Writes a unique claim token into litellm_key, conditioned on the row
    still holding exactly `previous_key` (or not existing at all, for a
    brand-new email) -- the same sqlite-arbitrated compare-and-swap
    pattern as mark_preauthorized_redeemed(), safe across any number of
    processes. Returns the claim token on success, None if someone else
    already holds it.

    Security review round 4, B5 fix 2 (2026-09-30): if the direct CAS
    attempt above loses, the row might not be a live contest -- it might
    be a claim abandoned by a crashed process, sitting there forever
    with nothing to ever clear it (get_cached_key() now hides it from
    every reader, but hiding it is not the same as reclaiming it). Before
    giving up, re-read the row: if it currently holds ANY claim token
    (not necessarily `previous_key` -- the caller may have believed
    there was no key at all) older than _CLAIM_TTL_SECONDS, treat it as
    abandoned and CAS from that exact value instead. A genuinely live
    claim (younger than the TTL) is left alone -- that is still a real
    contest, and the caller's existing bounded-retry-then-raise handles
    it correctly.
    """
    token = f"{_CLAIM_PREFIX}{uuid.uuid4().hex}"
    now = time.time()
    with closing(sqlite3.connect(config.db_path)) as conn:
        if previous_key is None:
            cur = conn.execute(
                "INSERT OR IGNORE INTO keys (email, litellm_key, key_id, created_at) "
                "VALUES (?, ?, 'claiming', ?)",
                (email, token, now),
            )
        else:
            cur = conn.execute(
                "UPDATE keys SET litellm_key = ?, key_id = 'claiming', "
                "created_at = ? WHERE email = ? AND litellm_key = ?",
                (token, now, email, previous_key),
            )
        won = cur.rowcount == 1
        if not won:
            row = conn.execute(
                "SELECT litellm_key, created_at FROM keys WHERE email = ?",
                (email,),
            ).fetchone()
            if (
                row
                and row[0].startswith(_CLAIM_PREFIX)
                and (now - row[1]) > _CLAIM_TTL_SECONDS
            ):
                reclaim_token = f"{_CLAIM_PREFIX}{uuid.uuid4().hex}"
                cur2 = conn.execute(
                    "UPDATE keys SET litellm_key = ?, key_id = 'claiming', "
                    "created_at = ? WHERE email = ? AND litellm_key = ?",
                    (reclaim_token, now, email, row[0]),
                )
                if cur2.rowcount == 1:
                    token = reclaim_token
                    won = True
        conn.commit()
    return token if won else None


def _release_claim(
    config: Config, email: str, token: str, restore_to: Optional[str]
) -> None:
    """Undo a claim on ordinary failure (the LiteLLM call raised, or a
    local write failed right after a successful mint) so the row never
    gets stuck for a reason that isn't an actual process crash. Restores
    the previous key if there was one, or deletes the row entirely for a
    claim that started from nothing."""
    with closing(sqlite3.connect(config.db_path)) as conn:
        if restore_to is None:
            conn.execute(
                "DELETE FROM keys WHERE email = ? AND litellm_key = ?",
                (email, token),
            )
        else:
            conn.execute(
                "UPDATE keys SET litellm_key = ? WHERE email = ? AND litellm_key = ?",
                (restore_to, email, token),
            )
        conn.commit()


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
    # Security review B1 hardening, round 2 (2026-09-30): CLAIM the row
    # BEFORE calling LiteLLM, rather than minting speculatively and
    # cleaning up the loser afterward. The previous (round-1 hardening)
    # design called LiteLLM first and used a compare-and-swap only on
    # the FINAL write; if the loser's post-hoc `/key/delete` cleanup
    # itself failed, that left a real, live, untracked ACTIVE key --
    # B1's exact failure shape, reached through a rarer door. With
    # claim-before-mint, the loser NEVER calls LiteLLM at all, so there
    # is nothing to clean up that can fail: no code path mints a key
    # this database does not track.
    #
    # The claim is a random token written into litellm_key itself (no
    # schema change -- key_id becomes the literal string "claiming",
    # created_at becomes the claim time, both already-existing
    # columns), via the SAME sqlite-arbitrated compare-and-swap pattern
    # as mark_preauthorized_redeemed(), so it is safe across ANY number
    # of processes, not just within one.
    with closing(sqlite3.connect(config.db_path)) as conn:
        row = conn.execute(
            "SELECT litellm_key FROM keys WHERE email = ?", (email,)
        ).fetchone()
    previous_key = row[0] if row else None

    token = _claim_key_row(config, email, previous_key)
    if token is None:
        # Lost the claim. Normally unreachable within one process
        # (_lock_for_email() already serializes this), so this is the
        # cross-process case: give the winner a brief moment -- its
        # LiteLLM call is a fast management-API request, not a slow
        # inference call -- and check once more before failing loudly.
        # No open-ended polling: a winner that never finishes (e.g. it
        # crashed mid-flight) leaves a claim token as litellm_key, which
        # _claim_key_row() itself now reclaims once it is old enough
        # (security review round 4, B5 fix 2) -- so a genuinely stuck
        # claim self-heals on the NEXT caller rather than needing
        # special-case code here.
        time.sleep(0.3)
        row = get_cached_key(config.db_path, email)
        if row is not None:
            return row
        raise RuntimeError(
            f"Another request is already issuing a key for {email} -- "
            f"please reload in a moment."
        )

    return _mint_and_finalize_claim(config, email, team_id, token, previous_key)


def _mint_and_finalize_claim(
    config: Config,
    email: str,
    team_id: str,
    token: str,
    previous_key: Optional[str],
) -> str:
    """The "call LiteLLM, then finalize the already-won claim" back half
    of issue_key(), extracted (security review round 4, finding 2,
    2026-09-30) so issue_initial_key() can reuse it after doing its OWN
    claim step atomically with its own existence check -- see that
    function's docstring for why issue_key()'s own claim-before-mint,
    called AFTER a separate get_cached_key() read, is not by itself
    sufficient for the first-issue case. The caller has already won
    _claim_key_row() (or an equivalent atomic claim); this function only
    ever mints and finalizes onto a token it is handed, never claims
    anything itself.
    """
    minted_key = None
    try:
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
        minted_key = data["key"]
        key_id = data.get("token_id") or data.get("key_name") or email
        with closing(sqlite3.connect(config.db_path)) as conn:
            # Finalize: replace our own claim token with the real key.
            #
            # Security review round 4, finding 1 (2026-09-30): the old
            # comment here claimed this CAS is "guaranteed to succeed --
            # nothing else can hold this specific token", which is
            # FALSE. _claim_key_row() treats a claim token as an
            # ordinary `previous_key` like any other -- it has no
            # concept of "this value is a claim, not a real key" -- so a
            # SECOND caller reading THIS token as its own previous_key
            # (e.g. a stray revoke_and_reissue() racing the same row,
            # once --workers exists) can successfully CAS *from* it and
            # win. Before this fix, that second caller's finalize would
            # then succeed while THIS rowcount check did not exist to
            # catch it -- this UPDATE would silently affect 0 rows, and
            # the code below still returned `minted_key` as if it were
            # safely tracked: B1's exact failure shape (a live, minted,
            # untracked key), reached through the assumption in this
            # comment rather than through the mint path B1 originally
            # closed. Checking rowcount routes this through the SAME
            # except block below that already knows how to clean up a
            # minted-but-untracked key and release the claim correctly.
            cur = conn.execute(
                "UPDATE keys SET litellm_key = ?, key_id = ?, created_at = ? "
                "WHERE email = ? AND litellm_key = ?",
                (minted_key, key_id, time.time(), email, token),
            )
            conn.commit()
            if cur.rowcount != 1:
                raise RuntimeError(
                    f"Finalize lost its own claim token for {email} -- "
                    f"something else claimed FROM our token before we "
                    f"could finalize. Not reachable under the documented "
                    f"single-process invariant; if it happens, the "
                    f"except block below cleans up the just-minted key "
                    f"rather than leaving it live and untracked."
                )
        return minted_key
    except Exception:
        # Ordinary failure (LiteLLM error, or -- vanishingly rare -- the
        # local DB write itself failing right after a successful mint).
        # Release the claim so the row never gets stuck for a reason
        # that isn't an actual process crash.
        if minted_key is not None:
            # LiteLLM DID mint a key before something else failed (the
            # finalize write) -- best-effort clean it up rather than
            # leave a real, live, untracked key. Logged, not raised, on
            # failure: the exception already in flight is the one that
            # matters to the caller.
            try:
                delete_resp = httpx.post(
                    f"{config.litellm_base_url}/key/delete",
                    headers={"Authorization": f"Bearer {config.litellm_master_key}"},
                    json={"keys": [minted_key]},
                    timeout=15.0,
                )
                delete_resp.raise_for_status()
            except httpx.HTTPError as exc:
                print(
                    f"WARNING: _mint_and_finalize_claim() minted a key "
                    f"for {email} but then failed before tracking it, "
                    f"and failed to clean it up too: {exc}. That key "
                    f"may now be an ORPHAN in LiteLLM.",
                    file=sys.stderr,
                )
        _release_claim(config, email, token, previous_key)
        raise


class LiteLLMKeyGoneError(Exception):
    """Security review round 5, soft-delete finding (2026-09-30): LiteLLM
    does NOT 404 a key that was deleted through it -- it soft-deletes.
    Confirmed live: minted a key, called /key/delete (200), then looked
    the same hash up again -- still 200, now with `"status": "deleted"`
    (plus `deleted_at`/`deleted_by`) added to the info payload that
    previously had neither. A fabricated hash that never existed at all
    DOES 404 cleanly. These are two different, observable shapes for
    "this key is gone", and only one of them raises httpx.HTTPStatusError
    -- this exception exists so get_current_team_id()'s callers can
    treat both the same way without each one re-deriving the detection
    logic.

    KNOWN GAP, backlogged with a date (2026-09-30), deliberately not
    fixed here -- so this is not rediscovered as a mystery once it
    starts happening: an EXPIRED key (issued with `duration: "365d"`,
    so the first real expiries land around September 2027 -- check
    THAT date if you are reading this after it has passed) is a THIRD
    shape, confirmed live the same day as the two above, and it is
    worse than either: /key/info still returns 200 with `team_id`
    UNCHANGED and no marker of any kind -- LiteLLM does not compare
    `expires` against the current time for this endpoint -- while the
    raw key correctly 401s ("Authentication Error - Expired Key") the
    moment it is actually used. So an expired key looks FULLY ACTIVE to
    this portal (team_grants_access() reads it as active, same as a
    healthy key) right up until a student tries to use it and it fails
    -- this is not caught by get_current_team_id() today, by this
    exception, or by the 404 path above. Fix, when picked up: compare
    the `expires` field from /key/info against now in UTC (with a
    safety margin), and treat a past expiry as gone via this same
    exception -- but first CONFIRM `expires`'s exact format/timezone
    and whether it is even always present, the same way this file
    confirms every other LiteLLM response shape, rather than assuming.
    """


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

    Security review round 5, soft-delete finding (2026-09-30): raises
    LiteLLMKeyGoneError if the response indicates the key was deleted
    (see that class's docstring for the live evidence). Keyed off
    `status == "deleted"` specifically -- NOT off `team_id` being null,
    which a legitimately team-less (never-promoted) key would also show,
    and NOT off the mere presence of `deleted_at`, which is a
    consequential timestamp rather than the field LiteLLM appears to
    have added FOR the purpose of signaling this state. `status` reads
    as the canonical, purpose-built marker; keying off it rather than a
    side-effect field is the more robust choice if a future LiteLLM
    version adds another reason to set a timestamp-shaped field without
    meaning "gone".
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
    if key_info.get("status") == "deleted":
        raise LiteLLMKeyGoneError(
            f"LiteLLM reports this key as soft-deleted (status=deleted)."
        )
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


# ---------------------------------------------------------------------------
# Per-email lock guarding the "read local state -> round-trip to LiteLLM
# -> write local state" sequence in revoke_and_reissue() and
# issue_initial_key() below (security review B1, 2026-09-30). Two
# concurrent requests for the SAME email -- a double-click on
# Regenerate, two tabs, a browser prefetch of GET / -- used to both pass
# the same "here's the old key" / "no key yet" read before either
# finished writing, each mint a real LiteLLM key, and then
# keys.email's PRIMARY KEY + issue_key()'s INSERT OR REPLACE silently
# kept only the LAST one: the FIRST key is left ACTIVE and ORPHANED --
# untracked by `keys`, invisible to list_issued_users()/`/admin`, and
# unreachable by demote_user() for its full 365-day duration. This
# defeats revocation entirely, which is why it is the most severe
# finding on this branch.
#
# This service runs as a single uvicorn process with no --workers flag
# (see the Dockerfile, which now says so explicitly above CMD);
# Starlette/AnyIO dispatches sync `def` route handlers to that ONE
# process's own threadpool, so a plain in-process Lock genuinely
# serializes same-email requests -- it does not need to be a
# distributed lock, and it does not block DIFFERENT emails' requests
# from proceeding concurrently.
#
# Hardening (2026-09-30, same review, follow-up round): this lock is
# NOT the only thing standing between a race and an orphaned key
# anymore. issue_key()'s own write is now a compare-and-swap against
# the row it read before calling LiteLLM -- that guard is arbitrated by
# sqlite itself and stays correct across ANY number of processes, not
# just within one. This lock remains valuable as the FIRST line of
# defense (it also avoids wasting a LiteLLM call on the side that's
# going to lose the race), and as the thing that makes the CAS's
# losing branch vanishingly rare in normal operation -- but if someone
# adds --workers or a second replica later without reading the
# Dockerfile's warning, issue_key()'s CAS is what actually keeps this
# correct, not this lock.
# ---------------------------------------------------------------------------
_EMAIL_LOCKS_GUARD = threading.Lock()
_EMAIL_LOCKS: dict = {}


def _lock_for_email(email: str) -> threading.Lock:
    normalized = email.strip().lower()
    with _EMAIL_LOCKS_GUARD:
        lock = _EMAIL_LOCKS.get(normalized)
        if lock is None:
            lock = threading.Lock()
            _EMAIL_LOCKS[normalized] = lock
        return lock


def revoke_and_reissue(config: Config, email: str) -> str:
    """Regenerate a key IN PLACE ON ITS CURRENT TEAM.

    This looks up the OLD key's live team_id BEFORE deleting it, and
    re-issues the new key into that SAME team -- it never defaults to
    PENDING_TEAM_ID. An already-promoted student clicking "Regenerate"
    must stay promoted; silently dropping them back to `pending` would
    be a strictly worse bug than the one the key-caching design exists
    to avoid (a support ticket that reads as "activation didn't work"
    instead of one that reads as "I lost my key").

    The whole body runs under _lock_for_email() (security review B1,
    2026-09-30): without it, two concurrent /regenerate calls for an
    ALREADY-PROMOTED student both read the same old key's team_id, both
    delete it, and both issue a new key onto that team -- only the last
    survives in `keys`, orphaning the first as a live, untracked,
    unrevokable ACTIVE key. With the lock, the second call only starts
    once the first has fully committed, so it sees the FIRST call's new
    key as "the old key" and proceeds from there -- never two
    independent mutations racing the same stale state.

    Security review round 3, DB-CAS extension (2026-09-30): the lock
    above only protects against a race WITHIN one process. This service
    runs single-process/single-worker today (see _lock_for_email()'s own
    docstring), but B1-A's event-loop-freeze fix makes adding `--workers`
    a genuinely plausible future change -- and if that ever happens with
    only the in-process lock in place, this exact B1 shape reopens
    silently, with no test able to catch it (a lock cannot serialize
    across processes). Claims the row -- conditioned on it still holding
    exactly `old_key`, via the SAME sqlite-arbitrated CAS as
    issue_key()'s own claim-before-mint (_claim_key_row()) -- BEFORE
    calling /key/delete. A lost claim (rowcount 0, someone else already
    rotated this row since we read old_key) fails loudly instead of
    deleting a key that may no longer correspond to the row's current
    state. For THIS FUNCTION SPECIFICALLY, this makes the in-process
    lock an optimization (skips the round-trip when uncontended) rather
    than the sole correctness guarantee -- exactly the property
    team-lead asked this extension to establish here.

    Security review round 4, finding 2 correction (2026-09-30): the
    previous wording of the paragraph above described the lock, without
    qualification, as "an optimisation rather than the sole correctness
    guarantee" -- true of THIS function after this extension, but NOT
    of _lock_for_email() as used elsewhere in this module. Until every
    caller gets the equivalent treatment (issue_initial_key() got it in
    this same review round; see its own docstring), the lock remains
    the SOLE correctness guarantee for those other callers, and a
    maintainer skimming only this docstring could otherwise conclude
    the module's locking model is uniformly cross-process-safe when it
    is not.
    """
    with _lock_for_email(email):
        old_key = get_cached_key(config.db_path, email)
        team_id = config.pending_team_id
        if old_key:
            # Security review round 5, soft-delete finding (2026-09-30):
            # old_key can be genuinely gone here too -- an admin (or a
            # crashed prior regenerate) deleted it out-of-band since this
            # row was last read. A 404 or a LiteLLMKeyGoneError both mean
            # "cannot verify the old team", so fall back to pending, the
            # same safe default an unresolvable team_id already used
            # (via the `or` below, now folded into this except). A
            # genuine 5xx here is NOT treated the same way -- that means
            # LiteLLM is unwell, not that old_key is gone, and masking an
            # outage as "team unknown, proceed onto pending" would be the
            # exact B6 mistake at a second call site.
            try:
                team_id = get_current_team_id(config, old_key) or config.pending_team_id
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 404:
                    raise
                team_id = config.pending_team_id
            except LiteLLMKeyGoneError:
                team_id = config.pending_team_id
            claim_token = _claim_key_row(config, email, old_key)
            if claim_token is None:
                raise RuntimeError(
                    f"Another request already changed {email}'s key -- "
                    f"please reload and try again."
                )
            try:
                delete_resp = httpx.post(
                    f"{config.litellm_base_url}/key/delete",
                    headers={"Authorization": f"Bearer {config.litellm_master_key}"},
                    json={"keys": [old_key]},
                    timeout=15.0,
                )
                # Security review F2 (2026-09-30): a silently-failed delete
                # here is exactly how a stale row that no longer matches a
                # live LiteLLM key ends up sitting in `keys` -- the old key
                # would still exist in LiteLLM (never actually deleted)
                # while a NEW key also gets issued and cached below, or
                # worse, the delete partially succeeds server-side but
                # reports failure. Fail loudly here instead of proceeding to
                # issue a second key on top of an old one whose deletion
                # status is unknown.
                delete_resp.raise_for_status()
                return issue_key(config, email, team_id)
            except Exception:
                # The delete failed (or, vanishingly rarely, something
                # between here and issue_key()'s own claim did) -- release
                # OUR claim back to old_key so the row never gets stuck
                # holding a claim token for a reason that is not an actual
                # process crash. If issue_key() itself later fails after
                # successfully re-claiming from our token, ITS OWN release
                # already restores the row to our token first; this
                # release then completes the chain back to old_key.
                _release_claim(config, email, claim_token, old_key)
                raise
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

    Security review round 3, same-pass item (2026-09-30): the original
    F2 fix caught only `httpx.HTTPError` with one wording ("LiteLLM does
    not recognize this key") for every failure. That wording is right
    for the common case -- a real 404 on a specific key -- but wrong and
    actively misleading if LiteLLM itself is unreachable (a
    `ConnectError`/`TimeoutException`, both `httpx.RequestError`
    subclasses, not a status code at all): an admin loading /admin
    during a LiteLLM outage would see EVERY row individually marked
    "does not recognize this key" and could reasonably conclude every
    student's key had been revoked, when actually none were checked at
    all. Also widened to catch `ValueError` (covers
    `json.JSONDecodeError`), since `get_current_team_id()`/
    `team_grants_access()` both call `resp.json()` -- an unexpected
    non-JSON body (a proxy error page, a bad deploy) used to reproduce
    the exact "one bad row 500s the whole page" failure this function
    exists to prevent, just via a different exception type than the
    original fix anticipated. Each of the three cases now gets wording
    that tells the admin what actually happened.

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
        except LiteLLMKeyGoneError as exc:
            # Security review round 5, soft-delete finding (2026-09-30):
            # a soft-deleted key returns 200, not 404 -- WITHOUT this
            # branch, it fell all the way through to the success path
            # below with team_id=None, rendering as "(none)"/inactive
            # indistinguishably from a key that simply was never
            # promoted. An admin's obvious next move on THAT row is
            # Promote, which "succeeds" against a dead key and changes
            # nothing -- a permanent, silently misleading dead end for
            # both the student and the admin. Distinct wording so this
            # reads as "this key is gone", not "this key just needs
            # activating".
            users.append(
                IssuedUser(
                    email=email,
                    team_id=None,
                    team_label="(deleted -- this key was removed from LiteLLM)",
                    active=False,
                    created_at=created_at,
                    lookup_error=str(exc),
                )
            )
            continue
        except httpx.HTTPStatusError as exc:
            # A real HTTP status came back (typically 404) -- LiteLLM is
            # reachable and answered; it just does not recognize this
            # specific key. This is the common, per-row case F2 targeted.
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
        except httpx.RequestError as exc:
            # No status code at all -- a connection/timeout failure
            # (httpx.ConnectError, httpx.TimeoutException, etc). This is
            # almost certainly NOT specific to this one row: LiteLLM is
            # probably down or unreachable for every row on this page.
            # Different wording so an admin does not mistake "the whole
            # backend is unreachable" for "every student's key was
            # individually revoked."
            users.append(
                IssuedUser(
                    email=email,
                    team_id=None,
                    team_label="(unknown -- could not reach LiteLLM to check this key)",
                    active=False,
                    created_at=created_at,
                    lookup_error=str(exc),
                )
            )
            continue
        except ValueError as exc:
            # resp.json() raised (covers json.JSONDecodeError) -- LiteLLM
            # answered with a 2xx but a body that was not the JSON shape
            # expected (a proxy error page, a bad deploy). Distinct from
            # both cases above: a status code path was fine, but the
            # payload was not something get_current_team_id()/
            # team_grants_access() could parse.
            users.append(
                IssuedUser(
                    email=email,
                    team_id=None,
                    team_label="(unknown -- LiteLLM returned an unexpected response for this key)",
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
    """Newline, comma, semicolon, AND any other whitespace (tabs, stray
    spaces, \\r from Windows line endings) all count as separators
    (security review B4, 2026-09-30) -- people paste out of Excel (name
    and email in adjacent cells, tab-separated) and Outlook
    (semicolon-joined address lists), and the separators are never
    consistent. Splitting on comma-only was the actual shipped bug: a
    tab- or semicolon-joined line that happened to END in a valid
    address (e.g. "Smith\\tstudent@ua.edu") passed the old suffix-only
    check as ONE bogus token and was silently stored, authorizing
    nobody while reporting success. Trim, lowercase, drop blanks; does
    NOT dedupe or validate shape (add_preauthorized_emails() dedupes
    against both this paste and the existing table, and
    _looks_like_email() validates shape, in one pass)."""
    return [e.strip().lower() for e in re.split(r"[,;\s]+", raw_text) if e.strip()]


# A local part that starts alphanumeric and otherwise only contains the
# usual local-part characters. Deliberately not a full RFC 5322
# validator -- just enough to reject the shapes a malformed paste
# actually produces (angle brackets, semicolons, spaces, SQL-shaped
# punctuation) without rejecting any real UA address.
_LOCAL_PART_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._%+-]*$")


def _looks_like_email(candidate: str, config: Config) -> bool:
    """Shape validation, not just a suffix check (security review B4,
    2026-09-30). `candidate.endswith(suffixes)` alone only constrains
    the END of the string -- it says nothing about what comes before
    the "@", so a whole "Smith\\tc@ua.edu"-shaped token (before
    _split_pasted_emails() above also learned to split on whitespace)
    or an SQL/HTML-injection-shaped string ending in a real suffix would
    pass it. Requires exactly one "@" and a local part that looks like
    one, on top of the existing suffix check.
    """
    if candidate.count("@") != 1:
        return False
    local, _, _domain = candidate.partition("@")
    if not _LOCAL_PART_RE.match(local):
        return False
    return candidate.endswith(config.allowed_email_suffixes)


def add_preauthorized_emails(config: Config, raw_text: str) -> PreauthorizeResult:
    """Parse, normalize, validate, and store a pasted roster.

    Order of operations matters for correct reporting: reject invalid
    shapes/domains BEFORE checking "already stored", so a re-pasted
    invalid address is reported as rejected (actionable: "this is a
    typo"), not silently swallowed as "already present". Dedupes both
    within THIS paste (a roster copy/pasted twice) and against rows
    already in the table (redeemed or not -- either way there is
    nothing new to do).
    """
    candidates = _split_pasted_emails(raw_text)
    seen_this_paste = set()
    to_insert = []
    rejected = []
    for email in candidates:
        if email in seen_this_paste:
            continue
        seen_this_paste.add(email)
        if not _looks_like_email(email, config):
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

    A read-only check -- issue_initial_key() does NOT call this to
    decide whether to grant active access (security review B1,
    2026-09-30: that decision must be atomic, so it uses
    mark_preauthorized_redeemed()'s own return value as the actual
    claim, never a separate read-then-act). This remains useful on its
    own for introspection (tests, and anywhere that just wants to know
    current state without side effects).
    """
    with closing(sqlite3.connect(config.db_path)) as conn:
        row = conn.execute(
            "SELECT redeemed_at FROM preauthorized WHERE email = ?",
            (email.strip().lower(),),
        ).fetchone()
    return row is not None and row[0] is None


def mark_preauthorized_redeemed(config: Config, email: str) -> bool:
    """Atomically claim `email`'s pre-authorization by marking it
    redeemed -- returns True only if THIS call won the claim.

    Security review B1 (2026-09-30): this single UPDATE ... WHERE
    redeemed_at IS NULL statement IS the fix for the double-redeem
    race, not a bookkeeping step that runs after the fact. sqlite
    serializes writes to one file across connections/threads, so of two
    concurrent callers racing this statement for the SAME email, only
    one can ever see its own write take effect while redeemed_at was
    still NULL -- the loser's WHERE clause simply matches zero rows
    once it runs, because the winner's commit already happened first.
    issue_initial_key() below calls this BEFORE issuing anything, and
    treats a losing claim as "already handled elsewhere, fall through
    to normal pending issuance" -- never as a reason to also issue an
    active key.
    """
    with closing(sqlite3.connect(config.db_path)) as conn:
        cur = conn.execute(
            "UPDATE preauthorized SET redeemed_at = ? WHERE email = ? "
            "AND redeemed_at IS NULL",
            (time.time(), email.strip().lower()),
        )
        conn.commit()
        return cur.rowcount == 1


def issue_initial_key(config: Config, email: str) -> str:
    """Issue a brand-new visitor's first key. This is the ONLY place
    pre-authorization has any effect: index() only calls this when
    get_cached_key() found nothing, so a returning visitor's existing
    key (and its current team, whatever an admin has since set it to)
    is never touched by this function.

    Pending by default -- unless `email` is on the pre-authorized list
    and hasn't redeemed it yet, in which case they get an ACTIVE
    students-team key immediately. No separate "reissue" step, ever:
    this is the one and only issue_key() call for this visitor, straight
    onto the right team from the start.

    Security review B1 (2026-09-30): the claim (mark_preauthorized_
    redeemed()) now happens FIRST, atomically, BEFORE issue_key() ever
    runs -- not after. The whole function also runs under
    _lock_for_email(), which additionally serializes the
    NON-preauthorized path (two concurrent brand-new visits for the same
    un-preauthorized email used to both land in pending independently --
    harmless since pending grants zero access, but still two untracked
    keys instead of one).

    Deliberate choice on issue_key() failure AFTER winning the claim: do
    NOT release it. The claim is a one-time, atomic "this email gets
    exactly one shot at auto-active" token; releasing it on failure
    would reopen the exact race this function exists to close, against
    a THIRD concurrent request retrying into the freed slot. Falling
    through to a normal pending issuance instead costs the student one
    Promote click from an admin later -- not a second, uncontrollable
    active key.

    Security review round 3, B1-R (2026-09-30): re-reads get_cached_key()
    INSIDE the lock, first thing, and returns it immediately if present
    -- mirroring what revoke_and_reissue() already does correctly.
    index() checks get_cached_key() OUTSIDE this lock (it has to -- that
    is what decides whether to call this function at all), so two
    concurrent first-time requests for the same email both see None and
    both enter this function. The lock then serializes them.

    Security review round 4, finding 2 (2026-09-30): the round-3 fix
    above closed the WITHIN-PROCESS race but was still a plain
    get_cached_key() READ followed, separately, by a call into
    issue_key() -- which does its OWN unconditional claim-and-mint
    unconditioned on whether a REAL key already exists. Reviewer
    demonstrated that with the lock stubbed out (the future --workers
    scenario this whole module's CAS work exists for), three concurrent
    first-time visits for the same email minted THREE keys, not one:
    each one's issue_key() call read whatever the row currently held
    (None, then whichever caller's key had landed most recently) as its
    own valid `previous_key` baseline and happily claimed-and-overwrote
    it, landing the untracked losers on the ACTIVE students team -- B1's
    exact failure shape, at full original severity, through the one door
    the B1-R/B1-A/DB-CAS work had not yet closed.

    Fixed by making the existence check ITSELF the atomic claim, rather
    than a read followed by a decision: attempts _claim_key_row(email,
    None) FIRST. Winning it is, atomically, proof that no real key (and
    no live claim) existed a moment ago (or that a stale claim was just
    reclaimed -- see _claim_key_row()'s own TTL logic) -- only the
    winner ever determines team_id or mints, via the SAME
    _mint_and_finalize_claim() back-half issue_key() uses, so exactly
    one key is ever minted for a given email's first issuance, cross-
    process, lock or no lock. Losing the claim means a real key already
    existed (return it) or a live claim is genuinely in progress (the
    same bounded retry-then-raise issue_key() uses for the identical
    situation). The in-process lock above is kept -- it is still the
    fast, uncontended path, skipping the read-and-possibly-retry
    sequence entirely -- but is no longer the only thing standing
    between this function and B1's original failure shape.

    Deliberate choice, unchanged from round 3: a real key found via the
    losing path, or a failure inside _mint_and_finalize_claim() after
    winning the claim, is never "released" back to a re-triable pending
    slot for THIS email's first-issue attempt -- see
    _mint_and_finalize_claim()'s own failure handling, which cleans up a
    minted-but-untracked key and restores the row to whatever this
    function's own claim overwrote (None in the fresh-row case), rather
    than reopening a THIRD concurrent request's chance at the same slot.
    """
    with _lock_for_email(email):
        token = _claim_key_row(config, email, None)
        if token is not None:
            # Won the claim -- atomically confirmed no real/live key
            # existed a moment ago. Safe to decide team_id and mint;
            # nothing else can be racing this exact row until we finish.
            if mark_preauthorized_redeemed(config, email):
                team_id = getattr(config, _PREAUTHORIZE_TARGET_TEAM_ATTR)
            else:
                team_id = config.pending_team_id
            return _mint_and_finalize_claim(config, email, team_id, token, None)

        # Someone else already holds (or has finished with) this row --
        # within one process, with the lock held, this branch is only
        # reachable at all if that "someone else" is a DIFFERENT process
        # (the lock already serializes same-process callers before they
        # ever reach _claim_key_row above).
        existing = get_cached_key(config.db_path, email)
        if existing is not None:
            return existing
        # A live (non-stale) claim -- genuinely contested by a
        # concurrent first-time visit. Same bounded retry issue_key()
        # uses for the identical situation.
        time.sleep(0.3)
        existing = get_cached_key(config.db_path, email)
        if existing is not None:
            return existing
        raise RuntimeError(
            f"Another request is already issuing a key for {email} -- "
            f"please reload in a moment."
        )


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


def render_regenerate_origin_mismatch_page(config: Config) -> str:
    """Security review round 3, student-facing item (2026-09-30): the
    friendly counterpart to verify_same_origin()'s 403 on /regenerate.

    That check is correct and must not be weakened -- a forged
    Regenerate click would silently invalidate a student's working key.
    But its raw response (a bare `{"detail": "..."}` JSON body, FastAPI's
    default for an unhandled HTTPException) reads as "the service is
    broken" to a student, not "click Regenerate again." This is reached
    only for the narrow, real failure mode: a privacy extension or
    hardened browser sending no Origin/Referer, or one Referrer-Policy
    header cannot fix, on a same-origin click. GET / has no origin check
    at all, so the student's EXISTING key still works right now -- this
    page says so explicitly, so a student does not conclude they are
    locked out over what is really a single broken button.
    """
    head = _PAGE_HEAD.format(style=_STYLE)
    return f"""<!doctype html>
<html><head>{head}</head>
<body>
<h1>UA-MIS Local LLM Key</h1>
<div class="pending">
<p><strong>Regenerate didn't go through -- but your existing key still works.</strong></p>
<p>This usually means a privacy setting in your browser (or an extension)
blocked some information this button needs to confirm the request came
from this page. Nothing about your key changed.</p>
<p>Your current key is unaffected and still active. If you don't
actually need a new key, there is nothing else to do -- just go back to
<a href="/">the main page</a>.</p>
<p>If you do need to regenerate, try again after checking your browser
isn't blocking "referrer" information for this site, or in a different
browser. Still stuck? Contact <strong>{config.admin_contact}</strong>.</p>
</div>
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
    users: Optional[list],
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

    `users=None` (security review B3, 2026-09-30) means the key list
    could not be read at all -- distinct from `users=[]`, which means it
    read fine and is genuinely empty. The roster and any
    preauthorize_result are independent of this and render normally
    either way: this whole page must degrade gracefully when LiteLLM is
    unreachable, not go dark, since that is exactly when an admin needs
    the roster and the promote/demote history most.
    """
    head = _PAGE_HEAD.format(style=_STYLE + _ADMIN_STYLE)
    if users is None:
        table = (
            '<p class="policy"><strong>Key list is temporarily '
            "unavailable</strong> -- a LiteLLM lookup failed. The "
            "pre-authorized roster below is unaffected; promote/demote "
            "will work again once LiteLLM is reachable.</p>"
        )
    elif users:
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


def _list_issued_users_or_none(config: Config):
    """Defense in depth on top of list_issued_users()'s own per-row
    resilience (security review B3, 2026-09-30). Every /admin* route
    calls this instead of list_issued_users() directly, AFTER computing
    and holding anything a mutation on that route needs to report (a
    promote/demote's own success, or add_preauthorized_emails()'s
    added/already_present/rejected report) and AFTER reading the
    pre-authorized roster, which is pure sqlite with zero outbound HTTP
    and must never be held hostage by the key list.

    Broad `except Exception` is deliberate here, not laziness: this is
    a read-only, already-idempotent listing feeding a rendering path,
    not a mutation -- degrading gracefully to "key list unavailable"
    is strictly better than a 500 that also discards whatever the
    route's own mutation already reported. Returns None on any failure;
    render_admin_page() shows an explicit "unavailable" message rather
    than an empty table in that case.
    """
    try:
        return list_issued_users(config)
    except Exception:
        return None


CONFIG = load_config()
JWKS_CLIENT = PyJWKClient(CONFIG.jwks_url)
init_db(CONFIG.db_path)

app = FastAPI()


@app.middleware("http")
async def _add_referrer_policy_header(request: Request, call_next):
    """Security review round 3, student-facing item (2026-09-30): sets
    `Referrer-Policy: same-origin` on every response.

    The reachable failure mode this addresses: a student running a
    privacy extension or a hardened browser configuration that forces a
    stricter referrer policy (or sends `Origin: null` outright) hits
    verify_same_origin()'s fail-closed check on /regenerate and gets a
    403 -- a broken button, not a lockout, since GET / has no origin
    check and their existing key keeps working. Explicitly declaring
    `same-origin` here is this portal stating its own intended policy
    (send Referer only to itself, never cross-origin) rather than
    leaving it to each browser's default (`strict-origin-when-cross-
    origin`), which reduces how often a hardened client disagrees with
    what this app already requires anyway. It does NOT change, weaken,
    or replace verify_same_origin()'s own check -- a client that still
    sends neither Origin nor Referer, or the wrong one, is still
    rejected. This header only ever makes the honest case (a real
    same-origin request) more likely to look honest to a cautious
    client; the /regenerate route's own friendly-403 page (see
    regenerate() below) is what makes the failure survivable on the
    clients where this header isn't enough.
    """
    response = await call_next(request)
    response.headers["Referrer-Policy"] = "same-origin"
    return response


def _team_id_for_key_or_reissue(config: Config, email: str, key: str) -> tuple:
    """Security review round 4, B5 fix 3 -- THE blocker fix (2026-09-30):
    get_current_team_id() raises (httpx.HTTPStatusError) when LiteLLM
    does not recognize `key`. Before this fix, both call sites of
    get_current_team_id() in the student-facing routes (index(),
    regenerate()) let that propagate straight into an unhandled 500 --
    forever, on EVERY reload, since nothing about the row changes on its
    own. Reachable multiple ways, none of them exotic: a key LiteLLM
    deleted out-of-band, one that hit its 365-day expiry, a stuck claim
    token (partially closed by fixes 1/2 above, but out-of-band deletion
    and expiry are pre-existing doors those two do not touch), or the
    revoke_and_reissue() window where /key/delete succeeds and issue_key
    then fails, leaving the row restored to an old_key LiteLLM has
    already deleted.

    Security review round 5, BLOCKER B6 (2026-09-30): the original
    version of this fix caught the whole of httpx.HTTPStatusError, which
    raise_for_status() raises for EVERY non-2xx status -- a LiteLLM
    SERVER error on /key/info (a degraded database, connection-pool
    exhaustion, or a restart where the API answers before its own DB is
    ready) was therefore indistinguishable from "this key does not
    exist". Reviewer probed 404/400/500/502/503 against the mocked
    shape and got a re-issue on all five -- meaning a LiteLLM incident
    that 5xx's /key/info would silently orphan every affected student's
    key: the OLD key is never deleted (this function has no reason to
    delete it -- it believes LiteLLM already lost it), so it sits live
    and untracked, invisible to list_issued_users()/`/admin`,
    unreachable by demote_user() for 365 days, while the student is
    ALSO silently dropped to pending. This is the exact class of harm
    every round since B1 has been closing, reached this time through an
    exception hierarchy that does not distinguish "the resource does
    not exist" from "the server is unwell" -- and it hits every student
    who happens to reload during the incident, not one at a time.

    Fixed by keying off the REAL, LIVE-VERIFIED status LiteLLM returns
    for a key it does not recognize -- confirmed against this
    deployment's actual LiteLLM by looking up a fabricated hash: a
    clean 404 (`{"error": {..., "code": "404"}}`), not guessed at.
    Catches httpx.HTTPStatusError but re-raises anything whose
    `exc.response.status_code` is not 404 -- a 5xx now propagates as an
    ordinary unhandled error (a transient, self-healing failure on the
    next reload, exactly the docstring's own stated policy for
    RequestError/TimeoutException below, now actually implemented for
    the status-code path too). Uses `exc.response`, not `exc.request`:
    a real httpx.HTTPStatusError always carries a `.response` (it is
    what raise_for_status() failed on), but this codebase's own test
    double (FakeResponse in conftest.py) never sets a request object,
    and real httpx refuses to even evaluate a property that touches
    `.request` in that shape.

    Security review round 5, soft-delete finding, authorized as in-scope
    (2026-09-30): the paragraph above originally described the
    soft-delete path as a known, separate gap, NOT fixed here. It is
    fixed here now -- team-lead's own read of the consequence is why:
    "deleted out-of-band" was one of the three triggers B5's report
    named, so B5 was only HALF closed. A soft-deleted key returns 200
    (LiteLLM's /key/delete does not remove the row; a later /key/info on
    the same hash returns 200 with `"status": "deleted"` added), so no
    HTTPStatusError was ever raised, this wrap never fired, and
    get_current_team_id() just returned None -- team_grants_access()
    handled that gracefully as "not active" (no crash), but the student
    was left holding a dead key FOREVER, displayed as "issued but not
    yet activated", while an admin's obvious remedy (Promote) does
    nothing useful against a key that no longer exists. get_current_
    team_id() now raises LiteLLMKeyGoneError for this shape (see that
    class's own docstring for why it is keyed off `status`, not
    `team_id`); caught here identically to a 404, unconditionally (there
    is no status code to filter on -- a 200-with-deletion-marker only
    ever means one thing).

    Re-issues via issue_key() directly onto PENDING, reusing its own
    claim-before-mint CAS unconditionally rather than guessing at a team
    we have no way to verify (the whole reason we are here is that
    LiteLLM will not tell us anything about the old key). This is the
    same "a race silently falls through to pending instead of an
    uncontrolled active key" tradeoff issue_initial_key() already
    accepts -- it costs the student one Promote click from an admin,
    not a second, unverifiable active key. Deliberately does NOT catch
    httpx.RequestError/TimeoutException: an actual LiteLLM outage would
    make the re-issue attempt fail too, and that failure is transient
    and self-healing on the next reload, not the permanent-until-
    manual-intervention failure this fix exists to remove.

    Security review round 5, step 6 (2026-09-30): logs every re-issue at
    WARNING, since landing on pending is a SILENT demotion for an
    already-promoted student with no admin-side signal otherwise --
    team-lead is deciding separately whether a `last_known_team_id`
    column is worth adding to restore the real team instead of guessing
    pending; this log line is the floor, not a replacement for that.
    """
    try:
        return key, get_current_team_id(config, key)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code != 404:
            raise
        reason = "was not found by LiteLLM (404)"
    except LiteLLMKeyGoneError:
        reason = "was soft-deleted by LiteLLM (status=deleted)"
    print(
        f"WARNING: {email}'s cached key {reason} -- re-issuing onto "
        f"PENDING. If they were previously promoted, this is a SILENT "
        f"DEMOTION an admin will need to notice and re-promote; this "
        f"function has no way to verify their prior team once LiteLLM "
        f"no longer recognizes the old key.",
        file=sys.stderr,
    )
    key = issue_key(config, email, config.pending_team_id)
    return key, get_current_team_id(config, key)


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
    key, team_id = _team_id_for_key_or_reissue(CONFIG, email, key)
    active = team_grants_access(CONFIG, team_id)
    return render_page(email, key, active, CONFIG)


@app.post("/regenerate", response_class=HTMLResponse)
def regenerate(request: Request) -> str:
    # Security review F5 (2026-09-30): /regenerate is student-facing,
    # not admin -- but a forged POST here (Cloudflare Access's cookie
    # travels automatically for a same-authenticated-user request, valid
    # JWT and all) would silently invalidate a student's working key.
    # Same same-origin defense as the admin routes below, first thing on
    # the route.
    #
    # Security review round 3, student-facing item (2026-09-30): a
    # rejection here renders a FRIENDLY HTML page instead of FastAPI's
    # default bare `{"detail": "..."}` JSON body -- see
    # render_regenerate_origin_mismatch_page()'s docstring for the
    # reasoning. This changes only how the rejection is PRESENTED, never
    # what gets rejected: verify_same_origin()'s comparison itself is
    # untouched, and it is the only thing this try/except catches --
    # every other failure on this route (bad/missing auth, a
    # revoke_and_reissue() error) still surfaces normally.
    try:
        verify_same_origin(request, CONFIG)
    except HTTPException:
        return HTMLResponse(
            content=render_regenerate_origin_mismatch_page(CONFIG),
            status_code=403,
        )
    email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    key = revoke_and_reissue(CONFIG, email)
    # Security review round 4, B5 fix 3 (2026-09-30): revoke_and_reissue()
    # should always hand back a key LiteLLM just minted, but Door 2 of
    # B5 (the delete-succeeds-then-issue_key-fails window restoring the
    # row to an old_key LiteLLM has already deleted) means that is not
    # guaranteed. Same defensive wrap as index(), for the same reason.
    key, team_id = _team_id_for_key_or_reissue(CONFIG, email, key)
    active = team_grants_access(CONFIG, team_id)
    return render_page(email, key, active, CONFIG)


@app.get("/admin", response_class=HTMLResponse)
def admin_index(request: Request) -> str:
    email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    require_admin(email, CONFIG)
    # Security review B3 (2026-09-30): read the roster (pure sqlite, no
    # outbound HTTP) BEFORE the key list, and read the key list through
    # the fail-safe wrapper -- a LiteLLM problem must never take the
    # roster down with it. This is precisely the moment an admin needs
    # the roster most: when the key path is misbehaving and they are
    # trying to fix someone's access.
    preauthorized = list_preauthorized(CONFIG)
    users = _list_issued_users_or_none(CONFIG)
    return render_admin_page(email, users, preauthorized, CONFIG)


@app.post("/admin/promote", response_class=HTMLResponse)
async def admin_promote(request: Request) -> str:
    # Security review F5 (2026-09-30): same-origin check first, before
    # any auth or parsing -- cheap, and applies regardless of auth state.
    verify_same_origin(request, CONFIG)
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
    # Security review round 3, B1-A (2026-09-30): making these routes
    # `async def` (for the F3 fix's `await request.form()`) put them ON
    # the event loop -- but promote_user()/demote_user()/
    # add_preauthorized_emails()/remove_preauthorized_email() all do
    # SYNCHRONOUS blocking I/O (sync httpx to LiteLLM, sync sqlite), and
    # list_preauthorized()/_list_issued_users_or_none() do the same.
    # With no `await` covering them, one admin POST blocked the ENTIRE
    # process for its whole duration -- measured: a single call froze a
    # co-running heartbeat for ~2 seconds, serving nothing else at all,
    # not even /healthz (which a container health check depends on).
    # run_in_threadpool() moves each blocking call to AnyIO's worker
    # threadpool so the event loop stays free for every other request
    # while this one is in flight -- the same threadpool
    # Starlette/AnyIO already uses for the sync `def` routes elsewhere
    # in this file (see _lock_for_email()'s docstring).
    await run_in_threadpool(promote_user, CONFIG, target_email, target_team)
    # Security review B3 (2026-09-30): roster first, key list through
    # the fail-safe wrapper -- a stale key elsewhere must not turn a
    # SUCCESSFUL promote into a 500 with no way to tell it worked.
    preauthorized = await run_in_threadpool(list_preauthorized, CONFIG)
    users = await run_in_threadpool(_list_issued_users_or_none, CONFIG)
    return render_admin_page(admin_email, users, preauthorized, CONFIG)


@app.post("/admin/demote", response_class=HTMLResponse)
async def admin_demote(request: Request) -> str:
    verify_same_origin(request, CONFIG)
    admin_email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    require_admin(admin_email, CONFIG)
    form = await request.form()
    target_email = _required_form_field(form, "target_email")
    await run_in_threadpool(demote_user, CONFIG, target_email)  # the mutation
    preauthorized = await run_in_threadpool(list_preauthorized, CONFIG)
    users = await run_in_threadpool(_list_issued_users_or_none, CONFIG)
    return render_admin_page(admin_email, users, preauthorized, CONFIG)


@app.post("/admin/preauthorize", response_class=HTMLResponse)
async def admin_preauthorize(request: Request) -> str:
    verify_same_origin(request, CONFIG)
    admin_email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    require_admin(admin_email, CONFIG)
    form = await request.form()
    emails = _required_form_field(form, "emails")
    # Security review B3 (2026-09-30): the mutation AND its report are
    # computed and held here, BEFORE anything that could still fail --
    # `result` is the ONLY channel telling the admin which addresses
    # were added/already-present/rejected, and it must survive even if
    # the key-list read below does not.
    result = await run_in_threadpool(add_preauthorized_emails, CONFIG, emails)
    preauthorized = await run_in_threadpool(list_preauthorized, CONFIG)
    users = await run_in_threadpool(_list_issued_users_or_none, CONFIG)
    return render_admin_page(
        admin_email, users, preauthorized, CONFIG, preauthorize_result=result
    )


@app.post("/admin/preauthorize/remove", response_class=HTMLResponse)
async def admin_preauthorize_remove(request: Request) -> str:
    verify_same_origin(request, CONFIG)
    admin_email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    require_admin(admin_email, CONFIG)
    form = await request.form()
    target_email = _required_form_field(form, "target_email")
    # the mutation
    await run_in_threadpool(remove_preauthorized_email, CONFIG, target_email)
    preauthorized = await run_in_threadpool(list_preauthorized, CONFIG)
    users = await run_in_threadpool(_list_issued_users_or_none, CONFIG)
    return render_admin_page(admin_email, users, preauthorized, CONFIG)


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}
