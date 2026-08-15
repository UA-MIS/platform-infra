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
  (b) KUSTOMIZE — `kustomize build` succeeds on ALL FOUR overlays (dev/staging/prod/preview),
        i.e. ArgoCD can render the chart the wizard emitted.
  (c) DOCKERFILE LINT / BUILD (optional, --docker-build) — actually `docker build` each
        container/static component's Dockerfile. Off by default (heavy + network); the build-file
        + kustomize checks are the durable, hermetic gate.
  (d) BOOT-AND-PROBE (optional, --boot-probe; GATE-1) — the RUNTIME half static checks (a)-(c)
        cannot cover: actually BUILD and RUN each single-slot-capable fragment's image, under
        the chart's real `--read-only --tmpfs /tmp --tmpfs /dev/shm:size=64m` contract, against
        a REAL disposable MariaDB with the platform's exact bare `mysql://` DSN shape, then
        probe GET /healthz on the chart's real startupProbe schedule (periodSeconds=2,
        failureThreshold=30). This is what caught backend/fastapi (F-6, eager DBAPI resolution)
        and static/react-static (FINDING-6, nginx writing to a read-only /var/cache) — both
        invisible to (a)-(c), which only prove a fragment WOULD build/render, never that it
        BOOTS. See boot_probe.py and artifacts/exploration/fragment-readonly-smoke-2026-08-15.md
        (the reference green set this stage reproduces). Off by default: heavy (needs a working
        docker/podman daemon) and this repo's self-hosted ARC runners have none by design
        (containerMode:kubernetes, Kaniko-rootless) — see wizard-green-check.yaml's
        boot-and-probe job, which runs this on GitHub-hosted ubuntu-latest instead, same as the
        existing hermetic green-check job.

Fragments are DISCOVERED from disk, so a new fragment (e.g. blank/bring-your-own once PR-A lands)
is covered automatically — the gate needs no edit to cover a new stack. A fragment that would
scaffold red fails this check, so the platform-infra CI workflow that runs it blocks the merge.

Exit 0 = every fragment green. Exit 1 = at least one fragment is NOT green out of the box (the
per-fragment table + a FINDINGS section say which and why). Exit 2 = harness/environment error.

Usage:
  green-check.py                      # check every fragment (needs node + kustomize/kubectl)
  green-check.py --only backend/go    # one fragment
  green-check.py --docker-build       # also docker-build each Dockerfile (slow)
  green-check.py --boot-probe         # also boot + probe each single-slot fragment (GATE-1)
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

import boot_probe
import compose_lib
from compose_lib import (ComposeError, compose, discover_fragments,
                         expected_build_artifacts, kustomize_overlays,
                         kustomize_tool, scenario_for, load_meta)


def check_fragment(rel, workdir, *, do_docker=False, kz_tool=None, mariadb=None):
    """Compose `rel` into workdir/<rel> and run the green-out-of-box assertions.

    `mariadb`, when given a started boot_probe.MariaDBFixture, additionally boot-probes the
    fragment (GATE-1, see module docstring's (d)) — but ONLY for a fragment whose OWN scenario
    resolves to the single-slot layout (scenario_for() picks "single" when 'single' is in the
    fragment's slots). This is deliberately the same 19-fragment set the reference smoke
    (artifacts/exploration/fragment-readonly-smoke-2026-08-15.md) covers: a fragment used only
    as a DEFAULT_FRONTEND/DEFAULT_BACKEND partner for some OTHER fragment's scenario is not
    independently boot-probed here (it gets exercised as a partner in that other fragment's
    kustomize/build-file checks already). Mobile fragments never resolve to "single", so they
    are naturally out of scope — no explicit quarantine list needed here.

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

    # (d) boot-and-probe (GATE-1) — only for THIS fragment's own single-slot scenario; see
    # the docstring above for why frontend/backend "partner" fragments are skipped here.
    if mariadb is not None and sel.get("layout") == "single" and sel.get("single") == rel:
        app = next((c for c in composed.plan["components"] if c["name"] == "app"), None)
        if app is None:
            add("boot-probe", False, "no 'app' component in the single-slot plan (unexpected)")
        else:
            try:
                ok, detail = boot_probe.boot_probe_component(app, out, mariadb)
                add("boot-probe", ok, detail)
            except boot_probe.BootProbeError as e:
                add("boot-probe", False, f"environment error: {e}")

    result["ok"] = all(c["ok"] for c in result["checks"])
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append", default=None,
                    help="check only these fragment rel-paths (repeatable); default = all")
    ap.add_argument("--docker-build", action="store_true",
                    help="also `docker build` each Dockerfile (slow; needs docker + network)")
    ap.add_argument("--boot-probe", action="store_true",
                    help="also boot + probe each single-slot fragment against real MariaDB, "
                         "under the chart's --read-only contract (GATE-1; slow, sequential, "
                         "needs docker/podman + network)")
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

    # ONE MariaDB container, shared across the whole sweep (see boot_probe.py's module
    # docstring) — started once here, reused per-fragment via mariadb.make_database(), torn
    # down once at the end. Fragments are still checked ONE AT A TIME below (a plain list
    # comprehension, no parallelism) — boot-probe builds/runs one image at a time by design.
    mariadb = None
    if a.boot_probe:
        try:
            mariadb = boot_probe.MariaDBFixture.start()
        except boot_probe.BootProbeError as e:
            print(f"green-check: FATAL — --boot-probe environment error: {e}", file=sys.stderr)
            return 2

    workdir = Path(a.workdir) if a.workdir else Path(tempfile.mkdtemp(prefix="green-check-"))
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        results = [check_fragment(rel, workdir, do_docker=a.docker_build, kz_tool=kz_tool,
                                  mariadb=mariadb)
                   for rel in fragments]
    finally:
        if not a.keep and not a.workdir:
            shutil.rmtree(workdir, ignore_errors=True)
        if mariadb is not None:
            mariadb.stop()

    passed = [r for r in results if r["ok"]]
    failed = [r for r in results if not r["ok"]]

    if a.json:
        json.dump({"total": len(results), "passed": len(passed),
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
        status = "GREEN" if r["ok"] else "RED  "
        ncheck = len(r["checks"])
        nfail = sum(1 for c in r["checks"] if not c["ok"])
        detail = f"{ncheck} checks" if r["ok"] else f"{nfail}/{ncheck} FAILED"
        print(f"  [{status}] {r['fragment']:<{width}}  {detail}")

    if failed:
        print("\n--- FINDINGS (fragments NOT green out of the box) ---")
        for r in failed:
            print(f"\n* {r['fragment']}  (scenario: {r['scenario']})")
            for err in r["errors"]:
                print(f"    - {err}")

    print(f"\n{len(passed)}/{len(results)} fragments GREEN out of the box.")
    print("=== GREEN-CHECK " + ("OK ===" if not failed else "FAILED ===") + "\n")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
