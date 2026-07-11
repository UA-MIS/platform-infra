# portal — the apex landing/routing page

A tiny static site (2 self-contained HTML/CSS pages, `nginxinc/nginx-unprivileged`,
no JS framework, no backend) at the platform's root domain,
`https://capstone.uamishub.com`. It's a signpost, not a marketing site: tell a
visitor what this platform is, and route UA-MIS members to the tools.

## Routes

| Route | Audience | What's there |
| --- | --- | --- |
| `/` | Public, no login | Project name + short description, links to live student prod apps, a "Sign in" button. |
| `/internal` | UA-MIS members only (Dex/GitHub org, gated) | Quick links to every platform tool (Backstage, ArgoCD, Grafana, Harbor, DB consoles) with a one-line "what is this" for each. Vault is listed but not linked (no public UI by design — see below). |

Both routes are served by the same `portal` Deployment/Service; the split is at
the Ingress layer (`ingress.yaml`, two `Ingress` objects on one host, more
specific `/internal` path wins via explicit `router.priority`).

## Gating: reuses the existing shared oauth2-proxy — no new Dex client

`/internal` is gated by a `Middleware` (`middleware.yaml`) that forwardAuths to
the **same shared `oauth2-proxy` instance** every DB console already uses
(`platform-services/db-console-auth/`), the same "one GitHub OAuth app, N tools"
singleton, already registered with Dex as the `db-console` staticClient. This PR
adds **no new Dex staticClient** — it's the exact same pattern as
`platform-services/db-admin/middleware.yaml`, just without an
`allowed_groups=` scope (any authenticated UA-MIS org member passes; org
membership is already enforced upstream at Dex's GitHub connector,
`orgs: [UA-MIS]`, SEC-007).

Because oauth2-proxy's session cookie is shared across the whole
`.capstone.uamishub.com` domain, a member already signed in anywhere (ArgoCD,
Harbor, a DB console) hits `/internal` already authenticated — no second login.

## ⚠ One-time human step: Cloudflare Tunnel apex route

