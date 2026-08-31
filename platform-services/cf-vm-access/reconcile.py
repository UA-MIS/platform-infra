#!/usr/bin/env python3
# =============================================================================
# cf-vm-access reconciler (ADR-038) — provisions per-VM-tenant Cloudflare SSH
# access (Tunnel public-hostname route + Access application) so a VM tenant's
# SSH path is ZERO-TOUCH: no operator dashboard clicks per tenant.
#
# DESIRED STATE = the set of per-tenant SSH ClusterIP Services in-cluster
# (label platform.capstone/access=ssh). NOTHING here is keyed on a hardcoded
# tenant name: add a Service, the host appears; delete it, the host goes away.
#
# For each such Service the reconciler ensures, on the SHARED platform tunnel:
#   1. a Tunnel public-hostname ingress rule
#        <team>-ssh.<domain>  ->  ssh://<app>-ssh.<ns>.svc.cluster.local:22
#      inserted BEFORE the platform's catch-all rule (SSH carries no Host header,
#      so it cannot ride the shared HTTP route — it needs its own, more-specific
#      rule, and first-match ordering means it must precede the catch-all).
#   2. a Cloudflare Access self-hosted application on that hostname with an Allow
#      policy built from the team's emails (annotation
#      platform.capstone/ssh-access-emails on the Service). SSH has no OIDC of its
#      own, so Access is the only auth in front of the hostname (sshd is key-only
#      as a backstop).
#   3. a per-app SHORT-LIVED-CERT CA (ADR-039) for that Access app, and LOGS its
#      public key. The guest sshd must trust this CA for SSH-over-Access to
#      complete; the operator pastes the logged pubkey into the tenant's
#      cloud-init (/etc/ssh/cf_access_ca.pub).
#
# ---------------------------------------------------------------------------
# HOSTNAME SHAPE — `<team>-ssh.<domain>` under the APEX (changed from PR #406)
# ---------------------------------------------------------------------------
# PR #406 emitted `ssh-<app>.capstone.uamishub.com`. This emits `<team>-ssh.<domain>`
# with domain = `uamishub.com`. The REASONING is unchanged and still load-bearing:
# the TLS wildcard is ONE level, so the SSH host must be a SINGLE label under the
# domain it sits in. A dotted `ssh.<team>.<domain>` is two levels and is NOT
# cert-covered (SSL_ERROR_NO_CYPHER_OVERLAP). Both `ssh-<app>` and `<team>-ssh` are
# one label, so both are cert-valid; the apex form is what the owner asked for and
# it is verified live:
#   $ openssl s_client -connect paper-papas-ssh.uamishub.com:443 \
#       -servername paper-papas-ssh.uamishub.com | openssl x509 -ext subjectAltName
#   DNS:uamishub.com, DNS:*.uamishub.com          <- covers <anything>-ssh.uamishub.com
#   $ curl -o /dev/null -w '%{http_code} %{ssl_verify_result}' \
#       https://paper-papas-ssh.uamishub.com/   ->  404 0
# i.e. DNS resolves to Cloudflare, TLS verifies, and the request already reaches the
# tunnel and falls through to the catch-all. Only the tunnel route + Access app are
# missing — which is exactly what this reconciler adds.
#
# ---------------------------------------------------------------------------
# SAFETY. This touches the SINGLE tunnel config that also carries every platform
# hostname (portal, Harbor, ArgoCD, boards, slides). A mistake takes them all down
# at once. Layers, in order:
#   * DRY_RUN=1 (default) logs the plan and writes NOTHING.
#   * The tunnel PUT is a GET-merge-PUT that only INSERTS/REMOVES rules matching our
#     OWN discriminator; every other rule is preserved verbatim, in order.
#   * CATCH-ALL GUARD: if the fetched config does not end in a catch-all rule (a rule
#     with no `hostname`), ABORT — never write a config that could drop the platform
#     HTTP route.
#   * PRESERVATION ASSERT: after building the new list, re-derive the non-managed
#     rules from it and require they are byte-identical, in order, to the ones we
#     read. Any drift aborts the PUT. This is what makes "we only touch our own
#     rules" a checked invariant rather than a comment.
#   * EMPTY-DESIRED GUARD: if discovery returns ZERO tenants but Cloudflare still
#     holds managed routes/apps, that is far more likely a broken label selector or
#     a failed API listing than a real simultaneous teardown of every VM tenant.
#     Refuse to mass-delete unless ALLOW_EMPTY_DESIRED=1. (Same lesson as ArgoCD's
#     allowEmpty: a reconciler whose desired state can silently become empty will
#     eventually delete everything.)
#   * Missing token / unconfigured IDs => graceful no-op exit 0.
#
# OFFLINE PLAN MODE (no Cloudflare token required):
#   python3 reconcile.py --plan --tunnel-config <file.json> --services <file.json>
# renders the exact plan — including the full ingress list that WOULD be PUT — from
# files instead of the live APIs. This is how the go-live plan is reviewed before a
# token exists, and it is what the unit tests drive.
#
# Stdlib only (urllib/json/ssl) so it runs on python:3-slim with no pip install.
# =============================================================================
import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

