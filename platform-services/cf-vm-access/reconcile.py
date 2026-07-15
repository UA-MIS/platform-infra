#!/usr/bin/env python3
# =============================================================================
# cf-vm-access reconciler (ADR-038) — provisions per-VM-tenant Cloudflare SSH
# access (Tunnel public-hostname route + Access application) so a VM tenant's
# SSH path is ZERO-TOUCH: no operator dashboard clicks per tenant.
#
# DESIRED STATE = the set of per-tenant SSH ClusterIP Services in-cluster
# (label platform.capstone/access=ssh, shipped by skeleton-vm's ssh-service.yaml).
# For each such Service the reconciler ensures, on the SHARED platform tunnel:
#   1. a Tunnel public-hostname ingress rule
#        ssh-<app>.<domain>  ->  ssh://<app>-ssh.<ns>.svc.cluster.local:22
#      inserted BEFORE the platform's `*.<domain> -> traefik` wildcard (SSH has no
#      Host header, so it cannot ride the shared HTTP route — it needs its own,
#      more-specific rule, and first-match ordering means it must precede the
#      wildcard). NOTE the SINGLE-label `ssh-<app>` host (not dotted `ssh.<app>`) —
#      required by the one-level `*.<domain>` TLS wildcard (ADR-038).
#   2. a Cloudflare Access self-hosted application on that hostname with an Allow
#      policy that includes the team's emails (annotation
#      platform.capstone/ssh-access-emails on the Service). SSH has no OIDC of its
#      own, so Access is the only auth in front of the hostname (sshd is key-only
#      as a backstop).
#   3. a per-app SHORT-LIVED-CERT CA (ADR-039) for that Access app, and LOGS its
#      public key. The guest sshd must trust this CA for SSH-over-Access to complete
#      (browser terminal + `cloudflared access ssh`); the operator pastes the logged
#      pubkey into the tenant's cloud-init (/etc/ssh/cf_access_ca.pub). This is what
#      turns the key-only guest (which rejects both Access paths) into one that
#      accepts Cloudflare-minted certs. See _ensure_app_ca + the operator doc.
# TEARDOWN is automatic: when a VM tenant is torn down its namespace (and the ssh
# Service) is deleted, so the Service disappears from the desired set and the
# reconciler REMOVES the stale tunnel rule + Access app on its next pass.
#
# DNS: NOT provisioned here. The platform already has a wildcard
# `*.<domain> CNAME <tunnel>.cfargotunnel.com`, which already resolves every
# single-label `ssh-<app>.<domain>` to the tunnel — a per-tenant CNAME would be
# redundant. (This is also why the host MUST be one label: the wildcard is one level.)
#
# SAFETY (this touches the SINGLE tunnel config that also carries the platform's
# one load-bearing `*.<domain> -> traefik` HTTP route — a mistake here could take
# the whole platform offline):
#   * DRY_RUN=1 (default) logs the plan and writes NOTHING. The operator reviews a
#     dry-run's logs, then flips DRY_RUN=0 in git (mirrors crossplane-mr-prune).
#   * The tunnel PUT is a GET-merge-PUT that only INSERTS/REMOVES our own SSH rules
#     (hostname `ssh-*` + service `ssh://…`); every other rule is preserved
#     verbatim, in order.
#   * WILDCARD GUARD: if the fetched config does not already end in a catch-all
#     rule (a rule with no `hostname`), the reconciler ABORTS the tunnel PUT — it
#     never writes a config that could drop the platform's HTTP route.
#   * Missing token / unconfigured IDs => graceful no-op exit 0 (so the app syncs
#     clean before the operator seals the real token at go-live).
#
# Stdlib only (urllib/json/ssl) so it runs on python:3-slim with no pip install
# (works under a :443-only egress posture).
# =============================================================================
import json
import os
import ssl
import sys
import urllib.request
import urllib.error

