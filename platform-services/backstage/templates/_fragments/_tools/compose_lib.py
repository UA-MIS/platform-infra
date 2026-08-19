#!/usr/bin/env python3
"""compose_lib.py — the SHARED, offline compose core for the unified "New Project" wizard.

Single source of truth for what a scaffold produces WITHOUT a running Backstage: locating
the fragments / _contract / planner, running the REAL Node planner (composePlan.mjs — the
same module the live capstone:compose-project action uses, so NO drift), and rendering the
composed repo tree exactly as the action would (jinja2 with Backstage's ${{ }} / {% %}
delimiters; .github/** and .devops/ci/** shipped verbatim = copyWithoutTemplating).

Two harnesses build-read this module rather than re-implementing the engine
(copy-not-reference is the bug generator — the project retro's core lesson):

  - dry-render.py   — the interactive, single-scenario proof (assembled tree + DB wiring).
  - green-check.py  — the CI "green-out-of-box" gate that composes EVERY fragment and
                      asserts a buildable repo (Dockerfile / buildWorkflow + kustomize).

Library functions raise ComposeError on a bad fragment/plan (so a batch caller can catch
per-fragment and keep going); the thin CLI wrappers translate that into an exit code.
"""
import fnmatch
import json
import shutil
import subprocess
from collections import namedtuple
from pathlib import Path

import yaml
from jinja2 import Environment, StrictUndefined

HERE = Path(__file__).resolve().parent          # .../templates/_fragments/_tools
FRAGMENTS = HERE.parent                          # .../templates/_fragments
CONTRACT = FRAGMENTS / "_contract"
PLANNER = (
    FRAGMENTS.parent.parent                      # .../backstage
    / "app/plugins/scaffolder-backend-module-capstone/src/actions/composePlan.mjs"
)

# Files shipped VERBATIM (never templated) — the copyWithoutTemplating contract.
NO_TEMPLATE = ["**/.github/**", ".github/**", "**/.devops/ci/**", ".devops/ci/**"]

# Backstage's scaffolder nunjucks uses ${{ }} for variables; blocks stay {% %}. Comments are
# `{#! … !#}`, NOT the stock jinja/nunjucks `{# … #}`: fragment source is arbitrary framework
# code and several frameworks use `{#…}` as real syntax (Svelte `{#if}`/`{#each}`, Handlebars
# `{{#…}}`), which the stock `{#` comment start would eat or choke on. The three-char `{#!`
# start collides with nothing. MUST stay identical to makeNunjucks() in composeProject.ts
# (the live action) — these two engines share the delimiter contract and must not drift.
JENV = Environment(
    variable_start_string="${{", variable_end_string="}}",
    block_start_string="{%", block_end_string="%}",
    comment_start_string="{#!", comment_end_string="!#}",
    undefined=StrictUndefined, keep_trailing_newline=True,
    trim_blocks=False, lstrip_blocks=False,
)
# Mirrors nunjucks' built-in `dump` filter (JSON.stringify) used by makeNunjucks() in
# composeProject.ts. Plain jinja2.Environment ships no `dump`/`tojson` filter by default
# (that's a Flask addition), so without this registration any fragment file using
# `| dump` (e.g. _contract/catalog-info.yaml's `description` field, D-106) would raise
# "No filter named 'dump'" here even though the live nunjucks action renders it fine --
# exactly the two-engines-drift bug this module's docstring warns against.
JENV.filters["dump"] = json.dumps

# Slots a fragment may declare, in the order the planner keys them.
SLOTS = ("single", "frontend", "backend", "mobile")

# The default partner fragments used to exercise a fragment that cannot stand alone
# (a pure frontend needs a backend; a mobile app needs its API backend). These are proven
# fragments, so a failure of the partner is a real regression too.
DEFAULT_BACKEND = "backend/express"
DEFAULT_FRONTEND = "frontend/react"

# A composed repo carries everything the assertions + report need.
Composed = namedtuple("Composed", "out plan values metas srcdirs selection")


class ComposeError(Exception):
    """A fragment/plan is malformed or the render failed — caught per-fragment by batch callers."""


def load_meta(rel):
    """Parse a fragment's fragment.yaml. `rel` is FRAGMENTS-relative, e.g. 'backend/fastapi'."""
    p = FRAGMENTS / rel / "fragment.yaml"
    if not p.exists():
        raise ComposeError(f"fragment not found: {p}")
    return yaml.safe_load(p.read_text()), (FRAGMENTS / rel)