DOMAIN = os.environ.get("PLATFORM_DOMAIN", "").strip()
ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip()
TUNNEL_ID = os.environ.get("CF_TUNNEL_ID", "").strip()
CF_TOKEN = os.environ.get("CF_API_TOKEN", "").strip()
DRY_RUN = os.environ.get("DRY_RUN", "1").strip() != "0"
ALLOW_EMPTY = os.environ.get("ALLOW_EMPTY_DESIRED", "0").strip() == "1"
SSH_LABEL = os.environ.get("SSH_SVC_LABEL", "platform.capstone/access=ssh").strip()
SESSION_DURATION = os.environ.get("CF_ACCESS_SESSION", "24h").strip()

# The Access application `type` discriminator sent on create.
#
# WHY THIS IS AN ENV VAR AND NOT A CONSTANT. The evidence here is genuinely mixed and
# we cannot settle it without a token, so it is made changeable without a code change:
#
#   * The API `type` enum does include a first-class `ssh` value (alongside `vnc`,
#     `rdp`, `infrastructure`, `self_hosted`, ...). CONFIRMED from the API reference.
#   * The short-lived-certificate (legacy) page says to create "a self-hosted Access
#     application". CONFIRMED, but that page is describing the dashboard's umbrella
#     CATEGORY, which is not the same thing as the API discriminator.
#   * The browser-rendering page says browser rendering "is only supported for
#     self-hosted public applications" and is switched on per-application by the
#     toggle "Allow access through browser-based RDP, SSH, or VNC sessions" → SSH.
#     CONFIRMED — and it reads as a PROPERTY OF a self-hosted app, not a type.
#
# WHAT SETTLED IT: the ONE Access application on this account that demonstrably
# reaches a browser terminal — `paper-papas-ssh.uamishub.com` — is `"type": "ssh"`,
# read from its live config. So `ssh` is the value that matches a known-working app,
# and this reconciler emitting `self_hosted` would have given teams two and three a
# configuration that does not match the only one proven to work.
#
# NOTE this is NOT the cause of the blocked CA generation. That app is already
# `type: ssh` and browser rendering already works on it; only certificate generation
# is blocked. The remaining candidates are that legacy short-lived certificates are
# gated on this account, or that a CA already exists for the app and the UI refuses to
# mint a second. Do not speculate further in code — one read of
# `GET /accounts/{id}/access/apps/{app_id}/ca` settles it once a token exists.
ACCESS_APP_TYPE = os.environ.get("CF_ACCESS_APP_TYPE", "ssh").strip() or "ssh"

EMAILS_ANNOTATION = "platform.capstone/ssh-access-emails"
TEAM_LABEL = "platform.capstone/team"
CF_API = "https://api.cloudflare.com/client/v4"

# Managed-resource discriminator. Our hosts are `<team>-ssh.<domain>` — a SINGLE
# label ending in `-ssh`, pointing at an `ssh://` origin. BOTH halves must match
# before we will touch a rule, so an HTTP rule can never be captured even if some
# future hostname happens to end in `-ssh`.
SSH_HOST_SUFFIX = "-ssh"
ACCESS_APP_TAG = "vm-ssh:"  # embedded in the Access app name to mark ours


def log(msg):
    print(msg, flush=True)


# --------------------------------------------------------------------------- #
# Naming
# --------------------------------------------------------------------------- #
def team_from(meta):
    """The team slug that owns this SSH Service.

    Prefer the explicit `platform.capstone/team` label. Fall back to the namespace,
    which is `<team>-vm-<env>` by the VM-tier blueprint — strip the `-vm-<env>` tail.
    Never guessed from the Service name: the Service is `<app>-ssh`, and app != team.
    """
    labels = meta.get("labels") or {}
    team = (labels.get(TEAM_LABEL) or "").strip()
    if team:
        return team
    ns = meta.get("namespace", "")
    marker = "-vm-"
    if marker in ns:
        return ns[: ns.rindex(marker)]
    return ns


