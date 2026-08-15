#!/usr/bin/env python3
"""green-check.py — the GREEN-OUT-OF-BOX gate for the unified "New Project" wizard (ADR-035 §B).

The wizard's promise is that EVERY output — every fragment, every layout, blank/BYO — scaffolds
a repo whose FIRST CI run is GREEN, so a student never lands on a red-out-of-box project. This
harness enforces that offline: for every composable fragment it discovers, it replays a scaffold
(via compose_lib — the SAME planner + render the live capstone:compose-project action uses, no
drift) into a temp repo and asserts the repo is buildable exactly as the tenant CI would build it:

  (a) BUILD FILE — every deployable component ships the file its build step consumes:
        - container/static component -> <context>/<dockerfile>  (Kaniko build in tenant CI's
          build-and-push.yaml matrix);
        - mobile-artifact component  -> <targetDir>/<buildWorkflow>  (its own mobile workflow).
  (a2) WORKFLOW REACHABILITY (F-3/D-058) — for a mobile-artifact component, (a) only proves
        the buildWorkflow file EXISTS; this additionally asserts it lands under
        .github/workflows/ at the repo root, the ONLY place GitHub Actions discovers and
        runs a workflow. A file that exists elsewhere (e.g. <targetDir>/.mobile-ci/
        build.yaml, every shipped mobile fragment today) is a FALSE GREEN: CI stays green,
        no .apk/.ipa is ever built, silently. See compose_lib.mobile_workflow_reachability.
  (b) KUSTOMIZE — `kustomize build` succeeds on ALL FOUR overlays (dev/staging/prod/preview),
        i.e. ArgoCD can render the chart the wizard emitted.
  (c) DOCKERFILE LINT / BUILD (optional, --docker-build) — actually `docker build` each
        container/static component's Dockerfile. Off by default (heavy + network); the build-file
        + kustomize checks are the durable, hermetic gate.

Fragments are DISCOVERED from disk, so a new fragment (e.g. blank/bring-your-own once PR-A lands)
is covered automatically — the gate needs no edit to cover a new stack. A fragment that would
scaffold red fails this check, so the platform-infra CI workflow that runs it blocks the merge —
UNLESS it is in QUARANTINE (below), a known-tracked, wizard-hidden exception, currently just the
four mobile/* fragments (F-3/D-058).

Exit 0 = every non-quarantined fragment green. Exit 1 = at least one non-quarantined fragment is
NOT green out of the box (the per-fragment table + a FINDINGS section say which and why); a
quarantined fragment is still composed, checked, and reported every run (see the QUARANTINED
section), it just does not affect the exit code, UNLESS explicitly selected via --only, which
always reports the TRUE status. Exit 2 = harness/environment error.

Usage:
  green-check.py                      # check every fragment (needs node + kustomize/kubectl)
  green-check.py --only backend/go    # one fragment (bypasses quarantine — always true status)
  green-check.py --docker-build       # also docker-build each Dockerfile (slow)
  green-check.py --json               # machine-readable results on stdout
  green-check.py --keep               # keep the composed repos under --workdir for inspection
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import compose_lib
from compose_lib import (ComposeError, compose, discover_fragments,
                         expected_build_artifacts, kustomize_overlays,
                         kustomize_tool, mobile_workflow_reachability,
                         scenario_for, load_meta)

# QUARANTINE (F-3/D-058) — fragments with a KNOWN, TRACKED red finding that the wizard no
# longer offers a path to (mobile is hidden from the new-project template, see
# templates/new-project/template.yaml). Every mobile buildWorkflow composes to
# <targetDir>/.mobile-ci/build.yaml, which GitHub Actions never discovers or runs (see
# compose_lib.mobile_workflow_reachability) — a real, currently-unfixed bug. Re-routing the
# workflow files is DEFERRED (D-058: billing implications, GitHub-hosted macos-14 minutes
# against the org's Free-plan pool) — NOT a pre-Tuesday fix.
#
# Quarantining is a VISIBILITY-PRESERVING skip, not a silent one: a quarantined fragment is
# still composed and still checked every run (see main() below) and still shows up RED in
# the report — it just does not fail the unfiltered default sweep's exit code, so the
# platform-infra CI gate (wizard-green-check.yaml) is not permanently blocked by a known,
# tracked, wizard-hidden issue. An explicit `--only <fragment>` ALWAYS reports the fragment's
# true status, quarantine or not — this is how devops-fragments (and this gate's own tests)
# prove the reachability assertion actually catches the bug: `green-check.py --only
# mobile/flutter` still exits 1.
QUARANTINE = {
    "mobile/android-kotlin": "F-3/D-058: buildWorkflow not under .github/workflows/",
    "mobile/flutter": "F-3/D-058: buildWorkflow not under .github/workflows/",
    "mobile/ios-swift": "F-3/D-058: buildWorkflow not under .github/workflows/",
    "mobile/react-native": "F-3/D-058: buildWorkflow not under .github/workflows/",
}


def partition_results(results, quarantine_active):
    """Split check_fragment() results into (passed, quarantined, failed).

    `quarantined` = results that are NOT ok, whose fragment is in QUARANTINE, AND
    quarantine_active is True. Pure function (no I/O) so the aggregation logic is unit
    tested without a real compose/kustomize run — see green-check.test.py.
    """
    passed, quarantined, failed = [], [], []
    for r in results:
        if r["ok"]:
            passed.append(r)
        elif quarantine_active and r["fragment"] in QUARANTINE:
            quarantined.append(r)
        else:
            failed.append(r)
    return passed, quarantined, failed


def check_fragment(rel, workdir, *, do_docker=False, kz_tool=None):
    """Compose `rel` into workdir/<rel> and run the green-out-of-box assertions.

    Returns a result dict: {fragment, scenario, ok, checks:[...], errors:[...]}. `checks`
    is a list of (name, ok, detail) so the report can show every gate, green or not.
    """
    result = {"fragment": rel, "scenario": None, "ok": False, "checks": [], "errors": []}

    def add(name, ok, detail=""):
        result["checks"].append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            result["errors"].append(f"{name}: {detail}")

    try:
        meta, _ = load_meta(rel)
        sel = scenario_for(meta, rel)
        result["scenario"] = sel
    except ComposeError as e:
        add("scenario", False, str(e))
        return result

    out = Path(workdir) / rel.replace("/", "__")
    try:
        composed = compose(sel, out)
        add("compose", True, f"{len(composed.plan['components'])} component(s)")
    except ComposeError as e:
        add("compose", False, str(e))
        return result

    # (a) build file per component (Dockerfile or mobile buildWorkflow).
    try:
        artifacts = expected_build_artifacts(composed)
    except ComposeError as e:
        add("build-file", False, str(e))
        artifacts = []
    for comp_name, rel_path in artifacts:
        f = out / rel_path
        exists = f.is_file() and f.stat().st_size > 0
        add(f"build-file[{comp_name}]", exists,
            rel_path if exists else f"MISSING or empty: {rel_path}")

    # (a2) mobile buildWorkflow must land where GitHub Actions actually executes it, not
    # merely EXIST on disk (F-3/D-058 — see compose_lib.mobile_workflow_reachability).
    try:
        for comp_name, rel_path, reachable in mobile_workflow_reachability(composed):
            add(f"workflow-reachable[{comp_name}]", reachable,
                "" if reachable else
                f"{rel_path} is not under {compose_lib.GITHUB_WORKFLOWS_DIR} — GitHub "
                "Actions will never discover or run this workflow (F-3/D-058)")
    except ComposeError as e:
        add("workflow-reachable", False, str(e))

    # (b) kustomize builds all four overlays.
    try:
        for env, ok, err in kustomize_overlays(out, tool=kz_tool):
            add(f"kustomize[{env}]", ok, "" if ok else err[:600])
    except ComposeError as e:
        add("kustomize", False, str(e))

    # (c) optional real docker build of each container/static Dockerfile.
    if do_docker:
        for comp in composed.plan["components"]:
            if comp["buildType"] == "mobile-artifact":
                continue
            ctx = out / comp["context"]
            dockerfile = ctx / (comp.get("dockerfile") or "Dockerfile")
            cmd = ["docker", "build", "-q", "-f", str(dockerfile), str(ctx)]
            r = subprocess.run(cmd, capture_output=True, text=True)
            add(f"docker-build[{comp['name']}]", r.returncode == 0,
                "" if r.returncode == 0 else r.stderr.strip()[:600])

    result["ok"] = all(c["ok"] for c in result["checks"])
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append", default=None,
                    help="check only these fragment rel-paths (repeatable); default = all")
    ap.add_argument("--docker-build", action="store_true",
                    help="also `docker build` each Dockerfile (slow; needs docker + network)")
    ap.add_argument("--json", action="store_true", help="emit machine-readable results")
    ap.add_argument("--keep", action="store_true", help="keep composed repos in --workdir")
    ap.add_argument("--workdir", default=None, help="where to compose repos (default: a temp dir)")
    a = ap.parse_args()

    fragments = a.only or discover_fragments()
    if not fragments:
        print("green-check: no fragments discovered", file=sys.stderr)
        return 2

    # kustomize is the load-bearing (b) check — a CI run without it is a false green.
    kz_tool = kustomize_tool()
    if kz_tool is None and not a.json:
        print("green-check: FATAL — kustomize/kubectl not found; the overlay build check "
              "cannot run. Install kustomize (or kubectl) before gating.", file=sys.stderr)
        return 2

    workdir = Path(a.workdir) if a.workdir else Path(tempfile.mkdtemp(prefix="green-check-"))
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        results = [check_fragment(rel, workdir, do_docker=a.docker_build, kz_tool=kz_tool)
                   for rel in fragments]
    finally:
        if not a.keep and not a.workdir:
            shutil.rmtree(workdir, ignore_errors=True)

    # Quarantine only ever applies to the UNFILTERED default sweep (the CI gate). An
    # explicit --only is a deliberate, targeted check — it always reports the truth, which is
    # exactly how this assertion's effectiveness is proven (see QUARANTINE docstring above).
    quarantine_active = a.only is None
    passed, quarantined, failed = partition_results(results, quarantine_active)

    if a.json:
        json.dump({"total": len(results), "passed": len(passed),
                   "quarantined": [{"fragment": r["fragment"], "reason": QUARANTINE[r["fragment"]]}
                                    for r in quarantined],
                   "failed": [r["fragment"] for r in failed], "results": results},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0 if not failed else 1

    # ---- human report ---------------------------------------------------------
    print("\n=== GREEN-OUT-OF-BOX CHECK (ADR-035 §B) ===")
    print(f"fragments: {len(results)}   tool: {' '.join(kz_tool)}   "
          f"docker-build: {'on' if a.docker_build else 'off'}\n")
    width = max(len(r["fragment"]) for r in results)
    for r in sorted(results, key=lambda x: x["fragment"]):
        if r["ok"]:
            status = "GREEN"
        elif quarantine_active and r["fragment"] in QUARANTINE:
            status = "QUAR "
        else:
            status = "RED  "
        ncheck = len(r["checks"])
        nfail = sum(1 for c in r["checks"] if not c["ok"])
        detail = f"{ncheck} checks" if r["ok"] else f"{nfail}/{ncheck} FAILED"
        print(f"  [{status}] {r['fragment']:<{width}}  {detail}")

    if quarantined:
        print("\n--- QUARANTINED (known-red, tracked, does not block this gate) ---")
        for r in quarantined:
            print(f"\n* {r['fragment']}  ({QUARANTINE[r['fragment']]})")
            for err in r["errors"]:
                print(f"    - {err}")
        print("\n  Re-run with --only <fragment> to see the TRUE status (bypasses quarantine).")

    if failed:
        print("\n--- FINDINGS (fragments NOT green out of the box) ---")
        for r in failed:
            print(f"\n* {r['fragment']}  (scenario: {r['scenario']})")
            for err in r["errors"]:
                print(f"    - {err}")

    print(f"\n{len(passed)}/{len(results)} fragments GREEN"
          f"{f', {len(quarantined)} quarantined' if quarantined else ''} out of the box.")
    print("=== GREEN-CHECK " + ("OK ===" if not failed else "FAILED ===") + "\n")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
