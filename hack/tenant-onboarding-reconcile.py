#!/usr/bin/env python3
"""
tenant-onboarding-reconcile.py — a provisioned tenant must be VISIBLE to the portal.

── THE FAILURE THIS EXISTS TO CATCH ─────────────────────────────────────────────
2026-10-07: the `surfers` tenant did not appear in The Process portal's Secrets tab.
Everything that normally signals health was green. The claim was committed, Crossplane
provisioned all three namespaces, ArgoCD was synced, the app served traffic, and
`portal-tenants-refresh` happily listed the tenant. The tab was empty anyway, because
the tab enumerates the BACKSTAGE CATALOG (`sealCore.ts:1385`,
`filter: [{ kind: 'Component' }]`) and the catalog had never heard of the tenant.

The catalog ingests a tenant app repo only if that repo carries the GitHub topic
`capstone-tenant` (`app-config.production.yaml`, provider `github.tenants`,
`filters.topic.include`). The scaffolder applies that topic at onboarding
(`templates/*/template.yaml`, `topics: ['capstone-tenant']`). `surfers` was onboarded
BY HAND — claim committed directly in PR #689, no scaffolder task ever ran — so the
topic was never applied. `springais` (PR #627) was in the identical state.

Nothing anywhere detected this for two weeks. There is no signal for it, because every
component in the chain was individually healthy: the defect lives in the SEAM between a
tenant being provisioned and that tenant being discoverable, and nothing owned that seam.

── WHY THIS ENUMERATES FROM THE CLAIMS, AND NOT FROM THE TOPIC ─────────────────
This is the whole design, and it is the one thing not to "simplify" later.

`ci-fleet-drift-report.py` enumerates the fleet with `search/repositories?q=org:UA-MIS+
topic:capstone-tenant`. That is correct for what it does, but it means a repo MISSING the
topic is not a drift finding — it is invisible to the report entirely. `surfer` and
`springais` were absent from that report's fleet for the whole time they were broken, and
the report was passing. A check that enumerated the same way would inherit the identical
blind spot and would have reported this platform clean on the exact day it was not.

So this check enumerates from `tenants/_claims/*.yaml`: the committed, authoritative
record that a tenant was PROVISIONED. A claim cannot be missing for a live tenant — the
claim is what creates it. Enumerating from the artifact that cannot be absent, and then
checking the artifacts that can, is what lets this see the failure at all.

Generalised: never enumerate a population by the property you are testing it for.

── WHAT IS CHECKED, AND WHAT IS DELIBERATELY NOT ───────────────────────────────
Per claim: the app repo exists, is not archived, carries `capstone-tenant`, ships a
`catalog-info.yaml` on its default branch, and that file's `spec.owner` is
`group:default/<spec.team>`.

C5 (owner) earns its place: the portal derives BOTH the tenant's Vault path
(`vaultPathFor`, `sealCore.ts:221`) and its per-tenant authorization (`sealCore.ts:826`)
from the owner GROUP slug, never from the app name. `surfer`'s owner is
`group:default/surfers` — app singular, team plural — and that is correct and load-bearing.
An owner that does not match `spec.team` silently points the tab at a Vault path no
ExternalSecret reads, which is the same class of invisible failure in a subtler disguise.

NOT checked: whether the catalog actually ingested the Component. That needs Backstage
credentials and in-cluster network, and CI has neither. This is the boundary of the tool,
not an oversight — it checks the PRECONDITIONS for ingestion, which is what makes it a
PR-time gate rather than an hour-later alarm. It is therefore NOT proof of ingestion, and
both the workflow summary and `--json` say so rather than letting a pass imply it.

── FAIL LOUDLY, NEVER SKIP ─────────────────────────────────────────────────────
Exit 0 = clean · 1 = findings · 2 = COULD NOT BE TRUSTED.

2 is distinguished on purpose, same as `ci-fleet-drift-report.py`. Zero claims parsed, a
claim without `spec.team`/`spec.appName`, unparseable YAML, or any non-404 API response is
`Fatal`, never a quiet pass. A check that reports clean when it cannot see is worse than
no check: it manufactures the exact false assurance that let this bug live for two weeks.
A 404 on a FILE is meaningful (absent) and becomes a finding; a 404 is never inferred from
a 403, a 500, or a rate limit.
"""

import argparse
import base64
import glob
import json
import os
import subprocess
import sys

try:
    import yaml
