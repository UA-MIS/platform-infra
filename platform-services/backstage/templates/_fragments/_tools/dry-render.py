#!/usr/bin/env python3
"""dry-render.py — OFFLINE proof of the unified "New Project" compose engine (ADR-034).

Without a running Backstage, this replays a scaffold: it parses the chosen fragment.yaml
metadata, asks the REAL Node planner (composePlan.js — the same module the live
capstone:compose-project action uses, so NO drift) for the component plan, then renders the
shared _contract/ + the chosen fragment skeleton(s) into an output tree exactly as the
action would (jinja2 with Backstage's ${{ }} / {% %} delimiters; .github/** and
.devops/ci/** shipped verbatim = copyWithoutTemplating).

It then prints the assembled tree + the rendered components.yaml + the DB wiring, and (if
kustomize/kubectl is available) validates every overlay renders. This is the acceptance
proof for "dry-render a single-component AND a FE+BE project -> coherent output".

Usage:
  dry-render.py --scenario single-fastapi-mysql   --out /tmp/out1
  dry-render.py --scenario febe-react-express-mysql --out /tmp/out2
  dry-render.py --project-type web --layout frontend-backend \
                --frontend react --backend express --database host-mysql --out /tmp/out
"""
import argparse, json, os, shutil, subprocess, sys, fnmatch
from pathlib import Path

import yaml
from jinja2 import Environment, StrictUndefined

HERE = Path(__file__).resolve().parent
FRAGMENTS = HERE.parent                      # .../templates/_fragments
CONTRACT = FRAGMENTS / "_contract"
PLANNER = (
    FRAGMENTS.parent.parent                  # .../backstage
    / "app/plugins/scaffolder-backend-module-capstone/src/actions/composePlan.js"
)

# Files shipped VERBATIM (never templated) — the copyWithoutTemplating contract.
NO_TEMPLATE = ["**/.github/**", ".github/**", "**/.devops/ci/**", ".devops/ci/**"]

# Backstage's scaffolder nunjucks uses ${{ }} for variables; blocks stay {% %}.
JENV = Environment(
    variable_start_string="${{", variable_end_string="}}",
    block_start_string="{%", block_end_string="%}",
    comment_start_string="{#", comment_end_string="#}",
    undefined=StrictUndefined, keep_trailing_newline=True,
    trim_blocks=False, lstrip_blocks=False,
)

SCENARIOS = {
    "single-fastapi-mysql": dict(projectType="web", layout="single", single="backend/fastapi", database="host-mysql"),
    "febe-react-express-mysql": dict(projectType="web", layout="frontend-backend", frontend="frontend/react", backend="backend/express", database="host-mysql"),
    "single-static": dict(projectType="web", layout="single", single="static/react-static", database="none"),
}


def load_meta(rel):
    p = FRAGMENTS / rel / "fragment.yaml"
    if not p.exists():
        sys.exit(f"fragment not found: {p}")
    return yaml.safe_load(p.read_text()), (FRAGMENTS / rel)


def run_planner(plan_input):
    js = (
        "const{planComposition}=require(process.argv[1]);"
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>"
        "{try{process.stdout.write(JSON.stringify(planComposition(JSON.parse(s))))}"
        "catch(e){console.error(e.message);process.exit(2)}});"
    )
    r = subprocess.run(["node", "-e", js, str(PLANNER)], input=json.dumps(plan_input),
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"planner failed: {r.stderr.strip()}")
    return json.loads(r.stdout)


def is_verbatim(relpath):
    return any(fnmatch.fnmatch(relpath, pat) for pat in NO_TEMPLATE)


def render_tree(src_root, dst_root, values, subdir_filter=None):
    # Backstage fetch:template exposes the step's `values:` under a `values` namespace,
    # so skeleton files reference ${{ values.appName }}. Render with that single namespace.
    for path in sorted(src_root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(src_root).as_posix()
        if subdir_filter and not rel.startswith(subdir_filter):
            continue
        out = dst_root / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        raw = path.read_bytes()
        if is_verbatim(rel):
            out.write_bytes(raw)
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            out.write_bytes(raw)
            continue
        try:
            out.write_text(JENV.from_string(text).render(values=values))
        except Exception as e:  # noqa: BLE001
            sys.exit(f"TEMPLATE ERROR in {rel}: {e}")


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

    # Parse the chosen fragments -> metas + their source dirs (for copying skeleton/).
    metas, srcdirs = {}, {}
    for slot in ("single", "frontend", "backend", "mobile"):
        if sel.get(slot):
            metas[slot], srcdirs[slot] = load_meta(sel[slot])

    plan = run_planner({
        "projectType": sel["projectType"], "layout": sel.get("layout"),
        "fragments": metas, "database": sel.get("database", "none"), "port": a.port,
    })

    values = dict(
        appName=a.appName, team=a.team, semester="2026-fall",
        semesterDisplay="Capstone Fall 2026", port=a.port,
        description="A UA-MIS capstone project (dry-render).",
        destination={"owner": "UA-MIS", "repo": a.appName},
        components=plan["components"], database=plan["database"],
        dbWired=plan["dbWired"], single=plan["single"],
    )

    out = Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # 1) the shared contract (rendered once).
    render_tree(CONTRACT, out, values)
    # 2) each fragment's skeleton/ -> its target dir.
    for c in plan["copies"]:
        # find the slot whose meta.id matches this copy's fragment id
        slot = next(s for s, m in metas.items() if m["id"] == c["fragment"]["id"])
        render_tree(srcdirs[slot] / "skeleton", out / c["targetDir"], values)

    # ---- report ---------------------------------------------------------------
    print(f"\n=== DRY-RENDER: {sel} -> {out} ===")
    print(f"plan.database={plan['database']}  dbWired={plan['dbWired']}  single={plan['single']}")
    print("components:")
    for c in plan["components"]:
        print(f"  - {c['name']:8} kind={c['kind']:8} path={c['path'] or '(none)':5} "
              f"port={c['port']} needsDb={c['needsDb']} buildType={c['buildType']} context={c['context']}")
    print("\nassembled top-level dirs:",
          sorted(p.name for p in out.iterdir()))
    print("\n--- rendered .devops/components.yaml ---")
    print((out / ".devops/components.yaml").read_text())
    print("--- .devops/app-metadata.yaml ---")
    print((out / ".devops/app-metadata.yaml").read_text())
    es = (out / ".devops/chart/overlays/dev/app-secret.externalsecret.yaml").read_text()
    print("DATABASE_URL wired into dev app-secret:", "DATABASE_URL" in es)

    # validate rendered YAML parses (components + app-metadata + chart base)
    for f in [".devops/components.yaml", ".devops/app-metadata.yaml"]:
        list(yaml.safe_load_all((out / f).read_text()))
    print("rendered components.yaml + app-metadata.yaml parse OK")

    # 3) real kustomize validation if available.
    kz = shutil.which("kustomize") or shutil.which("kubectl")
    if kz:
        for env in ("dev", "staging", "prod", "preview"):
            cmd = ([kz, "build"] if "kustomize" in kz else [kz, "kustomize"]) + \
                  [str(out / ".devops/chart/overlays" / env)]
            r = subprocess.run(cmd, capture_output=True, text=True)
            status = "OK" if r.returncode == 0 else f"FAIL\n{r.stderr.strip()[:800]}"
            print(f"kustomize {env}: {status}")
            if r.returncode != 0:
                sys.exit(1)
    else:
        print("kustomize/kubectl not found — skipped chart build validation")
    print("=== DRY-RENDER OK ===\n")


if __name__ == "__main__":
    main()
