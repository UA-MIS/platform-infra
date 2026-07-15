# VM tenant SSH — Cloudflare Tunnel (ADR-032a D2, resolved)

> ## ⚠ NOW AUTOMATIC (ADR-038) — the per-tenant dashboard steps below are the FALLBACK
> As of **ADR-038**, the three per-tenant Cloudflare steps (Tunnel public hostname →
> Access application → DNS) are provisioned **automatically** by the in-cluster
> `cf-vm-access` reconciler (`platform-services/cf-vm-access/`) — it reads each VM
> tenant's `<app>-ssh` Service (label + emails annotation) and creates/removes the
> Cloudflare resources on onboard/teardown. **You do NOT do the manual steps below per
> tenant** once the **one-time** token setup is done — see
> **`platform-services/cf-vm-access/README.md`** (create a scoped CF API token → seal it
> → set the account/tunnel IDs → review a dry-run → flip `DRY_RUN=0`). The manual
> per-tenant checklist in this doc remains ONLY as the fallback for before that one-time
> setup exists.
>
> ## ⚠ HOSTNAME CORRECTION — use `ssh-<app>`, NOT `ssh.<app>`
> The SSH hostname is the **single hyphenated label** `ssh-<app>.capstone.uamishub.com`,
> **not** the dotted `ssh.<app>.capstone.uamishub.com`. The platform TLS cert is a
> **one-level** wildcard `*.capstone.uamishub.com`, which does not cover a 2-label host —
> the dotted form fails the HTTPS/Access handshake (`SSL_ERROR_NO_CYPHER_OVERLAP`). This
> doc (and ADR-032a / PR #402) previously specified the wrong dotted form; it is corrected
> throughout. The automation always emits the hyphenated form.

**Audience:** platform operator (holds the Cloudflare account/API token). The **manual**
steps in this doc are Cloudflare **dashboard** writes; the **automated** path (ADR-038)
uses a scoped CF API **token** sealed in-cluster (agents still can't seal it — that is the
operator's one-time keyboard step, `platform-services/cf-vm-access/README.md`).

**What this unblocks:** public SSH into a KubeVirt VM tenant (`ssh <cloud-user>@...`)
from a team's laptop — the gap ADR-032a's D2 left as an open operator decision
(`artifacts/design/decisions/adr-032a-vm-tenant-access-ux.md`).

---

## Decision — cheapest/easiest = reuse the existing Cloudflare Tunnel

The platform already runs one $0 Cloudflare Tunnel (`cloudflared`, `platform-services/
cloudflared/`) for all HTTP traffic. Cloudflare Tunnel natively proxies **SSH**, not
just HTTP — so the SSH path needs **zero new infrastructure**: no MetalLB/LoadBalancer,
no public IP, no paid Cloudflare Spectrum (TCP proxy). It runs on the **Cloudflare
Zero Trust free tier** (≤50 seats), which this platform's team/seat count is well
under.

This corresponds to **Option C** (browser-rendered SSH via Cloudflare Access — the
ADR's zero-infra recommendation) plus **Option D** (`cloudflared access ssh` as a
native-`ssh`-client `ProxyCommand` — the ADR's power-user opt-in) from ADR-032a's
comparison table. Both reuse the exact same in-cluster pieces: the per-tenant
`<app>-ssh` ClusterIP Service (already shipped, `skeleton-vm/.devops/chart/base/
ssh-service.yaml`) and one new NetworkPolicy (already shipped in this PR, see below).
Neither needs Option A/B (a public TCP entrypoint) or Option E (a bastion pod).

## Why this is a dashboard step, not a git change

`platform-services/cloudflared/deployment.yaml` runs `cloudflared tunnel run` with
only `TUNNEL_TOKEN` — no mounted `config.yaml` / `credentials.json` / ingress
ConfigMap (verified: `kubectl get cm,secret -n cloudflared` shows nothing but the
tunnel-token Secret and the default `kube-root-ca.crt`). That means this tunnel is
**token-based / remotely-managed**: its Public Hostname routing table lives entirely
in the Cloudflare dashboard, not in this repo. Today it holds exactly one route
(`*.capstone.uamishub.com → http://traefik.kube-system.svc:80`, `platform-services/
cloudflared/deployment.yaml` header). Adding an SSH route is therefore **not a PR
that can flow through GitOps** — it must be added in the dashboard, per tenant, by
whoever holds the Cloudflare account. This doc is that checklist. (Converting the
tunnel to a locally-managed, git-served `config.yaml` would make this automatable,
but that is a bigger change to an existing, deliberate D-036 topology decision and is
out of scope here — flagged as a future improvement, not done.)

## What ships in git (this PR) vs. what you do by hand

| Piece | Where | Status |
| --- | --- | --- |
| Per-tenant SSH `ClusterIP` Service (`<app>-ssh` :22 → the VM) | `platform-services/backstage/templates/vm-app/skeleton-vm/.devops/chart/base/ssh-service.yaml` | Shipped (PR #386) |
| `sshPubKey` wizard input → cloud-init `authorized_keys`, password auth off | `skeleton-vm/.devops/chart/base/cloud-init.yaml`, `template.yaml` | Shipped (PR #386) |
| NetworkPolicy: ingress on :22 to the VM tier, from ns `cloudflared` only | `tenants/_template-vm/vm/namespaces/vm-prod.yaml` (rendered into every future `tenants/team-<team>/vm/namespaces/vm-prod.yaml` at onboarding time — no live VM tenant exists to backport as of this writing, `team-tenantvm` was torn down for a clean re-test) | **This PR** |
| Onboarding-PR reviewer checklist item + operator-steps block reminding a reviewer/operator to do the dashboard steps below, per tenant | `platform-services/backstage/templates/vm-app/template.yaml` | **This PR** |
| End-user docs (two connect commands) | `skeleton-vm/docs/index.md`, `template.yaml` scaffolder output text | **This PR** |
| Cloudflare Tunnel Public Hostname (SSH route) | Cloudflare dashboard | **You, per tenant** (below) |
| Cloudflare Access application + policy (who may connect) | Cloudflare dashboard | **You, per tenant** (below) |
| DNS CNAME for the `ssh-<app>...` hostname | Cloudflare dashboard (auto-created by the step above) | **You verify, per tenant** |

## Per-tenant operator checklist — FALLBACK ONLY (automated by ADR-038)

> Do this **only** if the one-time cf-vm-access token setup is not yet done
> (`platform-services/cf-vm-access/README.md`). Once it is, this is fully automatic and
> you skip this section entirely. Use `ssh-<appName>` (hyphen), never `ssh.<appName>`.

Repeat this after every VM-tenant onboarding PR merges (it is also embedded as an
"Operator steps" block in that PR's body, step 3). Needs: Cloudflare account access
with Zero Trust / Tunnels / Access permissions (the account holding the existing
`platform-svc-cloudflared` tunnel's API token).

1. **Add the SSH Public Hostname route.**
   Cloudflare dashboard → **Zero Trust → Networks → Tunnels** → select the platform
   tunnel (the one `cloudflared-tunnel-token` was minted for) → **Public Hostname** →
   **Add a public hostname**:
   - Subdomain: `ssh-<appName>`
   - Domain: `capstone.uamishub.com`
   - Path: (blank)
   - Service → Type: **SSH**
   - Service → URL: `<appName>-ssh.<team>-vm-prod.svc.cluster.local:22`
     (the Service's in-cluster DNS name; cloudflared resolves it directly — it runs as
     a cluster pod).

   Example for a team `acme` / app `acmeapp`:
   `ssh-acmeapp.capstone.uamishub.com` → SSH → `acmeapp-ssh.acme-vm-prod.svc.cluster.local:22`.

2. **Add a Cloudflare Access application to gate it.** SSH has no OIDC/Dex login of
   its own (unlike every other platform hostname, which is gated by in-cluster
   Dex/oauth2-proxy) — Access is the *only* auth in front of this hostname, so do not
   skip this step.
   Zero Trust → **Access → Applications → Add an application → Self-hosted**:
   - Application domain: `ssh-<appName>.capstone.uamishub.com`
   - Session duration: operator's choice (e.g. 24h)
   - Policy: **Allow** — Include: the team's UA-MIS emails (or an Access **Group** if
     you maintain one per team/cohort). Free tier covers this at the platform's
     current seat count (≤50 users total across all Access apps).
   - Leave "Instant Auth" / IdP choice at Cloudflare's default one-time-PIN email
     login unless you've already wired an Access IdP integration elsewhere on this
     platform (none exists today — every other hostname is gated by in-cluster
     Dex/oauth2-proxy, not Access).

3. **Verify the DNS CNAME.** Adding the Public Hostname in step 1 auto-creates a
   `ssh-<appName>.capstone.uamishub.com CNAME <tunnel-id>.cfargotunnel.com` DNS
   record — confirm it exists (Zero Trust → Networks → Tunnels → the route, or DNS →
   Records). No manual DNS entry should be needed.

4. **Smoke-test** from an authorized laptop (see connect commands below). A `Connection
   refused`/timeout most likely means the NetworkPolicy or Service didn't render for
   that tenant (check the onboarding-PR checklist item); an Access **login page with
   no further prompt** working but SSH itself failing usually means the Public
   Hostname's Service URL/port is wrong.

## Connect — two documented UXes (give both to the team)

**A — native `ssh` client (needs the free `cloudflared` binary installed once):**

```bash
# one-time per laptop
brew install cloudflared        # or your OS's cloudflared package

# every connection
ssh -o ProxyCommand='cloudflared access ssh --hostname ssh-<appName>.capstone.uamishub.com' \
    <cloud-user>@ssh-<appName>.capstone.uamishub.com
```

`cloudflared access ssh` opens a browser once for the Access login (or reuses a
cached short-lived cert from `cloudflared access login ssh-<appName>....`), then
proxies the SSH session over the tunnel. `<cloud-user>` is the VM's default cloud-init
user (`fedora`/`ubuntu`/`debian` depending on the base image). Teams can shorten this
to a bare `ssh <appName>` via a `Host` block in `~/.ssh/config` with the
`ProxyCommand` line baked in.

**B — browser, zero install:**

Open `https://ssh-<appName>.capstone.uamishub.com` directly in a browser. Cloudflare
Access authenticates the user (email login), then renders an SSH terminal in the
page — no client software needed on the laptop at all. This is the ADR's
zero-infra/zero-install interim path (satisfies "no client install, no VPN" even for
students who never touch a terminal-emulator config).

Both connect to the **same** Service/VM — pick whichever suits the team; nothing else
changes.

## Cost / infra confirmation

- **$0.** Reuses the tunnel that already exists; Cloudflare Access Zero Trust is free
  up to 50 seats.
- **No LoadBalancer, no MetalLB, no public IP, no Spectrum.** The tunnel remains
  outbound-only from the cluster's side, same as every other hostname today.
- **No image/CI/Backstage rebuild.** Everything on the git side of this change is
  template/manifest-only.

## Automation status — DONE (ADR-038)

The manual per-tenant burden described in earlier revisions of this doc is **resolved**
by **ADR-038**: option (b) below (drive the Cloudflare API from in-cluster automation)
is implemented as the `cf-vm-access` reconciler. It uses a scoped CF API token
(Tunnel + Access + DNS edit) sealed in-cluster and enumerates desired state from the
per-tenant SSH Services, so every future VM tenant is zero-touch and teardown cleans up
after itself. The one remaining human action is a **one-time** setup (token + IDs +
enable), documented in `platform-services/cf-vm-access/README.md`.

Still noted as a possible future (NOT needed by ADR-038): (a) converting the tunnel to a
locally-managed git-served `config.yaml` — a bigger change to the deliberate D-036
token-tunnel topology, deferred.
