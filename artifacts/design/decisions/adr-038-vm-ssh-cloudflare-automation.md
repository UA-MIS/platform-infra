# ADR-038 — Automatic per-VM-tenant Cloudflare SSH provisioning

- **Status:** Proposed (held PR `feat/vm-ssh-cloudflare-automation`; base `main`, no auto-merge). Ships DRY_RUN=1 (report-only) — go-live is an operator token-seal + a supervised dry-run review + a `DRY_RUN=0` flip.
- **Date:** 2026-07-14
- **Repo:** platform-infra
- **Deciders:** operator (Clayton) + security track; drafted by architect
- **Supersedes:** the per-tenant **manual** Cloudflare-dashboard steps in ADR-032a §D2 and `docs/operator/vm-ssh-cloudflare-access.md` (those remain the documented fallback until the one-time CF API token is set up).
- **Relates to:** ADR-032a (VM SSH via Cloudflare Tunnel, Option C/D), ADR-032 (KubeVirt VM workloads), ADR-028/D-036 (Cloudflare-Tunnel edge), ADR-031 (Crossplane zero-touch onboarding), SEC-011 (Cilium netpol).
- **⚠ Necessary but not sufficient — see [ADR-039](adr-039-vm-ssh-shortlived-certificates.md).** This ADR provisions the tunnel route + Access app, which get the Access **login** working but do **not** make SSH complete: a live test (2026-07-15) proved a key-only guest rejects both `cloudflared access ssh` (`Connection closed by UNKNOWN port 65535`) and the browser terminal (Cloudflare presents no user key). **ADR-039** adds the missing half — short-lived-certificate CA trust in the guest — and extends this same reconciler (`reconcile_access` now mints + logs the per-app CA) and this same held PR.

---

## Context

A VM tenant reaches public SSH over the platform's existing Cloudflare Tunnel
(ADR-032a D2). Per VM tenant, an operator does **3 manual Cloudflare-dashboard steps**:

1. **Tunnel public hostname:** `ssh-<app>.capstone.uamishub.com` → Type SSH → `<app>-ssh.<team>-vm-prod.svc.cluster.local:22`.
2. **Access self-hosted application** on that hostname, policy Allow = the team's emails.
3. **DNS CNAME** `ssh-<app>` → `<tunnelid>.cfargotunnel.com` (auto-created by step 1).

Everything else about a VM tenant is already automatic (the web ingress rides the
wildcard `*.capstone → traefik`; the tenant tier is rendered from `_template-vm`).
Only these SSH resources are manual, because SSH is a raw TCP route (no Host header to
demux in Traefik) that also needs an Access app for auth. The operator directive:
**automate them (create on onboard, delete on teardown), zero-touch for every future
VM tenant.** The CF API token is being created by the operator now, to be sealed
in-cluster like the other platform CF/secret creds.

### The binding constraints

- **The tunnel is token-based / remotely-managed.** `cloudflared` runs `tunnel run`
  with only `TUNNEL_TOKEN`; its ingress routing table lives in the Cloudflare edge,
  not in git. Today it holds exactly one rule: `*.capstone.uamishub.com → http://traefik.kube-system.svc:80` (plus the mandatory trailing catch-all).
- **That one wildcard rule is load-bearing for the WHOLE platform.** Every public
  hostname (argocd/harbor/backstage/id/portal/every tenant app) resolves through it.
  Dropping it takes the entire platform offline. Any automation that touches the
  tunnel config must preserve it with certainty.
- **The tunnel ingress is a single, ordered, shared list.** SSH multiplexes by
  *nothing* (no SNI/Host), so each VM needs its own `ssh-<app> → ssh://…:22` rule, and
  because matching is first-match top-down, each must sit **before** the `*.capstone`
  wildcard (which would otherwise swallow `ssh-<app>.capstone`). So provisioning a VM
  tenant = **inserting one rule into a shared ordered list and keeping everything else**.
- **VM tenants have no Crossplane claim/XR.** They deploy from the git *directory*
  generator over `tenants/team-<team>/vm/` (ADR-032); their AppProject `<team>-vm`
  whitelists only namespaced VM/networking kinds and **no cluster-scoped or Crossplane
  MR kinds**. There is no per-tenant XR to hang per-tenant managed resources on, and no
  place in the tenant tree that could legally hold a Crossplane MR.