The existing Cloudflare Tunnel Public Hostname route only covers
`*.capstone.uamishub.com` (a wildcard subdomain entry — see
`platform-services/cloudflared/deployment.yaml`'s header). That does **not**
also match the bare apex `capstone.uamishub.com`; Cloudflare Tunnel treats the
wildcard and the exact root as two separate DNS/route entries. Before this is
publicly reachable, add a second Public Hostname in the Cloudflare Zero Trust
dashboard (Tunnels &rarr; the platform tunnel &rarr; Public Hostname &rarr; Add):

```
Hostname: capstone.uamishub.com   (no subdomain)
Service:  http://traefik.kube-system.svc.cluster.local:80
```

Identical target to the existing wildcard route — this only adds the missing
apex DNS entry, it does not change anything else. No git-side change can do
this (Cloudflare dashboard-only setting, same class as the tunnel token). Until
this is done, `capstone.uamishub.com` will not resolve/route publicly even
though the in-cluster Ingress/TLS are correct.

## ⚠ Post-auth redirect must land on `https://` (Traefik forwarded-headers)

**Symptom (fixed):** clicking "Sign in" completed the OIDC round-trip but then
landed the browser on `capstone.uamishub.com:8080/internal/` → Firefox *"SSL
received a record that exceeded the maximum permissible length"*. Auth succeeded;
only the final redirect target was wrong (scheme/port).

**Root cause:** public TLS terminates at the Cloudflare edge and cloudflared dials
Traefik's `web` entrypoint over **plain HTTP**. By default Traefik does not trust a
downstream's `X-Forwarded-*` headers, so it saw the request as `http` and
reconstructed request-origin URLs (the `{url}` the `oauth2-proxy-errors` Middleware
feeds into the post-login `rd`) as `http://…` on a non-default port. The browser
was then bounced to an `http`/`:8080` apex URL; the Secure session cookie can't
ride the plaintext leg (→ redirect loop = "sign-in hangs"), and `:8080` (Traefik's
`traefik` API entrypoint port) is a plaintext Cloudflare port, so TLS to it throws
the record-length error.

**Fix (git):** `applicationsets/traefik-app.yaml` now sets
`ports.{web,websecure}.forwardedHeaders.trustedIPs: [10.244.0.0/16]` (the cluster
pod CIDR = cloudflared's source range). Traefik now honors cloudflared's
`X-Forwarded-Proto: https`, so `{url}` → `https://capstone.uamishub.com/internal/`
(default 443 omitted). This fixes **every** tunnel-fronted auth redirect uniformly —
the apex `/internal` gate and every `db-admin`/per-tenant DB console share this same
`oauth2-proxy` + `oauth2-proxy-errors` Middleware.
> Note: oauth2-proxy's own `--force-https`/`--reverse-proxy` do **not** fix this — the
> `rd` origin is built by Traefik's `{url}` and passed to oauth2-proxy as an absolute
> URL, so the correction has to happen at Traefik.

**Operator steps (Cloudflare dashboard — belt-and-suspenders, not git):**
1. SSL/TLS → Edge Certificates → **Always Use HTTPS: ON** (so no plaintext client
   leg can exist even if a stray `http://` URL is produced).
2. Confirm SSL/TLS mode is **Full** (edge↔tunnel is the encrypted tunnel; origin is
   the ClusterIP over the tunnel).

**Verify after `platform-traefik` re-syncs (ArgoCD) / the Traefik pods roll:**
```bash
# 1) unauthenticated apex gate: the OIDC `state` must carry an https, port-less rd
curl -sS -D- -o /dev/null https://capstone.uamishub.com/internal/ \
  | grep -io 'state=[^&]*' | sed 's/%3A/:/g;s/%2F/\//g'
#    EXPECT: ...:https://capstone.uamishub.com/internal/   (was http://…, no :8080)

# 2) a db-console still redirects correctly (shared middleware, don't-break check)
curl -sS -D- -o /dev/null https://db-admin.capstone.uamishub.com/ \
  | grep -io 'state=[^&]*' | sed 's/%3A/:/g;s/%2F/\//g'
#    EXPECT: ...:https://db-admin.capstone.uamishub.com/

# 3) confirm Traefik took the trustedIPs arg
kubectl -n kube-system get deploy traefik -o jsonpath='{.spec.template.spec.containers[0].args}' \
  | tr ',' '\n' | grep forwardedHeaders
#    EXPECT: --entryPoints.web.forwardedHeaders.trustedIPs=10.244.0.0/16 (and websecure)
```
Then a real browser: `https://capstone.uamishub.com` → Sign in → completes on
`https://capstone.uamishub.com/internal/` with **no** `:8080` and no TLS error.
If step 1 still shows `http://`, cloudflared isn't sending `X-Forwarded-Proto` or its
source IP is outside `10.244.0.0/16` — check `kubectl -n cloudflared get pods -o wide`
and widen the trusted range, or (dashboard) repoint the tunnel origin to
`https://traefik.kube-system.svc.cluster.local:443` with **No TLS Verify** so Traefik
terminates TLS natively (scheme becomes https with zero header dependency).

## Verified: apex was not already claimed

Before adding this, the repo was searched for any existing `Ingress`/
`IngressRoute` using the bare host `capstone.uamishub.com` — none exists. Every
other platform/tenant host is a single- or two-level subdomain
(`argocd.`, `harbor.`, `id.`, `db-admin.`, `process.`, `<app>.`,
`<team>-<env>-db.`, etc.). The apex only appeared as a SAN on the wildcard TLS
`Certificate` (`platform-services/cert-manager/wildcard-certificate.yaml`) —
anticipated, never wired to an Ingress until now.

## "Live on the platform" list (public page)

The public page's app list is a small **static** list (currently the two live
`tenants/_claims/` entries: `swamiapp`, `swami-student3`), hand-maintained in
`site/index.html`. There is no public, unauthenticated catalog API to source
this from dynamically today (Backstage's catalog lives behind its own login).
Update `site/index.html` by hand when a new prod tenant app should be
showcased publicly; a Backstage-catalog-driven version is a reasonable
post-v1 follow-up, not in scope here.

## Validate

```bash
kubectl kustomize platform-services/portal | kubeconform -strict -summary -kubernetes-version 1.31.5 -
curl -sk https://capstone.uamishub.com/          # public, 200
curl -sk https://capstone.uamishub.com/internal   # unauthenticated -> 302 to Dex/GitHub login
```
