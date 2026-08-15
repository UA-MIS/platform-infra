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
  (d) WIZARD SCHEMA (WIZ-001, FIX-1-REVIEW) — a ONE-TIME, non-per-fragment check (skipped
        under --only): template.yaml's web/single `singleFragment` enum matches the fragment
        library's ground truth (gen-wizard-enums.py), its rjsf `oneOf` database-question
        groups are an EXACT partition of that enum (rjsf silently DROPS the whole dependency
        block — no error — on a fragment matching zero or 2+ groups), every needsDB fragment
        lands in a group that offers `database`, and `host-postgres` is never offered
        alongside a driver-owning fragment. See check_wizard_template().

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
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

import compose_lib
from compose_lib import (ComposeError, compose, discover_fragments,
                         expected_build_artifacts, kustomize_overlays,
                         kustomize_tool, mobile_workflow_reachability,
                         scenario_for, load_meta)

HERE = Path(__file__).resolve().parent
TEMPLATE_PATH = compose_lib.FRAGMENTS.parent / "new-project" / "template.yaml"

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


def _load_gen_wizard_enums():
    """Import gen-wizard-enums.py (hyphenated filename, loaded like a sibling module — same
    trick green-check.test.py already uses for green-check.py itself)."""
    spec = importlib.util.spec_from_file_location(
        "gen_wizard_enums", HERE / "gen-wizard-enums.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _single_fragment_groups(template_doc):
    """Extract the web/single `singleFragment` master enum + its `oneOf` dependency groups
    from a parsed template.yaml. Returns (master_enum, [group, ...]), where each group is
    {"fragments": [...], "database_enum": [...] or None (no `database` property)}.

    Raises ComposeError on unexpected shape — fail closed (WIZ-001): if this navigation ever
    breaks because the template's structure changed, that is itself something the gate must
    surface, not silently skip.
    """
    try:
        web = template_doc["spec"]["parameters"][1]["dependencies"]["projectType"]["oneOf"][0]
        single_layout = web["dependencies"]["layout"]["oneOf"][0]
        master_enum = single_layout["properties"]["singleFragment"]["enum"]
        oneof = single_layout["dependencies"]["singleFragment"]["oneOf"]
    except (KeyError, IndexError, TypeError) as e:
        raise ComposeError(
            f"template.yaml: could not locate the web/single singleFragment schema ({e}) — "
            "the template's structure changed in a way this WIZ-001 check does not expect")
    groups = []
    for i, g in enumerate(oneof):
        frags = g.get("properties", {}).get("singleFragment", {}).get("enum")
        if frags is None:
            raise ComposeError(f"template.yaml: singleFragment oneOf group {i} has no fragment enum")
        db = g.get("properties", {}).get("database", {}).get("enum")
        groups.append({"fragments": frags, "database_enum": db})
    return master_enum, groups


def check_wizard_template():
    """WIZ-001 (FIX-1-REVIEW finding): static-audit template.yaml's web/single `database`
    question for the exact hazard the reviewer demonstrated — rjsf silently DROPS the whole
    `dependencies.singleFragment.oneOf` block (no throw, no validation error) if a fragment
    matches zero or more-than-one of its groups, which happens the moment a new needsDB
    fragment is added to the master `singleFragment` enum (per gen-wizard-enums.py's own
    fan-out instructions) without also being filed into exactly one oneOf group. A fragment
    silently losing its Database question is the SAME green-CI/broken-runtime bug class FIX-1
    exists to prevent — just reached a different way.

    Unlike check_fragment(), this does NOT compose anything — it is a pure schema +
    fragment-metadata cross-check, so it is fast and needs no node/kustomize.

    Checks:
      1. template.yaml's `singleFragment` master enum == gen-wizard-enums.py's single-slot
         derivation (ground truth from fragment.yaml `slots:`), same members, same order.
      2. The oneOf groups are an EXACT partition of that master enum: every member in
         exactly one group (no gaps, no overlaps, no dead/extra entries).
      3. Every needsDB fragment (fragment.yaml `needsDB: true`) is in a group that offers
         `database` — never in the DB-less group.
      4. `host-postgres`, wherever offered, is scoped ONLY to blank/bring-your-own — the one
         fragment independently confirmed (FIX-1-REVIEW's per-language driver-manifest
         audit) to ship no database driver of its own. If a future group ever offers
         host-postgres alongside a driver-owning fragment, that is exactly the class of bug
         D-054 existed to prevent. (This is deliberately narrower than "detect whether a
         fragment ships a driver" in general — that would need a per-language source/lockfile
         grep, which is one-off review work, not a durable structural signal. Broadening the
         set of driver-free fragments is a deliberate, reviewed change to this assumption,
         not something this check infers on its own.)
    """
    result = {"fragment": "new-project/template.yaml", "scenario": None, "ok": False,
              "checks": [], "errors": []}

    def add(name, ok, detail=""):
        result["checks"].append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            result["errors"].append(f"{name}: {detail}")

    try:
        doc = yaml.safe_load(TEMPLATE_PATH.read_text())
        master_enum, groups = _single_fragment_groups(doc)
    except (ComposeError, OSError, yaml.YAMLError) as e:
        add("parse", False, str(e))
        result["errors"].insert(0, str(e))
        return result
    add("parse", True, f"{len(master_enum)} singleFragment members, {len(groups)} oneOf groups")

    # (1) master enum matches the fragment library's ground truth (gen-wizard-enums.py).
    try:
        genmod = _load_gen_wizard_enums()
        ground_truth = [d["_path"] for d in genmod.by_slot(genmod.load(), "single")]
    except Exception as e:
        add("master-enum-matches-slot-truth", False, f"could not derive ground truth: {e}")
        ground_truth = None
    if ground_truth is not None:
        add("master-enum-matches-slot-truth", master_enum == ground_truth,
            "" if master_enum == ground_truth else
            f"template != gen-wizard-enums.py single-slot output — "
            f"template={master_enum} ground_truth={ground_truth}")

    # (2) exact partition of the master enum across the oneOf groups.
    membership = {}
    for gi, g in enumerate(groups):
        for f in g["fragments"]:
            membership.setdefault(f, []).append(gi)
    missing = [f for f in master_enum if f not in membership]
    multi = {f: gi for f, gi in membership.items() if len(gi) > 1}
    extra = sorted(f for f in membership if f not in master_enum)
    partition_ok = not missing and not multi and not extra
    add("exact-partition", partition_ok,
        "" if partition_ok else
        f"missing-from-any-group={missing} in-multiple-groups={multi} not-in-master-enum={extra}")

    # (3) every needsDB fragment is in a database-offering group.
    db_offering_frags = set()
    for g in groups:
        if g["database_enum"] is not None:
            db_offering_frags.update(g["fragments"])
    needsdb_dropped = []
    for rel in master_enum:
        try:
            meta, _ = load_meta(rel)
        except ComposeError as e:
            add(f"fragment-meta[{rel}]", False, str(e))
            continue
        if meta.get("needsDB") and rel not in db_offering_frags:
            needsdb_dropped.append(rel)
    add("needsdb-fragments-offer-database", not needsdb_dropped,
        "" if not needsdb_dropped else
        f"needsDB fragment(s) with NO reachable database question: {needsdb_dropped}")

    # (4) host-postgres scoped to blank/bring-your-own only.
    for gi, g in enumerate(groups):
        if g["database_enum"] and "host-postgres" in g["database_enum"]:
            driver_owning = [f for f in g["fragments"] if not f.startswith("blank/")]
            add(f"host-postgres-scoped-to-driver-free[group {gi}]", not driver_owning,
                "" if not driver_owning else
                f"host-postgres offered alongside driver-owning fragment(s): {driver_owning}")

    result["ok"] = all(c["ok"] for c in result["checks"])
    return result


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

    # WIZ-001 (FIX-1-REVIEW): the wizard SCHEMA itself, not any one fragment's scaffold — a
    # separate concern from the per-fragment sweep above, so it is skipped for a targeted
    # --only fragment check but always runs on the default (CI-gate) sweep. Never
    # quarantine-eligible (not in QUARANTINE) — a broken partition is a live, unfixed hazard,
    # not a known/tracked/deferred one, so it must always fail the gate.
    if a.only is None:
        results.append(check_wizard_template())

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