def hostname_for(team):
    return f"{team}{SSH_HOST_SUFFIX}.{DOMAIN}"


def is_managed_rule(rule):
    host = rule.get("hostname") or ""
    svc = rule.get("service") or ""
    if not svc.startswith("ssh://"):
        return False
    if not DOMAIN or not host.endswith(f".{DOMAIN}"):
        return False
    label = host[: -len(f".{DOMAIN}")]
    # exactly one label, and it ends in our suffix
    return "." not in label and label.endswith(SSH_HOST_SUFFIX)


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
        return json.load(resp)


def tenants_from_service_list(service_list):
    """Pure: a k8s ServiceList -> the desired tenant records. Unit-testable."""
    tenants = []
    for item in service_list.get("items", []):
        meta = item.get("metadata", {})
        name = meta.get("name", "")
        ns = meta.get("namespace", "")
        if not name.endswith("-ssh") or not ns:
            log(f"  skip Service {ns}/{name}: not an <app>-ssh Service")
            continue
        team = team_from(meta)
        if not team:
            log(f"  skip Service {ns}/{name}: cannot derive a team slug")
            continue
        emails_raw = (meta.get("annotations", {}) or {}).get(EMAILS_ANNOTATION, "")
        emails = [e.strip() for e in emails_raw.replace(";", ",").split(",") if e.strip()]
        tenants.append(
            {
                "team": team,
                "app": name[: -len("-ssh")],
                "namespace": ns,
                "hostname": hostname_for(team),
                "service": f"ssh://{name}.{ns}.svc.cluster.local:22",
                "emails": emails,
            }
        )
    # Two Services resolving to the same hostname would make the plan
    # order-dependent and silently drop one. Refuse rather than pick.
    seen = {}
    for t in tenants:
        seen.setdefault(t["hostname"], []).append(f"{t['namespace']}/{t['app']}-ssh")
    dupes = {h: v for h, v in seen.items() if len(v) > 1}
    if dupes:
        raise RuntimeError(f"duplicate SSH hostnames from distinct Services: {dupes}")
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
# THE MERGE — pure, no I/O, so it is fully unit-testable. Returns
# (new_ingress, notes). new_ingress is None when a guard refuses the write.
# --------------------------------------------------------------------------- #
def plan_ingress(current_ingress, tenants, allow_empty=False):
    notes = []
    ingress = list(current_ingress or [])

    if not ingress:
        notes.append("REFUSE: tunnel returned an EMPTY ingress list — cannot safely "
                     "reconstruct the platform catch-all. No change.")
        return None, notes

    managed = [r for r in ingress if is_managed_rule(r)]
    non_managed = [r for r in ingress if not is_managed_rule(r)]

    # CATCH-ALL GUARD.
    if not non_managed or non_managed[-1].get("hostname"):
        notes.append("REFUSE: no catch-all (hostname-less) rule at the end of the "
                     "tunnel config after removing our SSH rules — refusing to PUT "
                     "so the platform HTTP route can never be dropped. No change.")
        return None, notes

    # EMPTY-DESIRED GUARD.
    if not tenants and managed and not allow_empty:
        notes.append(f"REFUSE: desired state is EMPTY but {len(managed)} managed SSH "
                     "route(s) exist. That is far more likely a broken discovery pass "
                     "than a real teardown of every VM tenant. Set "
                     "ALLOW_EMPTY_DESIRED=1 to permit the mass delete.")
        return None, notes

    desired = [
        {"hostname": t["hostname"], "service": t["service"]}
        for t in sorted(tenants, key=lambda t: t["hostname"])
    ]
    new_ingress = desired + non_managed

    # PRESERVATION ASSERT — re-derive the non-managed rules from the list we are
    # about to write and require them byte-identical, in order.
    rederived = [r for r in new_ingress if not is_managed_rule(r)]
    if rederived != non_managed:
        notes.append("REFUSE: internal preservation check failed — the merge would "
                     "not have preserved every non-SSH rule verbatim. No change.")
        return None, notes

    # WHAT CHANGED — reported on rule IDENTITY (hostname, service), never on whole-dict
    # equality. Cloudflare decorates every stored rule with fields we do not send
    # (`id`, and an empty `originRequest: {}`), so a live rule is NEVER `==` to the
    # bare two-key rule we build. Comparing dicts made the plan announce
    #     ADD  <host> ...
    #     DEL  <host> (tenant gone)
    # for one healthy, unchanged tenant — simultaneously, which is impossible. The
    # WRITE was always correct (`new_ingress` is rebuilt from `desired`, so the rule
    # survives); only this summary lied. It lied in the one place the operator is told
    # to look — the go-live dry run — and it lied in the most alarming direction
    # available, so it is a real defect even though nothing was ever deleted.
    def _identity(rule):
        return (rule.get("hostname"), rule.get("service"))

    live = {_identity(r) for r in managed}
    live_hosts = {r.get("hostname") for r in managed}
    desired_hosts = {r["hostname"] for r in desired}

    for r in desired:
        if _identity(r) in live:
            verb = "keep"
        elif r["hostname"] in live_hosts:
            verb = "MOVE"  # same host, different origin — a re-point, not an add
        else:
            verb = "ADD "
        notes.append(f"  {verb} {r['hostname']} -> {r['service']}")
    for r in managed:
        # Only a hostname that has left the DESIRED set is a departed tenant. A
        # hostname still desired but pointing elsewhere is the MOVE reported above.
        if r.get("hostname") not in desired_hosts:
            notes.append(f"  DEL  {r.get('hostname')} (tenant gone)")
    notes.append(f"  catch-all preserved: {json.dumps(non_managed[-1])}")
    notes.append(f"  non-SSH rules preserved verbatim: {len(non_managed)}")
    return new_ingress, notes


