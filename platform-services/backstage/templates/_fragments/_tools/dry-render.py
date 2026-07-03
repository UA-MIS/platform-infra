#!/usr/bin/env python3
"""dry-render.py — OFFLINE proof of the unified "New Project" compose engine (ADR-034).

Without a running Backstage, this replays a scaffold for ONE chosen selection and prints the
assembled tree + the rendered components.yaml + the DB wiring, then (if kustomize/kubectl is
available) validates every overlay renders. This is the acceptance proof for "dry-render a
single-component AND a FE+BE project -> coherent output".

The compose/plan/render logic lives ONCE in compose_lib.py (shared with the green-out-of-box
CI gate green-check.py — copy-not-reference is the bug generator); this file is the thin
interactive CLI + human-readable report over it.

Usage:
  dry-render.py --scenario single-fastapi-mysql   --out /tmp/out1
  dry-render.py --scenario febe-react-express-mysql --out /tmp/out2
  dry-render.py --project-type web --layout frontend-backend \
                --frontend react --backend express --database host-mysql --out /tmp/out
"""
import argparse
import sys

import yaml

import compose_lib
from compose_lib import ComposeError, compose, kustomize_overlays, kustomize_tool

SCENARIOS = {
    "single-fastapi-mysql": dict(projectType="web", layout="single", single="backend/fastapi", database="host-mysql"),
    "febe-react-express-mysql": dict(projectType="web", layout="frontend-backend", frontend="frontend/react", backend="backend/express", database="host-mysql"),
    "single-static": dict(projectType="web", layout="single", single="static/react-static", database="none"),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=list(SCENARIOS))
    ap.add_argument("--project-type", dest="projectType", choices=["web", "mobile"])
    ap.add_argument("--layout", choices=["single", "frontend-backend"])
    ap.add_argument("--single"); ap.add_argument("--frontend")
    ap.add_argument("--backend"); ap.add_argument("--mobile")
    ap.add_argument("--database", default=None)  # None so a --scenario's DB choice is not clobbered
    ap.add_argument("--app-name", dest="appName", default="demo-app")
    ap.add_argument("--team", default="demo-team")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    sel = SCENARIOS[a.scenario].copy() if a.scenario else {}
    for k in ("projectType", "layout", "single", "frontend", "backend", "mobile", "database"):
        if getattr(a, k, None):
            sel[k] = getattr(a, k)

    # Allow bare fragment ids on the CLI (--frontend react) by resolving to a rel path.
    for slot in ("single", "frontend", "backend", "mobile"):
        v = sel.get(slot)
        if v and "/" not in v:
            match = [f for f in compose_lib.discover_fragments() if f.split("/")[-1] == v]
            if len(match) == 1:
                sel[slot] = match[0]

    try:
        c = compose(sel, a.out, app_name=a.appName, team=a.team, port=a.port)
    except ComposeError as e:
        sys.exit(str(e))

    plan, out = c.plan, c.out

    # ---- report ---------------------------------------------------------------
    print(f"\n=== DRY-RENDER: {sel} -> {out} ===")
    print(f"plan.database={plan['database']}  dbWired={plan['dbWired']}  single={plan['single']}")
    print("components:")
    for comp in plan["components"]:
        print(f"  - {comp['name']:8} kind={comp['kind']:8} path={comp['path'] or '(none)':5} "
              f"port={comp['port']} needsDb={comp['needsDb']} buildType={comp['buildType']} context={comp['context']}")
    print("\nassembled top-level dirs:",
          sorted(p.name for p in out.iterdir()))
    print("\n--- rendered .devops/components.yaml ---")
    print((out / ".devops/components.yaml").read_text())
    print("--- .devops/app-metadata.yaml ---")
    print((out / ".devops/app-metadata.yaml").read_text())
    es = (out / ".devops/chart/overlays/dev/app-secret.externalsecret.yaml").read_text()
    print("DATABASE_URL wired into dev app-secret:", "DATABASE_URL" in es)

    # validate rendered YAML parses (components + app-metadata)
    for f in [".devops/components.yaml", ".devops/app-metadata.yaml"]:
        list(yaml.safe_load_all((out / f).read_text()))
    print("rendered components.yaml + app-metadata.yaml parse OK")

    # real kustomize validation if available.
    if kustomize_tool() is None:
        print("kustomize/kubectl not found — skipped chart build validation")
    else:
        for env, ok, err in kustomize_overlays(out):
            print(f"kustomize {env}: {'OK' if ok else 'FAIL' + chr(10) + err[:800]}")
            if not ok:
                sys.exit(1)
    print("=== DRY-RENDER OK ===\n")


if __name__ == "__main__":
    main()