except ImportError:  # pragma: no cover - surfaced as Fatal in main()
    yaml = None

ORG = "UA-MIS"
# The one topic the catalog's `github.tenants` provider filters on. Changing this string
# without changing app-config.production.yaml's filters.topic.include makes this check
# assert a contract nothing enforces.
TENANT_TOPIC = "capstone-tenant"
CATALOG_INFO = "catalog-info.yaml"

# ── every directory that records a PROVISIONED tenant ────────────────────────────
# Both kinds get the same `capstone-tenant` topic from their templates
# (`new-project/template.yaml:730`, `vm-app/template.yaml:417`) and are therefore
# subject to the identical discovery preconditions.
#
# Container tenants keep team/appName under `spec:`; VM tenants keep them at the top
# level. That is not worth normalising away — the shapes are read from two different
# schemas and an explicit per-source field path is what stops a future schema change
# from silently yielding `None` and skipping a whole class of tenant.
#
# ⚠ This list IS the check's coverage. The first draft of this script read only
# `tenants/_claims`, which quietly excluded all three VM tenants while still printing a
# clean result — the exact blind spot this script exists to remove, reproduced inside
# the script itself. Adding a tenant KIND without adding it here makes this check
# confidently wrong rather than merely incomplete.
CLAIM_SOURCES = (
    {"dir": "tenants/_claims", "kind": "CapstoneTenant", "under": "spec"},
    {"dir": "tenants/_vm-claims", "kind": "VmTenantLedger", "under": None},
)


class Fatal(Exception):
    """The check could not be trusted. Exit 2 — never 0, never 1."""


# ── GitHub reads ─────────────────────────────────────────────────────────────
def gh(path):
    """A read whose failure is ALWAYS fatal."""
    p = subprocess.run(["gh", "api", "-X", "GET", path], capture_output=True, text=True)
    if p.returncode != 0:
        raise Fatal(
            f"GitHub API GET {path} failed (rc={p.returncode}): "
            f"{p.stderr.strip()[:300]}"
        )
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError as e:
        raise Fatal(f"GitHub API GET {path} returned unparseable JSON: {e}")


def gh_maybe(path):
    """A read whose 404 is MEANINGFUL (absent). Any other failure still raises —
    a 403/500/rate-limit must never be recorded as 'the file is not there'."""
    p = subprocess.run(["gh", "api", "-X", "GET", path], capture_output=True, text=True)
    if p.returncode == 0:
        try:
            return json.loads(p.stdout)
        except json.JSONDecodeError as e:
            raise Fatal(f"GitHub API GET {path} returned unparseable JSON: {e}")
    err = p.stderr.strip()
    if "404" in err or "Not Found" in err:
        return None
    raise Fatal(
        f"GitHub API GET {path} failed non-404 (rc={p.returncode}): {err[:300]}"
    )


# ── claim enumeration (the authoritative population) ─────────────────────────
def load_source(root, src):
    """The claims recorded by one source directory. Returns [] only when the directory
    genuinely holds no claim files — which the caller reports, never swallows."""
    rel, kind, under = src["dir"], src["kind"], src["under"]
    d = os.path.join(root, rel)
    if not os.path.isdir(d):
        raise Fatal(
            f"{rel} does not exist under {root!r}. A claims directory this check is "
            f"configured to read has moved or been renamed; refusing to report a clean "
            f"platform while blind to a whole tenant class."
        )
    claims = []
    for path in sorted(glob.glob(os.path.join(d, "*.yaml"))):
        base = os.path.basename(path)
        # `_`-prefixed files are documentation/templates, never live tenants.
        if base.startswith("_"):
            continue
        with open(path) as f:
            try:
                docs = [x for x in yaml.safe_load_all(f) if x]
            except yaml.YAMLError as e:
                raise Fatal(
                    f"{rel}/{base}: unparseable YAML ({e}). A claim this check cannot "
                    f"read is not a claim it may ignore."
                )
        tenant_docs = [x for x in docs if isinstance(x, dict) and x.get("kind") == kind]
        if not tenant_docs:
            kinds = sorted(str(x.get("kind")) for x in docs if isinstance(x, dict))
            raise Fatal(
                f"{rel}/{base}: no `kind: {kind}` document (found: {kinds or 'nothing'}). "
                f"Either this is not a claim (move it under a `_` prefix) or a new tenant "
                f"kind needs adding to CLAIM_SOURCES — both need a human, not a pass."
            )
        for doc in tenant_docs:
            # Container claims nest these under `spec:`; VM ledgers keep them at the top
            # level. Reading the wrong level yields None, which is why a missing value
            # below is Fatal rather than a skip.
            holder = (doc.get(under) or {}) if under else doc
            team, app = holder.get("team"), holder.get("appName")
            if not team or not app:
                where = f"{under}." if under else ""
                raise Fatal(
                    f"{rel}/{base}: {where}team={team!r} {where}appName={app!r} — both "
                    f"are required to reconcile a tenant. Refusing to skip it."
                )
            claims.append(
                {
                    "file": f"{rel}/{base}",
                    "team": str(team),
                    "app": str(app),
                    "kind": kind,
                }
            )
    return claims


