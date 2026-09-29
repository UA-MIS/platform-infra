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

## Changing concurrency limits (policy — live, no restart)

Use the LiteLLM admin UI at `https://local-llm.uamishub.com/ui` (ops-only
in practice, but not enforced by Access — Cloudflare Access on this
hostname allows any `@crimson.ua.edu`/`@ua.edu` login; treat the UI
credential (`LITELLM_MASTER_KEY`) as the real gate) or `curl` the
`/team/update` and `/key/update` endpoints directly. No restart needed.

## Promoting a new user (D11)

A new key starts in the `pending` team with zero model access. To
activate someone: LiteLLM admin UI → find their key (issued to their
UA email) → change its team to `students` or `faculty` → done, no key
reissue needed, no action required from the person themselves — the
same key they already copied into their editor starts working. See
Task 7 for why this doesn't require a reissue, and Task 11 for how the
portal shows "pending" vs "active" state.

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