DOMAIN = os.environ.get("PLATFORM_DOMAIN", "").strip()
ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip()
TUNNEL_ID = os.environ.get("CF_TUNNEL_ID", "").strip()
CF_TOKEN = os.environ.get("CF_API_TOKEN", "").strip()
DRY_RUN = os.environ.get("DRY_RUN", "1").strip() != "0"
SSH_LABEL = os.environ.get("SSH_SVC_LABEL", "platform.capstone/access=ssh").strip()
EMAILS_ANNOTATION = "platform.capstone/ssh-access-emails"
SESSION_DURATION = os.environ.get("CF_ACCESS_SESSION", "24h").strip()

CF_API = "https://api.cloudflare.com/client/v4"
# Managed-resource discriminators (so we only ever touch what WE created).
# SSH host is a SINGLE hyphenated label under <domain> — `ssh-<app>.<domain>` — NOT
# the dotted `ssh.<app>.<domain>`: the platform TLS cert is `*.capstone.uamishub.com`,
# a ONE-label wildcard, so a 2-label host (`ssh.<app>.…`) is not cert-covered and the
# HTTPS/Access handshake fails (SSL_ERROR_NO_CYPHER_OVERLAP). See [[capstone-cloudflare-
# wildcard-tls]] + ADR-038. `ssh-<app>` is one label → cert-valid + wildcard-DNS-covered.
SSH_HOST_PREFIX = "ssh-"
ACCESS_APP_TAG = "vm-ssh:"  # embedded in the Access app name to mark ours


def log(msg):
    print(msg, flush=True)


# --------------------------------------------------------------------------- #
# Kubernetes API (in-cluster) — enumerate the desired SSH tenants.
# --------------------------------------------------------------------------- #
def k8s_list_ssh_services():
    host = os.environ.get("KUBERNETES_SERVICE_HOST")
    port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
    sa = "/var/run/secrets/kubernetes.io/serviceaccount"
    with open(f"{sa}/token") as f:
        token = f.read().strip()
    ctx = ssl.create_default_context(cafile=f"{sa}/ca.crt")
    label = urllib.parse.quote(SSH_LABEL)
    url = f"https://{host}:{port}/api/v1/services?labelSelector={label}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        data = json.load(resp)

    tenants = []
    for item in data.get("items", []):
        meta = item.get("metadata", {})
        name = meta.get("name", "")           # <app>-ssh
        ns = meta.get("namespace", "")        # <team>-vm-prod
        if not name.endswith("-ssh") or not ns:
            log(f"  skip Service {ns}/{name}: not an <app>-ssh Service")
            continue
        app = name[: -len("-ssh")]
        emails_raw = (meta.get("annotations", {}) or {}).get(EMAILS_ANNOTATION, "")
        emails = [e.strip() for e in emails_raw.replace(";", ",").split(",") if e.strip()]
        tenants.append(
            {
                "app": app,
                "namespace": ns,
                "hostname": f"{SSH_HOST_PREFIX}{app}.{DOMAIN}",
                "service": f"ssh://{name}.{ns}.svc.cluster.local:22",
                "emails": emails,
            }
        )
    return tenants


# --------------------------------------------------------------------------- #
# Cloudflare API helpers.
# --------------------------------------------------------------------------- #
def cf(method, path, body=None):
    url = f"{CF_API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {CF_TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise RuntimeError(f"CF {method} {path} -> HTTP {e.code}: {detail}") from None