- **DNS is already handled.** The wildcard `*.capstone.uamishub.com CNAME <tunnel>.cfargotunnel.com` already resolves every `ssh-<app>` to the tunnel — a per-tenant CNAME is redundant. (Manual step 3 was only ever a "verify".)
- **The SSH host MUST be a single hyphenated label — `ssh-<app>.capstone.uamishub.com`, NOT `ssh.<app>.capstone.uamishub.com`.** The platform TLS cert is `*.capstone.uamishub.com` (Advanced Cert — a **one-level** wildcard, SANs = `capstone.uamishub.com` + `*.capstone.uamishub.com`). A TLS wildcard matches exactly one label, so the dotted 2-label `ssh.<app>.capstone…` is **not cert-covered** — the browser-SSH HTTPS handshake and `cloudflared access` both fail (`SSL_ERROR_NO_CYPHER_OVERLAP` / verify=1). The single-label `ssh-<app>` is cert-valid AND covered by the one-level wildcard DNS. **This corrects a pre-existing bug:** ADR-032a's D2 note, PR #402, and `docs/operator/vm-ssh-cloudflare-access.md` all specified the **wrong dotted `ssh.<app>` form** — the automation generates the hyphenated form and those docs are corrected in this PR. (Surfaced by a live test; see memory `capstone-cloudflare-wildcard-tls`.)

## Decision

Ship an **in-cluster reconciler** (`platform-services/cf-vm-access/`, a CronJob) that
drives the Cloudflare API directly. **Desired state = the set of in-cluster `<app>-ssh`
Services** (label `platform.capstone/access=ssh`, already shipped by `skeleton-vm`).
Each reconcile:

1. **Tunnel route (GET-merge-PUT).** GET the tunnel configuration, remove our own SSH
   rules, re-insert one per live SSH Service **before** the untouched remainder
   (wildcard + catch-all stay exactly where they are), PUT only if changed.
2. **Access application.** Ensure one self-hosted Access app per hostname with an Allow
   policy including the team's emails (read from the Service annotation
   `platform.capstone/ssh-access-emails`); delete apps whose tenant is gone.
3. **DNS:** nothing (wildcard covers it).

**Teardown is automatic:** on VM-tenant teardown the namespace + `<app>-ssh` Service are
deleted, so the tenant drops out of desired state and the next reconcile removes its
tunnel rule + Access app.

The CF API token is a **SealedSecret** (`cloudflare-api-token`, namespace `cloudflared`,
sealed exactly like `cloudflared-tunnel-token`). The non-secret IDs (`CF_ACCOUNT_ID`,
`CF_TUNNEL_ID`, `PLATFORM_DOMAIN`) live in a ConfigMap — both account and tunnel id are
also recoverable from the existing tunnel token (`base64(JSON){"a":…,"t":…,"s":…}`).

### Safety (this touches the platform's single most critical route)

- **DRY_RUN=1 by default** (mirrors `crossplane-mr-prune`): logs the plan, writes
  nothing. The held PR merges report-only. Go-live = operator seals the token, sets the
  IDs, reviews a dry-run's log, then flips `DRY_RUN=0` in git.
- **GET-merge-PUT, never blind PUT.** Only our SSH rules (hostname `ssh-*` + service
  `ssh://…`) are touched; every other rule is preserved verbatim and in order.
- **Wildcard/catch-all guard.** If the fetched config's non-SSH remainder does not end
  in a hostname-less catch-all rule, the reconciler **aborts the PUT** — it can never
  write a config that drops the platform's HTTP route. An empty/absent ingress also
  aborts.
- **Graceful no-op when unconfigured** (missing token or IDs → exit 0), so the app
  syncs clean before go-live and never CrashLoops.
