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

## ⚠ Post-auth redirect lands on `http://` (Traefik `{url}` uses the CONNECTION scheme)

**Status: NOT fixed by `forwardedHeaders.trustedIPs`.** An earlier revision of this
section claimed that `ports.{web,websecure}.forwardedHeaders.trustedIPs` corrected the
scheme. That claim is **wrong** and was disproved by direct experiment (2026-09-16,
Traefik v3.7.1 / chart 40.2.0) — see "Proof" below. `trustedIPs` is still set, and is
still correct for what it actually governs (which `X-Forwarded-*` values reach the
*backends*), but it does **not** influence `{url}`.

**Symptom:** every SSO-gated host — the apex `/internal` gate, `db-admin`, every
per-tenant DB console, and (since the non-prod-sso-gate PR) every tenant dev/staging
app host — emits an OIDC `state` whose embedded return URL is `http://`:

```
state=<nonce>:http%3A%2F%2Fmychef.staging.capstone.uamishub.com%2F
```

The `redirect_uri` is unaffected (it is the literal `--redirect-url` flag), so only the
post-login return target is downgraded.

**Root cause:** public TLS terminates at the Cloudflare edge; cloudflared dials
`http://traefik.kube-system.svc.cluster.local:80` — the `web` entrypoint — over **plain
HTTP**. Traefik builds the `{url}` that the `oauth2-proxy-errors` Middleware feeds into
the post-login `rd` from the **actual connection scheme** (`req.TLS != nil`), and
ignores `X-Forwarded-Proto` when doing so — *even from a trusted source IP*. Traefik
hands oauth2-proxy an already-absolute `rd=http://…`, and oauth2-proxy echoes it
verbatim into `state`.

> Note: oauth2-proxy's own `--force-https` / `--reverse-proxy` do **not** fix this —
> the `rd` origin is built by Traefik and arrives as an absolute URL, so oauth2-proxy
> never derives the scheme itself and has nothing to correct. `--reverse-proxy` only
> governs how oauth2-proxy infers its *own* request origin, which is not on this path.

**Proof (all four runs from inside the cluster, client `10.244.2.122` — a pod IP
squarely inside the trusted `10.244.0.0/16` range):**

| # | Connection | Headers sent | Resulting `state` scheme |
|---|------------|--------------|--------------------------|
| A | `:80` plaintext (`web`) | none | `http://` |
| B | `:80` plaintext (`web`) | `X-Forwarded-Proto: https` | `http://` |
| C | `:443` **real TLS** (`websecure`) | none | **`https://`** |
| D | `:80` plaintext (`web`) | `X-Forwarded-Proto` + `-Port` + `-Host` | `http://` |

B and D are the decisive pair: a trusted client sending the correct forwarded headers
changes nothing. C is the complement: only a genuine TLS connection yields `https://`.

**Actual user impact today: LOW — the round trip completes.** Cloudflare's "Always Use
HTTPS" is ON, so the browser's `http://` hop is 301'd to `https://` at the edge before
it reaches the origin, the Secure cookie then rides the https leg, and the user lands
signed in. The costs are (1) one extra redirect hop, and (2) the post-auth landing URL
traverses one cleartext request to the CF edge — no HSTS header is set on these hosts,
so the browser really does make that plaintext request.

**The real risk is latency-to-breakage, not present breakage.** Correctness currently
depends on a Cloudflare dashboard toggle that is not in git and is not monitored. If
"Always Use HTTPS" is ever turned off, every SSO login on every gated host breaks
at once — the Secure cookie cannot ride the plaintext leg and the sign-in loops
forever. Treat that toggle as load-bearing platform config.

**The actual fix (NOT git — requires human sign-off; fleet-wide):** repoint the
Cloudflare Tunnel origin from `http://traefik.kube-system.svc.cluster.local:80` to
`https://traefik.kube-system.svc.cluster.local:443` with `noTLSVerify: true`, so
Traefik terminates TLS natively and the connection scheme becomes `https` with zero
header dependency. The tunnel ingress config is **remotely managed** (cloudflared runs
from `TUNNEL_TOKEN`), so this is a Cloudflare dashboard/API change and cannot be
committed here. Routers already exist on `websecure` for every host (run C above
exercised a real tenant host through it), and `websecure` additionally carries the
900s `respondingTimeouts.readTimeout` that the Harbor blob-push path needs, which the
`web` entrypoint does not. Rollback is a one-field revert of the same origin value.

**Operator steps (Cloudflare dashboard — belt-and-suspenders, not git):**
1. SSL/TLS → Edge Certificates → **Always Use HTTPS: ON** (so no plaintext client
   leg can exist even if a stray `http://` URL is produced).
2. Confirm SSL/TLS mode is **Full** (edge↔tunnel is the encrypted tunnel; origin is
   the ClusterIP over the tunnel).

**Current state — these commands SHOW THE BUG, they do not confirm a fix.**
Until the tunnel origin is repointed (above), 1 and 2 return `http://`. Treat a
`https://` result as evidence the origin change landed:
```bash
# 1) unauthenticated apex gate: the OIDC `state` must carry an https, port-less rd
curl -sS -D- -o /dev/null https://capstone.uamishub.com/internal/ \
  | grep -io 'state=[^&]*' | sed 's/%3A/:/g;s/%2F/\//g'
#    TODAY:  ...:http://capstone.uamishub.com/internal/    <-- the bug
#    AFTER FIX: ...:https://capstone.uamishub.com/internal/

# 2) a db-console still redirects correctly (shared middleware, don't-break check)
curl -sS -D- -o /dev/null https://db-admin.capstone.uamishub.com/ \
  | grep -io 'state=[^&]*' | sed 's/%3A/:/g;s/%2F/\//g'
#    TODAY:  ...:http://db-admin.capstone.uamishub.com/    <-- same bug, same cause
#    AFTER FIX: ...:https://db-admin.capstone.uamishub.com/

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
