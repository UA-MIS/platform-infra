#!/usr/bin/env python3
"""
Fleet CI drift report + reusable-tag staleness (D-202 §6.2 / §6.3, board #184).

WHY THIS EXISTS
---------------
`platform-infra` cannot see tenant repositories with `actions/checkout` — which is
exactly why `ci-scripts-sync-check` is blind: it compares the platform against
ITSELF. An org-wide GitHub App installation token, however, reads any tenant's
files over the API. That single fact is what makes fleet-wide drift visible at
all, and it is the premise this report is built on.

Today nothing compares tenant pipelines against the platform's. Drift is silent
BY CONSTRUCTION: each tenant carries its own copy, nothing reads them together,
and a copy frozen in June looks exactly like one written this morning.

WHAT IT REPORTS
---------------
  §6.2  For every live tenant: does its pipeline CALL the reusable workflow, or
        carry a local COPY? If it calls it, at which ref — and is that the ref
        the platform currently ships? If it carries a copy, how stale is it?
  §6.3  Is the `v1` tag still moving? The design's neat consequence is that
        because `v1` only advances on a green canary, the tag's staleness is a
        health signal. See `tag_staleness()` for why raw AGE is the wrong metric
        and what this uses instead.

FAIL-CLOSED (this is the whole point — read it before changing anything)
-----------------------------------------------------------------------
A drift report that returns "no drift" because it read nothing is the exact
defect this design exists to kill. So:
  * enumeration returning ZERO repos is an ERROR, never "clean"
  * any per-repo API failure marks that repo UNKNOWN and fails the run
  * a missing exceptions file NEVER suppresses a finding (it only ever removes
    entries, so its absence can only over-report — the safe direction)
  * a MALFORMED exceptions file is an error, not an empty exceptions list
  * exit 2 = could not run. Never confuse it with exit 0 = ran, found nothing.

Exit codes:  0 clean · 1 drift found · 2 could not run (fail closed)

    python3 hack/ci-fleet-drift-report.py                 # both sections
    python3 hack/ci-fleet-drift-report.py --check tag     # §6.3 only
    python3 hack/ci-fleet-drift-report.py --json          # machine-readable
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

ORG = "UA-MIS"
PLATFORM_REPO = f"{ORG}/platform-infra"
# The one topic that marks a live tenant app repo. This is NOT a list we maintain:
# the scaffolder applies it at onboarding and the portal's Tenant Teardown page
# strips it at de-provision (tenants/_claims/README.md documents both halves). A
# tenant created tomorrow therefore appears here with nobody remembering anything.
TENANT_TOPIC = "capstone-tenant"
REUSABLE = ".github/workflows/tenant-build.yaml"
EXCEPTIONS = "tenants/ci-exceptions.yaml"
# Grace period before an unblessed change to the reusable workflow is an alert.
# See tag_staleness() for the reasoning.
TAG_GRACE_DAYS = 3


class Fatal(Exception):
    """Something prevented the report from being trustworthy. Exit 2, never 0."""


def gh(path, *, paginate=False):
    """One read-only GitHub API call. Raises Fatal rather than returning empty."""
    cmd = ["gh", "api", "-X", "GET", path]
    if paginate:
        cmd.append("--paginate")
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise Fatal(f"GitHub API GET {path} failed (rc={p.returncode}): "
                    f"{p.stderr.strip()[:300]}")
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError as e:
        raise Fatal(f"GitHub API GET {path} returned unparseable JSON: {e}")


def gh_maybe(path):
    """A call whose 404 is MEANINGFUL (file absent) rather than an error.
    Any OTHER failure still raises — a 403/500 must never read as 'absent'."""
    p = subprocess.run(["gh", "api", "-X", "GET", path],
                       capture_output=True, text=True)
    if p.returncode == 0:
        return json.loads(p.stdout)
    if "404" in p.stderr or "Not Found" in p.stderr:
        return None
    raise Fatal(f"GitHub API GET {path} failed non-404: {p.stderr.strip()[:300]}")


# ── enumeration ──────────────────────────────────────────────────────────────
def live_tenants():
    q = f"search/repositories?q=org:{ORG}+topic:{TENANT_TOPIC}&per_page=100"
    data = gh(q)
    items = data.get("items")
    if items is None:
        raise Fatal("tenant enumeration returned no 'items' key — refusing to "
                    "report a clean fleet from a malformed response")
    names = sorted(r["name"] for r in items)
    # THE fail-closed check. An empty fleet is indistinguishable from a revoked
    # token, a renamed topic, or a search-index hiccup — so it is never 'clean'.
    if not names:
        raise Fatal(
            f"tenant enumeration returned ZERO repos with topic '{TENANT_TOPIC}'. "
            f"That is almost certainly a broken token, a lost topic, or a search "
            f"outage — not an empty platform. Refusing to report 'no drift'.")
    total = data.get("total_count", len(names))
    if total > len(names):
        raise Fatal(f"enumeration truncated: total_count={total} but only "
                    f"{len(names)} returned; paginate before trusting this")
    return names


def load_exceptions(root):
    """tenants/ci-exceptions.yaml (§5.6). Absence never suppresses; malformed is fatal."""
    path = os.path.join(root, EXCEPTIONS)
    if not os.path.exists(path):
        return {}, (f"{EXCEPTIONS} not present — NO exclusions applied. Every "
                    f"tenant is evaluated. (Absence can only over-report, which "
                    f"is the safe direction.)")
    try:
        import yaml
        doc = yaml.safe_load(open(path)) or {}
    except Exception as e:
        raise Fatal(f"{EXCEPTIONS} is malformed ({e}). Refusing to continue: "
                    f"treating it as empty would silently drop real exclusions, "
                    f"and treating it as total would silently hide real drift.")
    entries = doc.get("exempt") or []
    if not isinstance(entries, list):
        raise Fatal(f"{EXCEPTIONS}: 'exempt' must be a list, got {type(entries)}")
    out = {}
    for e in entries:
        if not isinstance(e, dict) or "repo" not in e:
            raise Fatal(f"{EXCEPTIONS}: every entry needs a 'repo' key; got {e!r}")
        reason = (e.get("reason") or "").strip()
        out[e["repo"]] = reason
    return out, None


# ── per-repo classification ──────────────────────────────────────────────────
USES_RE = re.compile(
    r"uses:\s*" + re.escape(ORG) + r"/platform-infra/\.github/workflows/"
    r"([^@\s]+)@(\S+)")


def classify(repo, current_ref):
    listing = gh_maybe(f"repos/{ORG}/{repo}/contents/.github/workflows")
    if listing is None:
        return {"repo": repo, "state": "NO-WORKFLOWS", "detail":
                "no .github/workflows directory"}
    names = [f["name"] for f in listing if f["name"].endswith((".yaml", ".yml"))]
    if not names:
        return {"repo": repo, "state": "NO-WORKFLOWS",
                "detail": ".github/workflows exists but holds no workflow files"}

    for wf in names:
        blob = gh_maybe(f"repos/{ORG}/{repo}/contents/.github/workflows/{wf}")
        if blob is None:
            continue
        import base64
        body = base64.b64decode(blob["content"]).decode("utf8", "replace")
        m = USES_RE.search(body)
        if m and m.group(1) == "tenant-build.yaml":
            ref = m.group(2)
            state = "CURRENT" if ref == current_ref else "BEHIND-TAG"
            return {"repo": repo, "state": state, "ref": ref, "workflow": wf,
                    "detail": f"calls the reusable workflow @{ref}"}

    build = next((n for n in names if n.startswith("build-and-push")), None)
    if build:
        commits = gh(f"repos/{ORG}/{repo}/commits?path=.github/workflows/{build}"
                     f"&per_page=1")
        frozen = (commits[0]["commit"]["committer"]["date"] if commits else None)
        return {"repo": repo, "state": "LOCAL-COPY", "workflow": build,
                "frozen_at": frozen,
                "detail": f"carries its own {build}; does not call the platform "
                          f"pipeline"}
    return {"repo": repo, "state": "NO-PIPELINE",
            "detail": f"workflows present ({', '.join(names)}) but no build pipeline"}


# ── §6.3 tag staleness ───────────────────────────────────────────────────────
def tag_staleness(tag="v1"):
    """
    RAW TAG AGE IS THE WRONG METRIC, and getting this right matters more than the
    threshold. Age alone is ambiguous in both directions:
      * a quiet fortnight with no pipeline changes makes a HEALTHY tag look stale
        (false positive that trains people to ignore it), and
      * a canary that broke on day one of that fortnight looks FINE, because the
        tag would not have moved anyway (false negative — the case we care about).

    What is unambiguous is UNBLESSED WORK: commits to the reusable workflow that
    are newer than the tag. If that count is zero the tag is current by
    definition, however old it is. If it is non-zero, changes exist that the
    canary has not blessed — either the canary is red, or it is not running.

    So: commits_behind is the signal; age is reported for context only.
    """
    ref = gh_maybe(f"repos/{PLATFORM_REPO}/git/refs/tags/{tag}")
    if ref is None:
        raise Fatal(f"tag '{tag}' does not exist on {PLATFORM_REPO}. The reusable "
                    f"pipeline contract names it, so its absence is a fault, not "
                    f"a clean result.")
    sha = ref["object"]["sha"]
    if ref["object"]["type"] == "tag":                     # annotated tag
        sha = gh(f"repos/{PLATFORM_REPO}/git/tags/{sha}")["object"]["sha"]
    tagged = gh(f"repos/{PLATFORM_REPO}/commits/{sha}")
    tag_date = tagged["commit"]["committer"]["date"]
    age_days = (datetime.datetime.now(datetime.timezone.utc)
                - datetime.datetime.fromisoformat(tag_date.replace("Z", "+00:00"))
                ).days

    newer = gh(f"repos/{PLATFORM_REPO}/commits?path={REUSABLE}&since={tag_date}")
    behind = [c for c in newer if c["sha"] != sha]
    unblessed_age = None
    if behind:
        # The OLDEST unblessed commit, NOT the newest. Keying the grace period off
        # the newest one is a guard that can never fire: while changes keep
        # landing, "newest" is always fresh, so a canary that has been red for a
        # month reads as healthy. (Caught by running this against the real fleet —
        # it printed "no unblessed changes" directly beneath "commits behind: 5".)
        # The question is "how long has work been waiting to be blessed?", and the
        # answer is the age of the oldest thing still waiting.
        oldest = behind[-1]["commit"]["committer"]["date"]
        unblessed_age = (datetime.datetime.now(datetime.timezone.utc)
                         - datetime.datetime.fromisoformat(
                             oldest.replace("Z", "+00:00"))).days

    alert = bool(behind) and (unblessed_age or 0) >= TAG_GRACE_DAYS
    return {"tag": tag, "sha": sha[:12], "tagged_at": tag_date,
            "tag_age_days": age_days, "commits_behind": len(behind),
            "unblessed_age_days": unblessed_age, "alert": alert,
            "subjects": [c["commit"]["message"].splitlines()[0][:70]
                         for c in behind[:5]]}


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", choices=["fleet", "tag", "all"], default="all")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--repo-root", default=os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))))
    args = ap.parse_args()

    report = {"generated_at": datetime.datetime.now(
        datetime.timezone.utc).isoformat()}
    drift = False

    if args.check in ("tag", "all"):
        t = tag_staleness()
        report["tag"] = t
        if not args.json:
            print("=" * 74)
            print("§6.3  REUSABLE-TAG STALENESS")
            print("=" * 74)
            print(f"  tag v1 -> {t['sha']}  tagged {t['tagged_at']} "
                  f"({t['tag_age_days']}d ago)")
            print(f"  commits to {REUSABLE} newer than the tag: "
                  f"{t['commits_behind']}")
            for s in t["subjects"]:
                print(f"      · {s}")
            if t["alert"]:
                print(f"  ALERT: {t['commits_behind']} change(s) the canary has "
                      f"not blessed; the oldest has waited "
                      f"{t['unblessed_age_days']}d (grace {TAG_GRACE_DAYS}d).")
                print("         Either the canary is red, or it is not advancing v1.")
                print(f"         Any tenant pinned @{t['tag']} is running a pipeline "
                      f"without those fixes.")
            elif t["commits_behind"]:
                print(f"  WITHIN GRACE: {t['commits_behind']} unblessed change(s), "
                      f"oldest {t['unblessed_age_days']}d < {TAG_GRACE_DAYS}d.")
            else:
                print("  OK: the tag names the current reusable workflow.")
            print()
        drift = drift or t["alert"]

    if args.check in ("fleet", "all"):
        exempt, warn = load_exceptions(args.repo_root)
        tenants = live_tenants()
        current_ref = "v1"
        rows = [classify(r, current_ref) for r in tenants]

        for r in rows:
            if r["repo"] in exempt:
                if exempt[r["repo"]]:
                    r["state"], r["exempt_reason"] = "EXEMPT", exempt[r["repo"]]
                else:
                    # An opt-out nobody justified is itself a finding.
                    r["state"] = "OPT-OUT-NO-REASON"
        report["fleet"] = rows
        report["exceptions_warning"] = warn

        if not args.json:
            print("=" * 74)
            print(f"§6.2  FLEET CI DRIFT — {len(rows)} live tenants "
                  f"(topic:{TENANT_TOPIC})")
            print("=" * 74)
            if warn:
                print(f"  NOTE: {warn}\n")
            order = {"CURRENT": 0, "EXEMPT": 1, "BEHIND-TAG": 2, "LOCAL-COPY": 3,
                     "NO-PIPELINE": 4, "NO-WORKFLOWS": 5, "OPT-OUT-NO-REASON": 6}
            for r in sorted(rows, key=lambda x: (order.get(x["state"], 9),
                                                 x["repo"])):
                extra = r.get("exempt_reason") or r.get("frozen_at") or ""
                if r.get("frozen_at"):
                    extra = f"frozen {r['frozen_at'][:10]}"
                print(f"  {r['state']:<18} {r['repo']:<18} {extra}")
            counts = {}
            for r in rows:
                counts[r["state"]] = counts.get(r["state"], 0) + 1
            print(f"\n  {counts}")
        bad = [r for r in rows if r["state"] not in ("CURRENT", "EXEMPT")]
        drift = drift or bool(bad)

    if args.json:
        print(json.dumps(report, indent=2))
    return 1 if drift else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fatal as e:
        # Exit 2 is deliberately DISTINCT from 1. "Could not run" must never be
        # mistaken for "ran and found nothing".
        print(f"\nFATAL (report could not be trusted): {e}", file=sys.stderr)
        print("Exiting 2 — this is NOT a clean result.", file=sys.stderr)
        sys.exit(2)