def reconcile_tunnel(tenants, fetched_config=None):
    log("== Tunnel ingress reconcile ==")
    if fetched_config is None:
        resp = cf("GET", f"/accounts/{ACCOUNT_ID}/cfd_tunnel/{TUNNEL_ID}/configurations")
        config = (resp.get("result") or {}).get("config") or {}
    else:
        config = fetched_config
    ingress = list(config.get("ingress") or [])

    new_ingress, notes = plan_ingress(ingress, tenants, allow_empty=ALLOW_EMPTY)
    for n in notes:
        log(n)
    if new_ingress is None:
        return False
    if new_ingress == ingress:
        log("  up to date — no PUT needed.")
        return False

    log("  ---- the exact ingress list that WOULD be PUT ----")
    log(json.dumps(new_ingress, indent=2))
    log("  ---- end ----")

    if DRY_RUN:
        log("  DRY_RUN=1: not writing tunnel config.")
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
        # NOTE this is INDISTINGUISHABLE from a working app until someone tries to
        # log in — see the operator doc's failure-mode table.
        include = [{"email": {"email": "__no-team-emails-configured__@invalid"}}]
    body = {"name": "team-allow", "decision": "allow", "include": include}
    existing = cf("GET", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}/policies")
    for p in existing.get("result") or []:
        cf("DELETE", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}/policies/{p['id']}")
    cf("POST", f"/accounts/{ACCOUNT_ID}/access/apps/{app_id}/policies", body)


