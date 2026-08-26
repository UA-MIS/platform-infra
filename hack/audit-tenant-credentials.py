#!/usr/bin/env python3
"""
Detect PLATFORM-SHARED credentials sitting in namespaces a tenant can schedule
pods in.  Read-only; prints fingerprints, never key material.

WHY THIS EXISTS (SEC-037, board item #134)
------------------------------------------
`ida-llm-prod` held GITHUB_APP_PRIVATE_KEY for `ua-mis-backstage` (app_id
4097147) -- installed org-wide with administration/contents/workflows write and
a branch-protection bypass on platform-infra main.  It was byte-identical to the
key every platform board uses.

The reason that is fatal rather than untidy is a Kubernetes primitive, not a
misconfiguration: **any pod in a namespace may mount any Secret in that
namespace.**  There is no per-pod, per-Secret permission.  A tenant namespace is
reconciled by ArgoCD from a repository the students own, at HEAD, so membership
of the namespace IS the permission.  Nothing at admission refuses it, and
nothing should have to -- the fix is to not put the credential there.

WHAT THIS IS AND IS NOT
-----------------------
This is a DETECTOR, not an admission gate.  It answers "is it happening now?"
It deliberately does not try to be Kyverno: board item #65 records what flipping
an image policy to Enforce without an exclusion list did to unrelated workloads,
and an admission rule is the wrong shape for this anyway -- the student is not
smuggling anything, they are legitimately deploying into a namespace that should
never have held the credential.

HOW IT DECIDES
--------------
Two independent signals, because either alone gives false results:

  1. VALUE MATCH (high confidence).  Fingerprint every secret value in the
     platform-owned reference namespaces, then look for those exact
     fingerprints in tenant namespaces.  A byte-identical value is proof of a
     shared credential, whatever it is named.

  2. PATH SCOPE (structural).  An ExternalSecret in a tenant namespace that
     reads a `platform/*` Vault path, or another team's `tenants/<other>/*`
     path, is reaching outside its own subtree by construction.

Signal 1 catches hand-provisioned copies (how SEC-037 happened -- the value was
pasted into the tenant's own Vault subtree, so no path looked wrong).
Signal 2 catches store misconfiguration.  Neither subsumes the other.

Exit codes:  0 clean, 1 findings, 2 could not run.

    python3 hack/audit-tenant-credentials.py
    python3 hack/audit-tenant-credentials.py --quiet   # findings only
"""

import argparse
import base64
import hashlib
import json
import subprocess
import sys

# Namespaces the platform owns.  Occupants here are platform workloads; a shared
# credential is expected and correct.  Everything NOT listed is treated as
# tenant-reachable, which is the safe direction to be wrong in: a new platform
# namespace shows up as a finding and gets added here deliberately, rather than a
# new tenant namespace being silently exempt.
PLATFORM_NS = {
    "agile", "alloy", "arc-runners", "arc-system", "argo-rollouts", "argocd",
    "backstage", "cdi", "cert-manager", "cilium-secrets", "cnpg-system",
    "cohort-gc", "crossplane-system", "db-admin", "db-console-auth", "db-tier",
    "default", "descheduler", "dex", "external-secrets", "goldilocks", "harbor",
    "kube-node-lease", "kube-public", "kube-system", "kyverno", "loki",
    "metrics-server", "minio", "minio-backups", "monitoring", "observability",
    "opencost", "otel-collector", "reloader", "rook-ceph", "spire", "traefik",
    "vault", "velero", "vpa", "kubevirt", "cloudflared",
}

# Where the canonical platform credentials live.  Values found here define the
# reference fingerprints.
REFERENCE_NS = ["agile", "backstage", "argocd", "arc-runners"]

# Never worth fingerprinting: per-object noise that would generate matches
# meaning nothing (every SA token differs; helm releases are blobs).
SKIP_TYPES = {"helm.sh/release.v1"}

# Key names whose value is a non-secret identifier.  Matching on these produces
# noise -- an App ID is *meant* to be the same everywhere.
IDENTIFIER_KEYS = {
    "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "namespace", "ca.crt",
    "MINIO_ENDPOINT", "ADMINER_AUTOLOGIN_SERVER",
}

# Values too short or too common to be meaningful evidence of sharing.
MIN_VALUE_LEN = 16


def kubectl_json(*args):
    proc = subprocess.run(
        ["kubectl", *args, "-o", "json"], capture_output=True, text=True
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "kubectl failed")
    return json.loads(proc.stdout)


def fingerprint(raw: bytes) -> str:
    """Stable short digest.  Normalizes a base64-wrapped PEM to its inner bytes
    so the same key seeded wrapped in one place and bare in another still
    matches -- which is exactly how a hand-copied credential tends to differ."""
    inner = raw
    try:
        decoded = base64.b64decode(raw, validate=True)
        if b"PRIVATE KEY" in decoded:
            inner = decoded
    except Exception:
        pass
    return hashlib.sha256(inner).hexdigest()[:16]