# --------------------------------------------------------------------------- #
# Tunnel public-hostname reconcile (GET-merge-PUT, wildcard-preserving).
# --------------------------------------------------------------------------- #
def reconcile_tunnel(tenants):
    log("== Tunnel ingress reconcile ==")
    resp = cf("GET", f"/accounts/{ACCOUNT_ID}/cfd_tunnel/{TUNNEL_ID}/configurations")
    config = (resp.get("result") or {}).get("config") or {}
    ingress = list(config.get("ingress") or [])
    if not ingress:
        log("  ERROR: tunnel returned an EMPTY ingress list — refusing to write "
            "(cannot safely reconstruct the platform catch-all). No change.")
        return False

    def is_managed(rule):
        h = rule.get("hostname", "") or ""
        s = rule.get("service", "") or ""
        return h.startswith(SSH_HOST_PREFIX) and h.endswith(f".{DOMAIN}") and s.startswith("ssh://")

    non_managed = [r for r in ingress if not is_managed(r)]

    # WILDCARD GUARD — the last non-managed rule must be the catch-all (no hostname).
    if not non_managed or non_managed[-1].get("hostname"):
        log("  ERROR: no catch-all (hostname-less) rule at the end of the tunnel "
            "config after removing our SSH rules — refusing to PUT so the platform "
            "HTTP route can never be dropped. No change.")
        return False

    desired = [
        {"hostname": t["hostname"], "service": t["service"]}
        for t in sorted(tenants, key=lambda t: t["hostname"])
    ]
    new_ingress = desired + non_managed

    if new_ingress == ingress:
        log(f"  up to date ({len(desired)} SSH route(s); catch-all preserved).")
        return False

    log(f"  plan: {len(desired)} SSH route(s) before the catch-all:")
    for r in desired:
        log(f"    + {r['hostname']} -> {r['service']}")
    removed = [r for r in ingress if is_managed(r) and r not in desired]
    for r in removed:
        log(f"    - {r.get('hostname')} (tenant gone)")

    if DRY_RUN:
        log("  DRY_RUN: not writing tunnel config.")
        return False

    new_config = dict(config)
    new_config["ingress"] = new_ingress
    cf("PUT", f"/accounts/{ACCOUNT_ID}/cfd_tunnel/{TUNNEL_ID}/configurations",
       {"config": new_config})
    log("  tunnel config updated.")
    return True


# --------------------------------------------------------------------------- #
# Access application reconcile (one self-hosted app per SSH hostname).
# --------------------------------------------------------------------------- #
def _managed_apps():
    resp = cf("GET", f"/accounts/{ACCOUNT_ID}/access/apps?per_page=1000")
    out = {}
    for a in resp.get("result") or []:
        if ACCESS_APP_TAG in (a.get("name") or ""):
            out[a.get("domain")] = a
    return out


def _ensure_policy(app_id, emails):
    include = [{"email": {"email": e}} for e in emails]
    if not include:
        # No emails => a policy that admits nobody is safer than an open app.
        include = [{"email": {"email": "__no-team-emails-configured__@invalid"}}]
    body = {"name": "team-allow", "decision": "allow", "include": include}
    existing = cf("GET", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}/policies")
    for p in existing.get("result") or []:
        cf("DELETE", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}/policies/{p['id']}")
    cf("POST", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}/policies", body)


def _ensure_app_ca(app_id, hostname):
    """Ensure the app's SHORT-LIVED-CERT CA exists and LOG its public key (ADR-039).

    SSH-over-Access only completes if the guest sshd TRUSTS this CA: after Access
    auth, Cloudflare mints a short-lived SSH cert signed by it, which authenticates
    both the browser terminal and `cloudflared access ssh` with no user key in the
    guest. Without it the guest is key-only and both paths fail (the live-test gap).

    The CA is PER-APP (`.../access/apps/{app_id}/ca`), created once, stable after.
    We GET it; if absent (HTTP 404) we POST to create it — idempotent per app. The
    public key (safe to log — it is public) is printed on a greppable line so the
    operator can paste it into the tenant's cloud-init `/etc/ssh/cf_access_ca.pub`
    (docs/operator/vm-ssh-cloudflare-access.md). Guest delivery is out of band on
    purpose: a VM cannot read the cluster API, and the CA does not exist until the
    app does (after first boot), so the operator bakes it via GitOps (one lossless
    recreate during onboarding). Per-app CA also gives per-VM crypto isolation.
    """
    pub = ""
    try:
        resp = cf("GET", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}/ca")
        pub = (resp.get("result") or {}).get("public_key", "")
    except RuntimeError as e:
        if "HTTP 404" not in str(e):
            raise
        if DRY_RUN:
            log(f"    DRY_RUN: would create short-lived-cert CA for {hostname}")
            return
        resp = cf("POST", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}/ca")
        pub = (resp.get("result") or {}).get("public_key", "")
    if pub:
        # Greppable marker — the scaffolder PR body tells the operator to grep this.
        log(f"    CA public key for {hostname} (paste into cloud-init cf_access_ca.pub):")
        log(f"    {pub}")
    else:
        log(f"    WARNING: no CA public key returned for {hostname}")