def load_claims(root):
    """Every committed tenant claim, across every source. Returns (claims, findings):
    a configured source holding ZERO claims is reported as a FINDING, because that is
    indistinguishable from this check having quietly stopped covering that class."""
    claims, findings = [], []
    for src in CLAIM_SOURCES:
        got = load_source(root, src)
        if not got:
            findings.append(
                {
                    "tenant": "-",
                    "repo": src["dir"],
                    "check": "claim-source-empty",
                    "detail": f"{src['dir']} exists but holds no `kind: {src['kind']}` "
                    f"claims. If that tenant class was retired, remove the directory or "
                    f"its CLAIM_SOURCES entry; until then this check is covering nothing "
                    f"there and is saying so rather than printing a clean result.",
                }
            )
        claims.extend(got)
    if not claims:
        raise Fatal(
            f"ZERO tenant claims across "
            f"{', '.join(s['dir'] for s in CLAIM_SOURCES)}. That is almost certainly a "
            f"moved directory, a renamed file convention, or a bad checkout — not a "
            f"platform with no tenants. Refusing to report 'no findings'."
        )
    return claims, findings


# ── per-claim checks ────────────────────────────────────────────────────────
def owner_from_catalog_info(text, repo):
    """`spec.owner` of the Component doc. Unreadable/absent is a FINDING string,
    never silently None-and-pass."""
    try:
        docs = [d for d in yaml.safe_load_all(text) if d]
    except yaml.YAMLError as e:
        return None, f"{CATALOG_INFO} in {repo} is unparseable YAML ({e})"
    comps = [d for d in docs if isinstance(d, dict) and d.get("kind") == "Component"]
    if not comps:
        return None, (
            f"{CATALOG_INFO} in {repo} declares no `kind: Component` — the "
            f"catalog provider would ingest nothing from it"
        )
    owner = (comps[0].get("spec") or {}).get("owner")
    if not owner:
        return None, f"{CATALOG_INFO} in {repo} Component has no `spec.owner`"
    return str(owner), None