def _ensure_app_ca(app_id, hostname):
    """Ensure the app's SHORT-LIVED-CERT CA exists and LOG its public key (ADR-039).

    The guest sshd must TRUST this CA or SSH-over-Access cannot complete: after
    Access auth, Cloudflare mints a short-lived SSH cert signed by it. The CA is
    PER-APP and stable once created. The public key is safe to log and safe to
    commit. See the operator doc for where it goes in the guest.
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
        log(f"    CA public key for {hostname} (paste into cloud-init cf_access_ca.pub):")
        log(f"    {pub}")
    else:
        log(f"    WARNING: no CA public key returned for {hostname}")


def report_app_type(app, hostname):
    """Report — never silently repair — an existing app whose `type` is not ours.

    DELIBERATELY NOT A CONVERSION. Cloudflare's update schema does not obviously
    forbid sending a different `type`, but nothing documents that a change is
    HONOURED, and discriminators of this kind are commonly immutable after create. A
    PUT written on that hope would either no-op silently (leaving the operator certain
    they had fixed it) or mutate a live Access app fronting a student's shell. Neither
    is an acceptable thing to guess at, so this only tells a human what to do.

    Conversion, if it is ever wanted, needs a throwaway app proving a PUT is honoured
    BEFORE any code path depends on it.
    """
    actual = (app.get("type") or "").strip()
    if not actual or actual == ACCESS_APP_TYPE:
        return
    log(f"    ⚠ app type is '{actual}', wanted '{ACCESS_APP_TYPE}'.")
    log(f"      NOT converting it in place — unverified whether Cloudflare honours a")
    log(f"      type change, and this app fronts a live shell. To fix by hand:")
    log(f"      delete the Access app for {hostname} in the dashboard and let the")
    log(f"      next pass recreate it, or flip CF_ACCESS_APP_TYPE to '{actual}' if")
    log(f"      that type is in fact the working one.")
    log(f"      For reference, the app proven to reach a browser terminal on this")
    log(f"      account is type 'ssh'. A type mismatch is NOT known to cause the")
    log(f"      blocked CA generation — that app is already 'ssh'. See the doc.")


def reconcile_access(tenants):
    log("== Access application reconcile ==")
    desired = {t["hostname"]: t for t in tenants}
    existing = _managed_apps()

    if not desired and existing and not ALLOW_EMPTY:
        log(f"  REFUSE: desired state is EMPTY but {len(existing)} managed Access "
            "app(s) exist — refusing the mass delete (ALLOW_EMPTY_DESIRED=1 to force).")
        return

    for hostname, t in sorted(desired.items()):
        app = existing.get(hostname)
        emails = ", ".join(t["emails"]) or "NONE — this app will admit NOBODY"
        if app:
            log(f"  ensure app {hostname} (emails: {emails})")
            report_app_type(app, hostname)
            if not DRY_RUN:
                _ensure_policy(app["id"], t["emails"])
            try:
                _ensure_app_ca(app["id"], hostname)
            except Exception as e:  # noqa: BLE001
                log(f"    CA ensure/log FAILED for {hostname}: {e}")
        else:
            log(f"  CREATE app {hostname} (emails: {emails}) type={ACCESS_APP_TYPE}")
            if not DRY_RUN:
                created = cf("POST", f"/accounts/{ACCOUNT_ID}/access/apps", {
                    "name": f"{ACCESS_APP_TAG}{t['team']}",
                    "domain": hostname,
                    "type": ACCESS_APP_TYPE,
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
def main(argv=None):
    ap = argparse.ArgumentParser(description="cf-vm-access reconciler")
    ap.add_argument("--plan", action="store_true",
                    help="offline plan: read state from files, never call any API")
    ap.add_argument("--tunnel-config", help="JSON file holding the tunnel `config` object")
    ap.add_argument("--services", help="JSON file holding a k8s ServiceList")
    args = ap.parse_args(argv)

    if args.plan:
        if not DOMAIN:
            log("ERROR: --plan needs PLATFORM_DOMAIN set.")
            return 2
        log(f"cf-vm-access OFFLINE PLAN (domain={DOMAIN}) — no API calls, no writes")
        with open(args.services) as f:
            svc_list = json.load(f)
        tenants = tenants_from_service_list(svc_list)
        log(f"  {len(tenants)} VM SSH tenant(s) discovered:")
        for t in tenants:
            log(f"    - team={t['team']} app={t['app']} ns={t['namespace']}")
            log(f"      {t['hostname']} -> {t['service']}")
            log(f"      access emails: {', '.join(t['emails']) or 'NONE'}")
        with open(args.tunnel_config) as f:
            config = json.load(f)
        new_ingress, notes = plan_ingress(config.get("ingress") or [], tenants,
                                          allow_empty=ALLOW_EMPTY)
        log("== Tunnel ingress plan ==")
        for n in notes:
            log(n)
        if new_ingress is not None:
            log("  ---- the exact ingress list that WOULD be PUT ----")
            log(json.dumps(new_ingress, indent=2))
            log("  ---- end ----")
        log("== Access application plan ==")
        for t in sorted(tenants, key=lambda x: x["hostname"]):
            log(f"  would ensure app {t['hostname']} (type={ACCESS_APP_TYPE})")
            log(f"    name={ACCESS_APP_TAG}{t['team']} session_duration={SESSION_DURATION}")
            log(f"    allow policy include: {[{'email': {'email': e}} for e in t['emails']]}")
            log(f"    would ensure per-app short-lived-cert CA and log its public key")
        return 0

    log(f"cf-vm-access reconciler (DRY_RUN={DRY_RUN})")
    missing = [n for n, v in
               (("PLATFORM_DOMAIN", DOMAIN), ("CF_ACCOUNT_ID", ACCOUNT_ID),
                ("CF_TUNNEL_ID", TUNNEL_ID), ("CF_API_TOKEN", CF_TOKEN)) if not v]
    if missing:
        log(f"  not configured yet ({', '.join(missing)} unset) — no-op. "
            "Seal the token + set the IDs to activate (see the operator checklist).")
        return 0

    tenants = tenants_from_service_list(k8s_list_ssh_services())
    log(f"  {len(tenants)} VM SSH tenant(s) discovered in-cluster:")
    for t in tenants:
        log(f"    - {t['hostname']} -> {t['service']} ({len(t['emails'])} email(s))")

    rc = 0
    try:
        reconcile_tunnel(tenants)
    except Exception as e:  # noqa: BLE001 — one subsystem must not block the other
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