def run_planner(plan_input):
    """Ask the REAL Node planner (composePlan.mjs) for the component plan (no drift)."""
    # composePlan is native ESM, so load it with dynamic import() (needs a file:// URL for an
    # absolute path, hence pathToFileURL).
    js = (
        "import('node:url').then(({pathToFileURL})=>"
        "import(pathToFileURL(process.argv[1]).href)).then(({planComposition})=>"
        "{let s='';process.stdin.on('data',d=>s+=d).on('end',()=>"
        "{try{process.stdout.write(JSON.stringify(planComposition(JSON.parse(s))))}"
        "catch(e){console.error(e.message);process.exit(2)}});})"
        ".catch(e=>{console.error(e.message);process.exit(2)});"
    )
    r = subprocess.run(["node", "-e", js, str(PLANNER)], input=json.dumps(plan_input),
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise ComposeError(f"planner failed: {r.stderr.strip()}")
    return json.loads(r.stdout)


def is_verbatim(relpath):
    return any(fnmatch.fnmatch(relpath, pat) for pat in NO_TEMPLATE)


def render_tree(src_root, dst_root, values, subdir_filter=None):
    """Render every file under src_root into dst_root (verbatim files copied byte-for-byte)."""
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
            raise ComposeError(f"TEMPLATE ERROR in {rel}: {e}") from e


def compose(selection, out, *, app_name="demo-app", team="demo-team", port=8080,
            semester="2026-fall", semester_display="Capstone Fall 2026"):
    """Replay a scaffold: parse the chosen fragments, plan, and render the repo tree into `out`.

    `selection` mirrors the wizard choices: projectType + layout + the slot fragment paths
    (single/frontend/backend/mobile, FRAGMENTS-relative) + database (a wizard DB choice).
    Returns a Composed carrying the plan, values, metas and the rendered output dir.
    """
    metas, srcdirs = {}, {}
    for slot in SLOTS:
        if selection.get(slot):
            metas[slot], srcdirs[slot] = load_meta(selection[slot])

    plan = run_planner({
        "projectType": selection["projectType"], "layout": selection.get("layout"),
        "fragments": metas, "database": selection.get("database", "none"), "port": port,
    })

    values = dict(
        appName=app_name, team=team, semester=semester,
        semesterDisplay=semester_display, port=port,
        description="A UA-MIS capstone project (compose_lib).",
        destination={"owner": "UA-MIS", "repo": app_name},
        components=plan["components"], database=plan["database"],
        dbWired=plan["dbWired"], single=plan["single"],
        # (progressive delivery is now an env-based chart default — prod overlay only — so no
        # `progressiveDelivery` value is needed here; no chart template references it. ADR-037.)
    )

    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # 1) the shared contract (rendered once).
    render_tree(CONTRACT, out, values)
    # 2) each fragment's skeleton/ -> its target dir.
    for c in plan["copies"]:
        slot = next(s for s, m in metas.items() if m["id"] == c["fragment"]["id"])
        render_tree(srcdirs[slot] / "skeleton", out / c["targetDir"], values)

    return Composed(out=out, plan=plan, values=values, metas=metas, srcdirs=srcdirs,
                    selection=selection)


def discover_fragments():
    """Every real, composable fragment, FRAGMENTS-relative (e.g. 'backend/fastapi'), sorted.

    Skips the shared _contract, the _tools dir, and any category/fragment dir whose name
    starts with '_' (e.g. mobile/_EXAMPLE — a contract stub, not a real starter).
    """
    found = []
    for meta_path in FRAGMENTS.rglob("fragment.yaml"):
        rel = meta_path.parent.relative_to(FRAGMENTS)
        parts = rel.parts
        if any(part.startswith("_") for part in parts):
            continue
        found.append(rel.as_posix())
    return sorted(found)


def scenario_for(meta, rel):
    """The simplest valid wizard selection that composes `meta` into a buildable repo.

    A fragment declares which slots it can fill; we pick the cheapest layout that exercises
    it, adding a proven default partner when the fragment cannot stand alone (a pure frontend
    needs a backend; a mobile app needs its API backend). DB-using stacks are composed with
    host-mysql so the DATABASE_URL-wired overlays are exercised too.
    """
    slots = meta.get("slots") or []
    needs_db = bool(meta.get("needsDB"))
    if "single" in slots:
        return dict(projectType="web", layout="single", single=rel,
                    database="host-mysql" if needs_db else "none")
    if "frontend" in slots:
        # A pure SPA only composes paired with a backend (it calls /api).
        return dict(projectType="web", layout="frontend-backend", frontend=rel,
                    backend=DEFAULT_BACKEND, database="host-mysql")
    if "mobile" in slots:
        # A mobile app composes alongside its API backend.
        return dict(projectType="mobile", mobile=rel, backend=DEFAULT_BACKEND,
                    database="host-mysql")
    if "backend" in slots:
        # A backend that cannot be a standalone `single` composes as the BE of a FE+BE app.
        return dict(projectType="web", layout="frontend-backend", backend=rel,
                    frontend=DEFAULT_FRONTEND, database="host-mysql" if needs_db else "none")
    raise ComposeError(
        f"fragment '{rel}' declares no composable slot (slots={slots})")


def expected_build_artifacts(composed):
    """The build file each composed component MUST ship, as (component_name, repo_rel_path).

    A container/static component builds from <context>/<dockerfile> (Kaniko in tenant CI);
    a mobile-artifact component builds via its <targetDir>/<buildWorkflow> instead. This is
    exactly what the tenant CI (build-and-push.yaml matrix) and the mobile workflow consume,
    so a missing file here == a red first CI run.
    """
    artifacts = []
    id_to_copy = {c["fragment"]["id"]: c for c in composed.plan["copies"]}
    id_to_meta = {m["id"]: m for m in composed.metas.values()}
    for comp in composed.plan["components"]:
        # Find the source fragment for this component via its copy target (context == targetDir).
        copy = next((c for c in composed.plan["copies"]
                     if c["targetDir"] == comp["context"]), None)
        if copy is None:
            # No skeleton copied for this component (should not happen) — nothing to assert.
            continue
        meta = id_to_meta.get(copy["fragment"]["id"], {})
        target = copy["targetDir"]
        if comp["buildType"] == "mobile-artifact":
            workflow = meta.get("buildWorkflow")
            if not workflow:
                raise ComposeError(
                    f"mobile fragment '{copy['fragment']['id']}' has no buildWorkflow")
            artifacts.append((comp["name"], f"{target}/{workflow}"))
        else:
            dockerfile = comp.get("dockerfile") or meta.get("dockerfile") or "Dockerfile"
            artifacts.append((comp["name"], f"{target}/{dockerfile}"))
    return artifacts


# The ONLY directory GitHub Actions discovers and runs workflows from, at the repo root
# (GitHub platform behavior, not a platform-infra convention — see NO_TEMPLATE above, which
# already treats .github/** as shipped-verbatim for this reason).
GITHUB_WORKFLOWS_DIR = ".github/workflows/"


def mobile_workflow_reachability(composed):
    """For every mobile-artifact component, whether its buildWorkflow file lands where
    GitHub Actions actually executes it (F-3/D-058).

    expected_build_artifacts() above only proves the buildWorkflow file EXISTS on disk at
    <targetDir>/<buildWorkflow> — that was the gate's full check before D-058, and it is NOT
    sufficient: a mobile fragment declaring `buildWorkflow: .mobile-ci/build.yaml` composes
    to `mobile/.mobile-ci/build.yaml`, which exists, satisfies (a), and is NEVER discovered
    or run by GitHub Actions, because it is not under GITHUB_WORKFLOWS_DIR at the repo root.
    That produced a false green: CI stayed green, the backend deployed, and no .apk/.ipa was
    ever built — silently, for every mobile fragment.

    The check requires the file to land DIRECTLY under GITHUB_WORKFLOWS_DIR, not merely
    prefixed by it (MOB-003, review-fix5-mobile-hide.md): GitHub Actions does not discover
    workflows in subdirectories either, so `.github/workflows/ios/build.yaml` would pass a
    naive startswith() check while still never running.

    Returns [(component_name, repo_rel_path, reachable_bool), ...], one entry per
    mobile-artifact component (container/static components build via Kaniko from a
    Dockerfile, not a GH Actions workflow file, so they are out of scope here).
    """
    results = []
    comp_by_name = {c["name"]: c for c in composed.plan["components"]}
    for comp_name, rel_path in expected_build_artifacts(composed):
        comp = comp_by_name.get(comp_name, {})
        if comp.get("buildType") != "mobile-artifact":
            continue
        remainder = rel_path[len(GITHUB_WORKFLOWS_DIR):] if rel_path.startswith(GITHUB_WORKFLOWS_DIR) else None
        reachable = remainder is not None and "/" not in remainder
        results.append((comp_name, rel_path, reachable))
    return results


def kustomize_tool():
    """Return an argv PREFIX for a kustomize build, or None if neither tool is installed."""
    kz = shutil.which("kustomize")
    if kz:
        return [kz, "build"]
    kubectl = shutil.which("kubectl")
    if kubectl:
        return [kubectl, "kustomize"]
    return None


OVERLAYS = ("dev", "staging", "prod", "preview")


def kustomize_overlays(out, tool=None):
    """Build all four overlays of a composed repo. Returns [(env, ok, err), ...].

    Raises ComposeError if no kustomize/kubectl is available (the caller decides whether that
    is fatal — CI must have it; a laptop dry-render may skip).
    """
    prefix = tool or kustomize_tool()
    if prefix is None:
        raise ComposeError("kustomize/kubectl not found")
    out = Path(out)
    results = []
    for env in OVERLAYS:
        cmd = prefix + [str(out / ".devops/chart/overlays" / env)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        results.append((env, r.returncode == 0, r.stderr.strip()))
    return results