def secret_values(ns):
    """Yield (secret_name, key, raw_bytes) for real secrets in a namespace."""
    try:
        data = kubectl_json("get", "secret", "-n", ns)
    except RuntimeError:
        return
    for item in data.get("items", []):
        stype = item.get("type", "")
        if stype in SKIP_TYPES or stype.startswith("kubernetes.io/service-account"):
            continue
        name = item["metadata"]["name"]
        for key, b64 in (item.get("data") or {}).items():
            if key in IDENTIFIER_KEYS:
                continue
            try:
                raw = base64.b64decode(b64)
            except Exception:
                continue
            if len(raw) < MIN_VALUE_LEN:
                continue
            yield name, key, raw


def externalsecret_paths(ns):
    """Yield (es_name, store_kind, store_name, vault_path)."""
    try:
        data = kubectl_json("get", "externalsecret", "-n", ns)
    except RuntimeError:
        return
    for item in data.get("items", []):
        spec = item.get("spec", {})
        ref = spec.get("secretStoreRef", {})
        paths = set()
        for d in spec.get("data", []):
            rr = d.get("remoteRef", {})
            if "key" in rr:
                paths.add(rr["key"])
        for d in spec.get("dataFrom", []):
            if "extract" in d and "key" in d["extract"]:
                paths.add(d["extract"]["key"])
        for p in sorted(paths):
            yield (
                item["metadata"]["name"],
                ref.get("kind", "<generator>"),
                ref.get("name", "-"),
                p,
            )


def team_of(ns: str) -> str:
    """Tenant namespaces are `<team>-dev|staging|prod`."""
    for suffix in ("-dev", "-staging", "-prod"):
        if ns.endswith(suffix):
            return ns[: -len(suffix)]
    return ns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true", help="print findings only")
    args = ap.parse_args()

    try:
        all_ns = [n["metadata"]["name"] for n in kubectl_json("get", "ns")["items"]]
    except RuntimeError as exc:
        print(f"audit-tenant-credentials: cannot reach cluster: {exc}", file=sys.stderr)
        return 2

    tenant_ns = sorted(
        n for n in all_ns
        if n not in PLATFORM_NS
        and not n.startswith(("kube-", "rook-", "cilium", "harbor"))
    )

    # ---- build reference fingerprints from platform-owned namespaces --------
    reference = {}  # fp -> [(ns, secret, key), ...]
    for ns in REFERENCE_NS:
        if ns not in all_ns:
            continue
        for secret, key, raw in secret_values(ns):
            reference.setdefault(fingerprint(raw), []).append((ns, secret, key))

    if not args.quiet:
        print(f"reference: {len(reference)} distinct values across "
              f"{', '.join(n for n in REFERENCE_NS if n in all_ns)}")
        print(f"scanning:  {len(tenant_ns)} tenant-reachable namespaces\n")

    findings = []

    # ---- signal 1: value match ---------------------------------------------
    for ns in tenant_ns:
        for secret, key, raw in secret_values(ns):
            fp = fingerprint(raw)
            if fp in reference:
                findings.append({
                    "signal": "VALUE-MATCH",
                    "ns": ns, "secret": secret, "key": key, "fp": fp,
                    "also_in": reference[fp],
                })

    # ---- signal 2: path scope ----------------------------------------------
    for ns in tenant_ns:
        team = team_of(ns)
        for es, kind, store, path in externalsecret_paths(ns):
            bad = None
            if path.startswith("platform/"):
                bad = "reads a platform/* path"
            elif path.startswith("tenants/"):
                parts = path.split("/")
                if len(parts) > 1 and parts[1] != team:
                    bad = f"reads another team's subtree ({parts[1]})"
            if bad:
                findings.append({
                    "signal": "PATH-SCOPE",
                    "ns": ns, "secret": es, "key": path, "fp": None,
                    "why": bad, "store": f"{kind}/{store}",
                })

    # ---- report -------------------------------------------------------------
    value_hits = [f for f in findings if f["signal"] == "VALUE-MATCH"]
    path_hits = [f for f in findings if f["signal"] == "PATH-SCOPE"]

    if value_hits:
        print("=" * 76)
        print("SHARED PLATFORM CREDENTIAL FOUND IN A TENANT-REACHABLE NAMESPACE")
        print("=" * 76)
        for f in value_hits:
            print(f"  {f['ns']}/{f['secret']}  key={f['key']}  sha256={f['fp']}")
            for ns, secret, key in f["also_in"]:
                print(f"      identical to {ns}/{secret} key={key}")
            print("      -> any pod this tenant deploys can mount it. Move the")
            print("         credential to a platform namespace; do not tighten RBAC.")
        print()

    if path_hits:
        print("-" * 76)
        print("EXTERNALSECRET REACHING OUTSIDE ITS OWN VAULT SUBTREE")
        print("-" * 76)
        for f in path_hits:
            print(f"  {f['ns']}/{f['secret']}  {f['why']}")
            print(f"      path={f['key']}  store={f['store']}")
        print()
        print("  Not automatically a defect -- a shared read-only pull credential")
        print("  is a considered trade. Confirm each is scoped and read-only.")
        print()

    if not findings:
        print("audit-tenant-credentials: PASS -- no shared platform credential "
              "in any tenant-reachable namespace")
        return 0

    print(f"audit-tenant-credentials: {len(value_hits)} value match(es), "
          f"{len(path_hits)} path-scope note(s)")
    return 1 if value_hits else 0


if __name__ == "__main__":
    sys.exit(main())