def reconcile_access(tenants):
    log("== Access application reconcile ==")
    desired = {t["hostname"]: t for t in tenants}
    existing = _managed_apps()

    for hostname, t in sorted(desired.items()):
        app = existing.get(hostname)
        if app:
            log(f"  ensure app {hostname} (emails: {', '.join(t['emails']) or 'NONE'})")
            if not DRY_RUN:
                _ensure_policy(app["id"], t["emails"])
            # GET-ing the CA is read-only, so we log it even in dry-run (the operator
            # needs the pubkey to bake). CA failure must not block the reconcile.
            try:
                _ensure_app_ca(app["id"], hostname)
            except Exception as e:  # noqa: BLE001
                log(f"    CA ensure/log FAILED for {hostname}: {e}")
        else:
            log(f"  CREATE app {hostname} (emails: {', '.join(t['emails']) or 'NONE'})")
            if not DRY_RUN:
                created = cf("POST", f"/accounts/{ACCOUNT_ID}/access/apps", {
                    "name": f"{ACCESS_APP_TAG}{t['app']}",
                    "domain": hostname,
                    "type": "self_hosted",
                    "session_duration": SESSION_DURATION,
                })
                app_id = created["result"]["id"]
                _ensure_policy(app_id, t["emails"])
                try:
                    _ensure_app_ca(app_id, hostname)
                except Exception as e:  # noqa: BLE001
                    log(f"    CA ensure/log FAILED for {hostname}: {e}")
            else:
                log(f"    DRY_RUN: would create app + short-lived-cert CA for {hostname}")

    for hostname, app in sorted(existing.items()):
        if hostname not in desired:
            log(f"  DELETE app {hostname} (tenant gone)")
            if not DRY_RUN:
                cf("DELETE", f"/accounts/{ACCOUNT_ID}/access/apps/{app['id']}")


# --------------------------------------------------------------------------- #
def main():
    log(f"cf-vm-access reconciler (DRY_RUN={DRY_RUN})")
    missing = [n for n, v in
               (("PLATFORM_DOMAIN", DOMAIN), ("CF_ACCOUNT_ID", ACCOUNT_ID),
                ("CF_TUNNEL_ID", TUNNEL_ID), ("CF_API_TOKEN", CF_TOKEN)) if not v]
    if missing:
        log(f"  not configured yet ({', '.join(missing)} unset) — no-op. "
            "Seal the token + set the IDs to activate (see the operator checklist).")
        return 0

    tenants = k8s_list_ssh_services()
    log(f"  {len(tenants)} VM SSH tenant(s) discovered in-cluster:")
    for t in tenants:
        log(f"    - {t['hostname']} -> {t['service']} "
            f"({len(t['emails'])} email(s))")

    rc = 0
    try:
        reconcile_tunnel(tenants)
    except Exception as e:  # noqa: BLE001 — one subsystem failing must not block the other
        log(f"  tunnel reconcile FAILED: {e}")
        rc = 1
    try:
        reconcile_access(tenants)
    except Exception as e:  # noqa: BLE001
        log(f"  access reconcile FAILED: {e}")
        rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
