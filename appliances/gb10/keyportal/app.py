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

import os
import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass
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
    cf_access_team_domain: str
    cf_access_aud: str
    allowed_email_suffixes: tuple
    admin_contact: str
    db_path: str

    @property
    def jwks_url(self) -> str:
        return f"https://{self.cf_access_team_domain}/cdn-cgi/access/certs"


def load_config() -> Config:
    return Config(
        litellm_base_url=_require_env("LITELLM_BASE_URL"),
        litellm_master_key=_require_env("LITELLM_MASTER_KEY"),
        pending_team_id=_require_env("PENDING_TEAM_ID"),
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
        db_path=os.environ.get("KEYPORTAL_DB_PATH", "/data/keyportal.db"),
    )


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
    """
    resp = httpx.get(
        f"{config.litellm_base_url}/key/info",
        headers={"Authorization": f"Bearer {config.litellm_master_key}"},
        params={"key": key},
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
        httpx.post(
            f"{config.litellm_base_url}/key/delete",
            headers={"Authorization": f"Bearer {config.litellm_master_key}"},
            json={"keys": [old_key]},
            timeout=15.0,
        )
    return issue_key(config, email, team_id)


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


CONFIG = load_config()
JWKS_CLIENT = PyJWKClient(CONFIG.jwks_url)
init_db(CONFIG.db_path)

app = FastAPI()


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> str:
    email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)
    key = get_cached_key(CONFIG.db_path, email)
    if key is None:
        key = issue_key(CONFIG, email, CONFIG.pending_team_id)
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


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}
