# ADR-039 — VM SSH over Cloudflare Access via short-lived certificates

- **Status:** Proposed (extends the held PR `feat/vm-ssh-cloudflare-automation` → PR #406; base `main`, no auto-merge, DRY_RUN=1). Closes the live-test gap that ADR-038 alone left open.
- **Date:** 2026-07-15
- **Repo:** platform-infra
- **Deciders:** operator (Clayton) + security track; drafted by architect
- **Relates to / builds on:** ADR-038 (automatic per-VM-tenant Cloudflare SSH provisioning — tunnel route + Access app), ADR-032a (VM SSH via Cloudflare Tunnel, Option C/D), ADR-032 (KubeVirt VM workloads), ADR-028/D-036 (Cloudflare-Tunnel edge), [[capstone-cloudflare-wildcard-tls]], [[capstone-vm-ssh-needs-shortlived-certs]].

---

## Context — SSH-over-Access does not complete today

ADR-038 makes per-VM-tenant SSH provisioning zero-touch: the `cf-vm-access` reconciler
creates the Tunnel public-hostname route (`ssh-<app>.<domain> → ssh://<app>-ssh…:22`)
and a Cloudflare Access self-hosted app (Allow = the team's emails). A **2026-07-15 live
test** proved every one of those pieces works — tunnel route present, Access app present,
browser-rendering ON, valid Access token, healthy key-only sshd — **and SSH still fails**:

- **CLI:** `ssh -o ProxyCommand='cloudflared access ssh --hostname ssh-vmssh…'` returns
  `Connection closed by UNKNOWN port 65535` instantly, and cloudflared logs show **no
  request reaching the connector** — the Cloudflare edge rejects the legacy clientless SSH
  stream for a browser-rendering Self-hosted app. This is the documented signature of a
  browser-rendering SSH app that has **no short-lived-certificate CA configured**.
- **Browser terminal:** the terminal renders but cannot authenticate — the guest is
  **key-only** (cloud-init installs the team's `sshPubKey` into `authorized_keys` and sets
  `ssh_pwauth:false`, ADR-032a D1), and Cloudflare connects from its side with **no user
  key**. No password, no key → no login.

The root cause is the same for both paths: **the guest offers no credential Cloudflare can
satisfy.** Cloudflare Access's answer to exactly this is **short-lived SSH certificates**:
after Access authenticates the user, Cloudflare mints an ephemeral SSH certificate signed by
a Cloudflare-held CA; if the guest sshd **trusts that CA**, the cert authenticates the user
with no password and no user key — for **both** the browser terminal and `cloudflared
access ssh`.

## The decisive research question — is the Access SSH CA per-account or per-application?

This determines the entire distribution design, so it was resolved decisively against the
Cloudflare docs (2026-07-15):

| | **Legacy short-lived certs** (self-hosted SSH app) | **Access for Infrastructure** |
| --- | --- | --- |
| CA scope | **Per-APPLICATION** — you pick the Access app, then generate/fetch its CA | **Per-ACCOUNT** — one Gateway CA for all targets |
| Get the CA | Dashboard **or API**: `POST /accounts/{id}/access/apps/{app_id}/ca` → `{id, aud, public_key}` (also `GET`/`DELETE`) | `POST`/`GET /accounts/{id}/access/gateway_ca` → `public_key` |
| Client | Works with **`cloudflared access ssh`** (CLI) **and** the browser terminal — no agent | **Requires the WARP / Cloudflare One client** on every laptop, plus Targets + Split Tunnels; `ssh <user>@<target-IP>` |
| App model | The **`type: self_hosted`** app ADR-038 already creates | A different model (Infrastructure Targets), not self-hosted apps |
| Principal | Email prefix (`jdoe@…` → cert principal `jdoe`) | UNIX usernames enumerated in the Target policy |

Citations: Cloudflare One — *Short-lived certificates (legacy)*
(`/cloudflare-one/access-controls/applications/non-http/short-lived-certificates-legacy/`);
*SSH with Access for Infrastructure*
(`/cloudflare-one/identity/users/short-lived-certificates/`); Cloudflare API — *Create a
short-lived certificate CA*
(`/api/…/access/subresources/applications/subresources/cas/methods/create/`).

### Verdict: the per-APPLICATION legacy CA

Three reasons make per-app the right (and only fitting) choice here:

1. **It keeps the model the platform already has and students expect.** ADR-032a's promise is
   "SSH from any laptop with a standard client" — `cloudflared access ssh` (or the browser,
   zero-install). Access for Infrastructure would force **WARP on every student laptop** plus
   Targets/Split-Tunnels — a heavier client and a re-architecture away from the self-hosted
   app + tunnel-route model ADR-038 built. The per-app legacy CA works with the **exact
   `type: self_hosted` app the reconciler already creates** and the exact connect commands
   already documented.
2. **Per-app CA is a security feature, not just a legacy detail.** Each VM trusts **only its
   own app's CA**, so a cert minted for VM-B's app (a different Access policy / different
   team) **cannot** authenticate to VM-A. That is genuine **per-VM cryptographic isolation**.
   A single per-account Gateway CA would collapse that: any user who passed *any* target's
   policy would hold a cert every VM trusts, leaving isolation entirely to Access policy with
   no crypto boundary. For a shared student cluster, the per-app boundary is worth keeping.
3. **It is fully automatable.** The per-app CA has a first-class API
   (`POST /accounts/{id}/access/apps/{app_id}/ca`), so the reconciler that already owns the
   Access app can mint/fetch the CA with the same in-cluster token — no dashboard step, no
   new credential.

## Decision

Adopt **Cloudflare Access short-lived SSH certificates (legacy, per-application CA)** as the
primary SSH auth for VM tenants, keeping key-only as the break-glass fallback.

1. **Guest trusts the CA (cloud-init).** `skeleton-vm` cloud-init writes
   `/etc/ssh/cf_access_ca.pub` and an sshd drop-in
   `/etc/ssh/sshd_config.d/10-cf-access-ca.conf`:
   ```
   PubkeyAuthentication yes
   TrustedUserCAKeys /etc/ssh/cf_access_ca.pub
   AuthorizedPrincipalsCommand /bin/bash -c "echo '%t %k' | ssh-keygen -L -f - | grep -A1 Principals"
   AuthorizedPrincipalsCommandUser nobody
   ```
   The `AuthorizedPrincipalsCommand` authorizes **whatever principal is on the CA-signed
   cert** for the login user (Cloudflare sets it to the user's email prefix, which need not
   match the `fedora`/`ubuntu` cloud user) — the documented "any Access user → this
   username" pattern. **The Access email-allowlist policy is the real gate**; sshd trusts the
   per-app CA to have authenticated the user before signing. The CA file is a
   `TrustedUserCAKeys` file (authorized_keys format): comments/blank lines are ignored, so an
   **empty file (the default) simply means cert auth is inactive** and the guest is reachable
   only via the `authorized_keys` fallback — sshd still starts cleanly.

2. **Reconciler mints + logs the per-app CA (ADR-038 `cf-vm-access`).** `reconcile_access`
   now, for each tenant's Access app, ensures the app's short-lived-cert CA (`GET`, else
   `POST` — idempotent) and **logs the public key** on a greppable line. `GET` is read-only,
   so the pubkey is logged even under `DRY_RUN=1`. No new RBAC and no new credential — it
   reuses the reconciler's existing account-scoped CF token.

3. **CA reaches the guest by GitOps (operator paste, one lossless recreate).** The CA is
   **public**, so it is committed, not sealed. The operator pastes the logged pubkey into the
   rendered tenant repo's `cloud-init.yaml` (`/etc/ssh/cf_access_ca.pub`) and recreates the
   VM so first boot bakes it. Done **during onboarding** (before the team stores data), the
   recreate is lossless. After it, browser SSH + `cloudflared access ssh` both work with no
   user key.

## Why the CA cannot just be baked at scaffold time (the chicken-and-egg)

The per-app CA does not exist until the Access **app** exists, and the app is created by the
reconciler **after** the VM's `<app>-ssh` Service appears in-cluster — i.e. **after first
boot**. And a KubeVirt guest **cannot read the cluster API** (no ConfigMap/Secret the guest
can pull, unlike a container), while cloud-init runs **once** per instance. So there is no
way to have a correct CA in the guest at the very first boot without either (a) giving the
Backstage scaffolder its own CF token to pre-create the app+CA at render time — rejected for
the same reason ADR-038 rejected Option B (the token must stay **sealed in-cluster**, not in
Backstage/Actions), or (b) one GitOps recreate after the reconciler mints the CA. We choose
(b): **key-only first boot (fallback works), then bake-and-recreate during onboarding.** This
keeps the token in-cluster and adds no new credential surface. The per-tenant paste is the
one residual manual touch (see "needs a human decision").

## Alternatives considered

- **Access for Infrastructure / per-account Gateway CA (single static CA baked into every
  VM).** Tempting — one CA, dead-simple distribution, a real API. **Rejected:** it requires
  the **WARP client on every laptop** + Targets + Split Tunnels (breaks "any laptop with a
  standard ssh client / zero-install browser"), it is a re-architecture off the self-hosted
  app + tunnel model, **and** it discards per-VM crypto isolation (one CA every VM trusts).
  The convenience is not worth those three losses for a student fleet. (Kept on the record as
  the path to revisit **if** the platform ever standardizes on WARP enrollment.)
- **Scaffolder pre-creates the app+CA at render, bakes the CA into cloud-init (true
  first-boot zero-touch).** Rejected now: needs a CF token inside Backstage/onboarding —
  contrary to the seal-in-cluster posture. Noted as a **future** once an in-cluster
  pre-provision step (a reconciler "pre-pass" keyed off the onboarding ledger) can create the
  app+CA before the VM boots without exporting the token.
- **Reconciler writes the CA into a per-tenant ConfigMap / pushes it to the tenant repo.** The
  ConfigMap does not help — the guest cannot read it. Pushing to the tenant repo would give
  the reconciler a **GitHub write credential** (today it holds only a CF token + read-only
  `list services`), enlarging its blast radius. Logging the pubkey for the operator keeps the
  reconciler least-privilege. **Auto-committing the CA to the tenant repo is the clean way to
  remove the last manual step and is flagged as the recommended follow-up** (a scoped
  installation token, or a GitHub Action keyed on the reconciler output).
- **Keep key-only, expose SSH some other way (bastion / public TCP).** Rejected by ADR-032a
  (D2 chose the $0 tunnel); and it would not give the browser terminal, which is the
  zero-install path for non-terminal students.

## Consequences

- **Positive:** SSH-over-Access actually completes — **both** the browser terminal and
  `cloudflared access ssh`, with **no user key and no password** in the guest. Per-app CA
  gives per-VM crypto isolation. No new credential and no new RBAC (reuses the reconciler's
  CF token; `GET` CA works even in dry-run so the operator sees the pubkey before enforcing).
  Key-only fallback is preserved unchanged (break-glass / direct / bastion), and an empty CA
  file is a safe no-op, so nothing regresses if the paste is skipped.
- **Negative / flagged:**
  - **One per-tenant manual paste + VM recreate** during onboarding (the chicken-and-egg
    tax). Lossless if done before the team stores data. Removing it (auto-commit the CA to the
    tenant repo) is the recommended follow-up.
  - **First boot is key-only**, so the browser terminal does not work until the CA is baked.
    Acceptable: onboarding already has a provisioning window (disk import + boot + reconcile);
    the CA bake fits inside it.
  - **Untested against a live account** (agents cannot do CF writes; no token sealed yet). The
    CA API shape (`POST …/apps/{app_id}/ca`) is documented and simple, but this is part of the
    same supervised first-run ADR-038 already flags. In particular confirm the reconciler's
    self-hosted app is configured for **SSH browser rendering** (the live test reported it
    ON); short-lived certs presuppose that.
  - **`AuthorizedPrincipalsCommand` trusts any principal on a CA-signed cert.** That is by
    design (Access policy is the gate), but it means the **email-allowlist policy is
    load-bearing** — a misconfigured/empty Allow policy plus a trusted CA would admit anyone
    Access lets through. The reconciler already defaults an empty email list to an
    admits-nobody policy; keep that invariant. Security-track sign-off item.

## What this ADR/PR adds on top of ADR-038

- `skeleton-vm/.devops/chart/base/cloud-init.yaml` — writes `/etc/ssh/cf_access_ca.pub`
  (templated `cfAccessCaPub`, empty default) + the sshd CA drop-in; restarts sshd; keeps the
  `authorized_keys` fallback.
- `vm-app/template.yaml` — passes `cfAccessCaPub: ""` to the render; PR-body gains step 4
  (grep the reconciler log for the CA, paste, recreate).
- `platform-services/cf-vm-access/reconcile.py` — `_ensure_app_ca()` mints/fetches and logs
  the per-app CA; called from `reconcile_access` (dry-run logs existing CAs).
- Docs: this ADR, `docs/operator/vm-ssh-cloudflare-access.md` (corrected working flow +
  per-tenant CA checklist), and an ADR-038 cross-reference.

## Not done / needs a human decision

- **Operator (per tenant, during onboarding):** grep the reconciler log for the CA pubkey,
  paste it into the tenant repo's cloud-init, recreate the VM. (Checklist in the operator
  doc.) One-time platform setup (seal CF token, set IDs, review dry-run, `DRY_RUN=0`) is the
  same ADR-038 already documents.
- **Decision to make:** accept the per-tenant paste, **or** fund the follow-up that
  auto-commits the CA to the tenant repo (reconciler/Action with a scoped GitHub token) to
  make cert auth fully zero-touch. Recommended: ship the paste now, do the auto-commit next.
- **Security track:** sign off that the email-allowlist Access policy is the sole gate in
  front of a CA sshd trusts (per-app CA limits blast radius to one VM), and that
  `AuthorizedPrincipalsCommand`-trust-any-principal is acceptable given that gate.
- **First supervised run:** confirm the app is set for SSH browser rendering and that the
  `POST …/apps/{app_id}/ca` response carries `public_key` on this account.
