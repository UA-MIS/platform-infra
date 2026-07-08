# db-console-auth — shared SSO gate for the DB consoles

The ONE oauth2-proxy instance that fronts every per-(team,env) Adminer console
(rendered by the `CapstoneTenant` Composition) and the platform-admin Adminer
(`platform-services/db-admin/`). Federates to Dex as the `db-console` staticClient
(`platform-services/dex/configmap.yaml`) — same broker, same "one GitHub OAuth app,
N tools" model as ArgoCD/Harbor/Backstage. Full design:
`artifacts/research/tenant-db-access.md` §3.

- Host: `https://db-auth.capstone.uamishub.com` (login/callback UI only — nobody
  browses here directly; it's the OIDC round-trip target).
- Internal Service: `oauth2-proxy.db-console-auth.svc.cluster.local:4180` — every
  console's Traefik `Middleware` calls `/oauth2/auth` on this Service.
- Image: `quay.io/oauth2-proxy/oauth2-proxy:v7.15.3` (pinned).
- Managed by the `platform-services-appset` (one Application per dir).

## How the gate works (per console)

1. A student's browser requests `https://<team>-<env>-db.capstone.uamishub.com/`.
2. Traefik's `Middleware` for that route (`forwardAuth`, rendered by the
   Composition) calls
   `http://oauth2-proxy.db-console-auth.svc:4180/oauth2/auth?allowed_groups=UA-MIS:<team>`.
3. If the student already has a valid oauth2-proxy session cookie (shared across
   `*.capstone.uamishub.com` via `--cookie-domain`) AND is a member of
   `UA-MIS:<team>`, oauth2-proxy returns 2xx -> Traefik forwards the request to the
   team's Adminer pod, which auto-logs the student into their team's DB (no typed
   password, ESO/Vault-sourced preset — see the Composition's ADMINER CONSOLE
   comments).
4. If unauthenticated or not in the group, oauth2-proxy returns 401/403. See the
   "known UX gap" note in `deployment.yaml`'s header — first-ever login needs a
   manual visit to `/oauth2/start?rd=<console-url>` (or opening any other Dex-SSO'd
   tool first); this is documented, not silently broken.

## Operator activation (one-time, human-reviewed, like Dex/ArgoCD/Harbor)

1. **Register the `db-console` Dex client secret** —
   `platform-services/dex/README.md` "DB console static client" section. Generates
   ONE secret value, sealed into BOTH `platform-services/dex/sealedsecret.yaml`
   (`db-console-client-secret` key) AND this dir's `sealedsecret.yaml`
   (`client-secret` key) — they MUST match.
2. **No Cloudflare Tunnel change needed.** Every hostname this design uses
   (`db-auth.capstone.uamishub.com`, `<team>-<env>-db.capstone.uamishub.com`,
   `db-admin.capstone.uamishub.com`) is a SINGLE-LABEL subdomain of
   `capstone.uamishub.com` — already covered by the existing ONE wildcard tunnel
   route (`*.capstone.uamishub.com -> Traefik`, configured once in the Cloudflare
   dashboard, `platform-services/cloudflared/deployment.yaml` header) and the
   existing Advanced Certificate (same level as `harbor.`/`argocd.`/`id.` and every
   tenant app host like `swami.capstone.uamishub.com`). Confirmed by inspection —
   no dashboard action required for this feature.
3. **Merge this PR.** ArgoCD syncs `platform-svc-db-console-auth` (this dir) — the
   oauth2-proxy Deployment starts (with the placeholder client-secret, so SSO
   doesn't work yet) and `platform-svc-dex` picks up the new staticClient on its
   next `kubectl -n dex rollout restart deploy/dex` (config changes don't
   auto-restart Dex, same as every other client add).
4. **Do the re-seal in step 1**, commit, merge, then:
   ```bash
   kubectl -n dex rollout restart deploy/dex
   kubectl -n db-console-auth rollout restart deploy/oauth2-proxy
   ```
5. **Merge the netpol widening** (`platform-services/db-tier/netpol.yaml`) and the
   Composition changes (already in THIS PR) so a tenant's console Deployment can
   actually reach `db-tier` and the ADMINER CONSOLE ExternalSecret can read Vault.

## Validate

```bash
kubectl -n db-console-auth get pods
curl -sk https://db-auth.capstone.uamishub.com/ping
# -> "OK"

# End-to-end (after a tenant with database != none exists, e.g. swami-swamiapp dev):
# open https://swami-dev-db.capstone.uamishub.com/ -> redirected through Dex/GitHub
# (or straight through if already SSO'd elsewhere) -> Adminer auto-logs into the
# swami dev database, no password typed.
```