- **Least privilege:** the reconciler's only in-cluster RBAC is read-only `list
  services`; it holds no Secret read and writes no in-cluster object. Its one privileged
  credential (the CF token) never leaves `cloudflared`.

## Why not Crossplane (Option A) — the platform is Crossplane-heavy, so this needs justifying

Researched the actual provider landscape (2026-07-14):

- **The official successor is not usable.** Crossplane's Community-Extensions list points
  to `crossplane-contrib/provider-upjet-cloudflare`, but that repo has **zero releases /
  zero tags** (its `install.yaml` references a `v0.1.0` package that does not exist) and
  — confirmed by full CRD-tree search — **no `AccessApplication`/`AccessPolicy` CRDs at
  all** (only a legacy IP `AccessRule`). It cannot gate SSH by email. Pre-alpha, not
  deployable.
- **The only complete provider is an unvetted third-party fork.** `wildbitca/provider-upjet-cloudflare` (v0.2.13, published two days prior) does have `TrustTunnelCloudflaredConfig`, `TrustAccessApplication`, `TrustAccessPolicy` (email-list gating), and DNS `Record`. But its maintainer identity is unverified and the package is unsigned/unaudited — adding it to the tenant-provisioning supply chain is a security decision the quality bar says needs a SEC review, for a single narrow use case.
- **The tunnel-config MR would clobber the wildcard.** Decisive regardless of provider:
  both providers are thin Upjet wrappers of Terraform's
  `cloudflare_zero_trust_tunnel_cloudflared_config`, backed by `PUT /accounts/{id}/cfd_tunnel/{id}/configurations` — **replace-the-whole-list semantics**. `spec.forProvider.config.ingress` is authoritative; on every reconcile it overwrites anything not listed, **including the dashboard-set `*.capstone → traefik` wildcard**. A declarative MR that ever rendered without the wildcard (a template slip, a bad reconcile) would take the platform offline. The reconciler's GET-merge-PUT + catch-all guard is precisely the mitigation the research recommended — and it is far safer to encode that guard imperatively than to trust a whole-list MR to always contain the wildcard.
- **Structural mismatch anyway.** A shared, ordered, single-object ingress list has no
  clean representation as independent per-tenant MRs (Crossplane's model), and VM tenants
  have no XR/Composition to fan out from (unlike container tenants under ADR-031). Even
  the "clean" per-tenant pieces (Access app, DNS) would need a per-VM-tenant XR that the
  ADR-032a D5/D6 design deliberately kept *inert* (`_vm-claims` is a teardown ledger, not
  a live claim).

So Crossplane is the right tool for the container-tenant fan-out (ADR-031) but the wrong
tool for a shared-ordered-list-with-a-load-bearing-catch-all on a remotely-managed tunnel.

## Alternatives considered

- **Option B — GitHub Action keyed on `tenants/_vm-claims/**`.** Same CF-API mechanism,
  triggered by the onboarding/teardown PR diff. Rejected as the primary because the token
  would live in **GitHub Actions secrets, not sealed in-cluster** — contrary to the
  operator's explicit "seal it in-cluster" directive and the platform's
  secrets-live-in-Vault/Sealed posture. (The reconciler borrows B's direct-API mechanism
  but runs in-cluster off a SealedSecret.)
- **Convert the tunnel to a locally-managed `config.yaml`** (git-served ingress). Makes
  the tunnel declaratively git-managed but is a bigger change to the deliberate D-036
  token-tunnel topology, and a shared config file still has the per-tenant merge problem.
  Out of scope; noted as a possible future.
- **Enumerate from the `_vm-claims` git ledger instead of in-cluster Services.** Rejected:
  Services are the true in-cluster desired state (self-healing; teardown = Service gone),
  need no git clone, and already carry the team + can carry the emails.

## Consequences

- **Positive:** every future VM tenant is zero-touch for SSH — onboard provisions,
  teardown de-provisions, no dashboard clicks, no stale CF entries accumulating. One
  sealed token + two IDs is the entire one-time setup. The load-bearing wildcard is
  protected by an explicit guard, not by hope. No new provider added to the supply chain.
- **Negative / flagged:**
  - **Untested against a live tunnel** (no token yet, agents can't do CF/cluster writes).
    Mitigated by DRY_RUN-first + the guard; **go-live requires the operator to review a
    dry-run log before enforcing.** The Cloudflare **Access** API endpoints/bodies are the
    part most likely to need a small first-run tweak (isolated in `reconcile_access`); the
    tunnel path is the well-documented `configurations` endpoint.
  - **~5-min provisioning latency** (CronJob cadence). Acceptable — VM disk import + boot
    take longer; an on-demand `kubectl create job --from=cronjob/...` exists.
  - **Team emails live in git** (the Service annotation) — low sensitivity (same
    university emails already in the GitHub org), not secret. Note for the security track.
  - **Access provisioning is defense-in-depth, not the sole gate:** sshd is key-only
    (ADR-032a D1), so a lagging/incorrect Access app never *grants* unauthorized shell —
    worst case it delays a legitimate user, it does not open the VM.
  - Scaffolder change: a new required `teamEmails` wizard input (git-served skeleton +
    template, no Backstage rebuild).

## What this PR implements

- `platform-services/cf-vm-access/` — the reconciler: `reconcile.py`, `cronjob.yaml`
  (DRY_RUN=1), `serviceaccount.yaml` + `rbac.yaml` (read-only Services), `configmap-ids.yaml`
  (operator IDs), `kustomization.yaml`, `README.md` (one-time token/IDs setup). Auto-picked
  up as `platform-svc-cf-vm-access` by the platform-services-appset.
- `skeleton-vm/.devops/chart/base/ssh-service.yaml` — adds the `platform.capstone/team`
  label + `platform.capstone/ssh-access-emails` annotation (desired-state inputs).
- `vm-app/template.yaml` — new `teamEmails` input; passes it to the render; PR-body step 3
  now says "automatic"; reviewer checklist gains the label/annotation check; end-user text
  updated.
- Docs: `docs/operator/vm-ssh-cloudflare-access.md` (now-automatic flow + one-time setup),
  this ADR, and the ADR-032a D2 note marked superseded.

## Not done / needs a human decision

- **Operator:** create the CF API token, seal it, set the two IDs, review a dry-run, flip
  `DRY_RUN=0` (checklist in the operator doc + dir README).
- **Security track:** sign-off on (a) emails-in-git, (b) the reconciler holding an
  account-scoped CF token that can edit tunnel config + Access. (Token is Tunnel+Access+DNS
  edit only — not account admin.)
- **First supervised run:** confirm the live tunnel-config PUT shape and the Access API
  endpoint/body against the real account (the one untestable-by-agent surface).