def check_claim(claim):
    """Return the list of findings for one claim (empty = this tenant is fine)."""
    team, app = claim["team"], claim["app"]
    repo = f"{ORG}/{app}"
    out = []

    meta = gh_maybe(f"repos/{repo}")
    if meta is None:
        return [
            {
                "tenant": team,
                "repo": repo,
                "check": "repo-exists",
                "detail": f"claim {claim['file']} names appName={app!r} but "
                f"{repo} does not exist (or is not visible to this token)",
            }
        ]

    # A claim for an archived repo is a teardown that stopped halfway: the repo is
    # retired but the claim still provisions namespaces, quotas and runners.
    if meta.get("archived"):
        out.append(
            {
                "tenant": team,
                "repo": repo,
                "check": "repo-archived",
                "detail": f"{repo} is ARCHIVED but still has a live claim "
                f"({claim['file']}) — teardown removed the repo from "
                f"service without removing the claim",
            }
        )

    # C3 — THE defect that hid `surfers`. The topic is what the catalog filters on.
    topics = (gh(f"repos/{repo}/topics") or {}).get("names")
    if topics is None:
        raise Fatal(
            f"repos/{repo}/topics returned no 'names' key — refusing to "
            f"conclude 'topic absent' from a malformed response"
        )
    if TENANT_TOPIC not in topics:
        out.append(
            {
                "tenant": team,
                "repo": repo,
                "check": "catalog-topic",
                "detail": f"{repo} is missing the {TENANT_TOPIC!r} topic (has: "
                f"{sorted(topics) or 'none'}), so the catalog's "
                f"github.tenants provider will never ingest it and the "
                f"portal cannot see this tenant. Fix: gh api -X PUT "
                f"repos/{repo}/topics -f names[]={TENANT_TOPIC}"
                + "".join(f" -f names[]={t}" for t in sorted(topics)),
            }
        )

    # C4/C5 — the file the provider reads, and the owner the portal derives from.
    blob = gh_maybe(f"repos/{repo}/contents/{CATALOG_INFO}")
    if blob is None:
        out.append(
            {
                "tenant": team,
                "repo": repo,
                "check": "catalog-info-present",
                "detail": f"{repo} has no {CATALOG_INFO} on its default branch; "
                f"the provider would find nothing to ingest even with "
                f"the topic set",
            }
        )
        return out
    content = blob.get("content")
    if not content:
        raise Fatal(
            f"repos/{repo}/contents/{CATALOG_INFO} returned no 'content' — "
            f"refusing to treat an unreadable response as a missing owner"
        )
    try:
        text = base64.b64decode(content).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as e:
        raise Fatal(
            f"repos/{repo}/contents/{CATALOG_INFO} content is not decodable "
            f"UTF-8 base64 ({e})"
        )

    owner, problem = owner_from_catalog_info(text, repo)
    if problem:
        out.append(
            {
                "tenant": team,
                "repo": repo,
                "check": "catalog-info-owner",
                "detail": problem,
            }
        )
        return out
    expected = f"group:default/{team}"
    if owner != expected:
        out.append(
            {
                "tenant": team,
                "repo": repo,
                "check": "owner-matches-team",
                "detail": f"{CATALOG_INFO} in {repo} declares spec.owner={owner!r} "
                f"but the claim's spec.team is {team!r} (expected "
                f"{expected!r}). The portal derives the tenant's Vault "
                f"path and its authorization from the OWNER GROUP, so a "
                f"mismatch points the Secrets tab at "
                f"tenants/{owner.rsplit('/', 1)[-1]}/<env>/app while the "
                f"ExternalSecrets read tenants/{team}/<env>/app",
            }
        )
    return out


def main():
    ap = argparse.ArgumentParser(
        description="Reconcile every tenant claim against the portal's "
        "discovery preconditions (topic + catalog-info + owner)."
    )
    ap.add_argument(
        "--json",
        action="store_true",
        help="machine-readable output (the seam for a metrics scrape)",
    )
    ap.add_argument(
        "--repo-root",
        default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        help="platform-infra checkout to read claims from",
    )
    args = ap.parse_args()

    if yaml is None:
        raise Fatal(
            "PyYAML is not importable; this check cannot read claims and "
            "must not report a clean platform without them."
        )

    claims, findings = load_claims(args.repo_root)
    for c in claims:
        findings.extend(check_claim(c))

    # Per-source counts, always printed. A class of tenant silently dropping out of
    # coverage is the failure mode this whole script is about, so the coverage itself
    # is reported rather than left to be inferred from a clean result.
    by_source = {s["dir"]: 0 for s in CLAIM_SOURCES}
    for c in claims:
        by_source[c["file"].rsplit("/", 1)[0]] += 1
    coverage = ", ".join(f"{d}={n}" for d, n in by_source.items())

    if args.json:
        print(
            json.dumps(
                {
                    "claims_checked": len(claims),
                    "coverage": by_source,
                    "findings": findings,
                    # Stated in the payload so a consumer cannot mistake a pass for proof
                    # that the catalog actually holds these Components.
                    "proves_ingestion": False,
                },
                indent=2,
            )
        )
    else:
        print(
            f"Reconciled {len(claims)} tenant claim(s) ({coverage}) "
            f"against portal discovery preconditions."
        )
        if not findings:
            print(
                "OK: every claimed tenant has the catalog topic, a catalog-info.yaml, "
                "and an owner matching its team."
            )
        else:
            print(f"\n{len(findings)} finding(s):\n")
            for f in findings:
                print(f"  [{f['check']}] {f['tenant']} ({f['repo']})")
                print(f"      {f['detail']}\n")
        print(
            "NOTE: this checks the PRECONDITIONS for catalog ingestion. It does not "
            "prove the catalog ingested these Components — that needs Backstage "
            "credentials CI does not have."
        )

    return 1 if findings else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fatal as e:
        print(f"FATAL: {e}", file=sys.stderr)
        print(
            "This check COULD NOT BE TRUSTED. That is not a clean platform — treat "
            "it as an outage of the check itself.",
            file=sys.stderr,
        )
        sys.exit(2)
