# GB10 Local LLM Appliance

**This directory is NOT managed by ArgoCD.** Everything else in `platform-infra`
is GitOps — this is the one deliberate exception. `promaxgb10-d62a` is a
single, non-clustered Dell Pro Max (GB10) box that runs `docker compose`
directly on its DGX OS install. It is never joined to the Talos cluster
(see ADR/D5 in the design doc). If you are looking for the ArgoCD
Application that reconciles this directory: **there isn't one, on purpose.**

## What this is

A ten-service appliance serving `local-llm.uamishub.com`: vLLM
(Qwen3.8-27B-NVFP4, MTP speculative decoding) behind a LiteLLM proxy
(Postgres-backed, owns authorization/Teams/keys), fronted by a Cloudflare
Tunnel + Access (gates on `email ends with @crimson.ua.edu` OR
`email ends with @ua.edu` — students and faculty/staff respectively),
monitored by Prometheus/Grafana/Alertmanager, with a self-service key page.
**A new key defaults to zero model access** (a `pending` LiteLLM team) —
an admin has to manually promote a person to a real team before their key
does anything (D11). This is deliberate: the Access policy above gates
the whole university (~40,000 people), not a 50-person class.

Full rationale: `artifacts/design/2026-09-28-gb10-local-llm-design.md` in
the `Capstone-Modernization` repo. Full implementation plan (this
directory's own build log): `artifacts/planning/2026-09-28-gb10-local-llm-plan-a.md`
in the same repo.

## Why Tailscale is NOT in this compose file

It is installed natively on the host (`tailscaled`, its own systemd unit,
outside docker entirely) and deliberately excluded from `docker-compose.yml`.
This box's only access route once it moves to a campus office is the
tailnet — if Tailscale lived inside the same compose project as the
workload, a broken `.env`, a bad image pull, a compose misconfiguration, or
even the docker daemon being down could take SSH access down with it, at
exactly the moment you need it most to fix things remotely. Keeping it
host-native means the recovery path never shares a failure domain with the
thing it recovers. **Do not "clean this up" by moving it into compose** —
see Task 3 of the implementation plan for the full rationale.

## Deploying / redeploying

```bash
cd /opt/gb10-appliance-repo/appliances/gb10
sudo systemctl status gb10-appliance   # is the COMPOSE STACK running? (not Tailscale — that's `systemctl status tailscaled`)
sudo systemctl restart gb10-appliance  # full stack restart (~7min for vLLM to warm up)
docker compose logs -f litellm         # tail one service
```

## Changing vLLM settings (capacity — requires the 7-minute reload)

Edit the `vllm` service `command:` block in `docker-compose.yml`, then
`sudo systemctl restart gb10-appliance`. This is a planned, deliberate
change — never do it mid-class to handle a traffic spike.

Two rules learned the hard way (details in
[KV-CACHE-FP8-INCIDENT.md](KV-CACHE-FP8-INCIDENT.md)):

- **Edit it in git, not on the box.** This host has no reconciler, so a
  hand-edit of `docker-compose.yml` is silently invisible to everyone else
  and is lost or reverted on the next pull. Change the repo, then pull.
- **Never add `--kv-cache-dtype=fp8`.** On GB10 (SM121) it corrupts output
  past ~17k tokens and cut throughput 40%.
- `--max-model-len` and `litellm-config.yaml`'s `max_input_tokens` +
  `max_output_tokens` must move together (they sum to the window).

## Changing concurrency limits (policy — live, no restart)

Use the LiteLLM admin UI at `https://local-llm.uamishub.com/ui` (ops-only
in practice, but not enforced by Access — Cloudflare Access on this
hostname allows any `@crimson.ua.edu`/`@ua.edu` login; treat the UI
credential (`LITELLM_MASTER_KEY`) as the real gate) or `curl` the
`/team/update` and `/key/update` endpoints directly. No restart needed.

## Promoting a new user (D11)

A new key starts in the `pending` team with zero model access. To
activate someone, run the one script:

```bash
cd /opt/gb10-appliance-repo/appliances/gb10
set -a; source .env; set +a
./keyportal/promote-user.sh someone@crimson.ua.edu students   # or: faculty
```

That's the entire runbook — one command. No key reissue, no action
required from the person themselves: the same key they already copied
into their editor starts working, and the portal page flips from the
"not yet activated" message to the config block on their next reload.
Verified end to end against a real key (not a synthetic one), 2026-09-29:
`pending` → 429 on every request → `promote-user.sh` → same key, 200,
real model output → Regenerate → new key, faculty team preserved, old
key rejected.

**Do NOT use the LiteLLM admin UI's team dropdown directly on a
portal-issued key**, or call `/key/update` with only `team_id` by hand.
It will fail with `User=<email> is not a member of the team=<id>` for
any key issued before 2026-09-29 (a real bug, now fixed going forward —
see `keyportal/app.py`'s `issue_key()` docstring for the full
postmortem and `keyportal/promote-user.sh` for why the fix is two
LiteLLM calls, not one, for those older keys). Keys issued by the
current `keyportal/app.py` don't have this problem, but the script
handles both cases identically and is always safe to use — just always
use `promote-user.sh` rather than reaching for `/key/update` by hand.

If the LiteLLM admin UI is more convenient for something else (checking
spend, adjusting team budgets), that's still fine — it's specifically
the "move this key to a real team" action that has the trap above.

## Persistence

Postgres data live in a named Docker volume that survives a reboot,
brought up by the `gb10-appliance.service` systemd unit. The Cloudflare
tunnel is token-managed (no local credential file — see Task 8), so its
"persistence" is just `.env` surviving on disk, which it trivially does.
Tailscale's own node identity is host-level state owned by `tailscaled`
itself (its own package, its own systemd unit, its own persistence) and
comes back independently of whether the compose stack starts cleanly.
See Task 16 of the implementation plan for how these were verified,
separately, by reboot.

## Secrets

Real secrets live only in `.env` on the box, which is gitignored and was
never committed. See `.env.example` for the full list and who supplies
each one. The Tailscale auth key is the one secret consumed outside
compose entirely — by `tailscale up` directly (Task 3).

## The portal renders the Continue config block (no scripts)

The student page at `local-llm-keys.uamishub.com` shows a Continue config
block with the signed-in student's **own key already in it**, a Copy button,
and the steps to paste it under `models:` in the config Continue opens from
its gear icon. The block is generated by exactly one function,
`_manual_config_block()` in `keyportal/app.py`. A pending (not yet
activated) student sees a `<your key>` placeholder, never their key.

The earlier downloadable setup scripts (`/setup/macos-linux`,
`/setup/windows`) were **retired**: a copy-paste takes seconds, PowerShell
blocks downloaded scripts, and a second copy of the block in shell and
PowerShell is what kept drifting. The routes are gone (404). The student
page and its README are in `onboarding/README.md`.

Operationally: the keyportal image's build context is `appliances/gb10/keyportal/`
again (`docker compose build keyportal`); it only needs `app.py` and
`requirements.txt`. The student page is sent `Cache-Control: no-store`
because it embeds the live key.

## Key storage (keyportal holds raw keys in plaintext — deliberately)

`keyportal` stores every issued LiteLLM key **in the clear** in a sqlite
file at `/data/keyportal.db` (Docker volume `keyportal-data`), keyed by
email. This is a deliberate tradeoff, not an oversight: it's what lets
someone come back to `local-llm-keys.uamishub.com` days later and see
the *same* key again instead of a dead end, and it's what
`promote-user.sh` reads from to promote by email without needing the
person to paste their key back to an admin. LiteLLM itself never
returns a raw key value again after `/key/generate` — this cache is the
only place it exists outside the person's own editor config.

Mitigations in place, not a substitute for the tradeoff above:
- The file is chmod 0600 and its parent directory 0700, enforced by
  `init_db()` on every container start (owner-only; the container runs
  as root, so this bounds "owner" to "root inside this container").
  Verified live, 2026-09-29: `-rw------- ... keyportal.db`,
  `drwx------ ... /data`.
- The volume never leaves the box and is never bind-mounted anywhere
  else in `docker-compose.yml`.
- LiteLLM's own master key is never written to this file or exposed to
  the browser — only the low-privilege, per-user virtual keys are.

Who can still reach it: anyone with `docker exec`/root on the box (i.e.
`uamis` and anyone with its sudo access) can read this file directly —
`docker exec gb10-keyportal python3 -c "..."` (see `promote-user.sh`
for the exact pattern) or by reading the volume's path under
`/var/lib/docker/volumes/` with host root. That's the same trust
boundary as `.env` and every other secret on this box; nothing here
raises or lowers it.
