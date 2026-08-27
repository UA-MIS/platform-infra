#!/usr/bin/env python3
"""Every ArgoCD Application's repoURL must be permitted by its AppProject's sourceRepos.

WHY THIS GUARD EXISTS. `crimson-copies-stripped-vm-prod` sat Unknown/Unknown in ArgoCD
because its Application sources from platform-infra while its AppProject permits only the
team repo:

    InvalidSpecError — application repo https://github.com/UA-MIS/platform-infra
    is not permitted in project 'crimson-copies-stripped-vm'

Nothing noticed, and the reason it went unnoticed is the point: the app had ALREADY synced
once before the restriction started biting, so `lastOp` still reads "Succeeded —
successfully synced (all tasks run)" and the VM is genuinely up. The failure is not that
something broke; it is that ArgoCD can no longer RECONCILE it. Future changes will not
deploy and drift will not be corrected, silently, in the direction of doing nothing.

This is SEC-006 one relation over. Guard [4/8] already checks that a policy naming a
project refers to an AppProject that EXISTS; this checks that an Application naming a
project is actually ALLOWED to source what it sources. Same shape, adjacent edge, and
until now unguarded.

THREE OUTCOMES, NOT TWO. "Application is fine", "Application names a project that does not
exist", and "Application names a real project that FORBIDS its repo" are three different
facts needing three different messages, and only the first is a pass. Collapsing the last
two loses the diagnosis — which is exactly what makes this class hard to find by hand.

FAILS CLOSED. Unreadable or unparseable YAML is an ERROR, never a skip: a guard that
cannot read its subject must not report that the subject is clean. Coverage is asserted
PER REQUIRED DIRECTORY rather than as a repo-wide non-zero total, because Applications and
AppProjects live in several places and a repo-wide count stays healthy while one directory
silently empties.
"""
from __future__ import annotations

import fnmatch
import pathlib
import sys

try:
    import yaml
except ImportError:
    print("FAIL: PyYAML is required for this guard (pip install pyyaml).")
    sys.exit(1)

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

# Directories that must each yield at least one Argo resource. Named, not discovered:
# a discovered list cannot tell "this directory is legitimately empty" from "this
# directory disappeared", and the second must fail.
REQUIRED_DIRS = {
    "tenants": ("Application", "AppProject", "ApplicationSet"),
    "applicationsets": ("ApplicationSet", "Application"),
    "bootstrap": ("Application", "AppProject", "ApplicationSet"),
}

# NOT-A-MANIFEST, skipped deliberately and COUNTED, so "we skipped 40 files" can never
# masquerade as "we checked 40 files":
#   - scaffolder templates: nunjucks source with `${{ values.x }}`, only YAML once rendered
#   - artifacts/: design notes and evidence records, never applied to a cluster
SKIP_PREFIXES = ("platform-services/backstage/templates", "artifacts/")


def looks_like_go_template(text: str) -> bool:
    """Helm chart templates under */chart/templates/ are GO TEMPLATE SOURCE, not YAML —
    `{{- if .Values.x }}` is not parseable and never will be. They are excluded only when
    they genuinely carry template syntax, NOT by directory alone: a real manifest that
    fails to parse must still be a hard error, or this exclusion becomes the hole. A Helm
    template that renders an Application is covered where it matters — by the AppProject
    the rendered Application lands in — and cannot be resolved statically here."""
    markers = ("{{-", "{{ include", "{{ .Values", ".Values.", "{{- if", "{{ if")
    return "{{" in text and any(m in text for m in markers)


def is_templated(value: str) -> bool:
    """ArgoCD ApplicationSet templates and scaffolder files carry placeholders that cannot
    be resolved statically. Reported as UNRESOLVED, never silently treated as fine."""
    return any(tok in value for tok in ("{{", "${{", "{%"))


def repo_permitted(repo: str, source_repos: list[str]) -> tuple[bool, str]:
    """ArgoCD semantics: glob match against each entry; a bare '*' permits everything;
    a leading '!' is a negation that wins. Returns (permitted, why)."""
    allowed = False
    why = "no sourceRepos entry matches"
    for entry in source_repos:
        neg = entry.startswith("!")
        pat = entry[1:] if neg else entry
        if pat == repo or fnmatch.fnmatch(repo, pat):
            allowed = not neg
            why = f"{'denied by negation' if neg else 'matched'} {entry!r}"
    return allowed, why


def strip_git(url: str) -> str:
    """Remove ONE trailing '.git', as a suffix.

    Not `rstrip('.git')` — that strips any trailing run of the CHARACTERS '.', 'g', 'i',
    't', so `.../my-repo-digit` would become `.../my-repo-d`. It happened to give the
    right answer for the repo that prompted this guard, which is exactly the kind of
    accident that survives review."""
    return url[:-4] if url.endswith(".git") else url


def near_miss(repo: str, source_repos: list[str]) -> str | None:
    """The `.git`-suffix convention bites here: a project listing only `<repo>.git` while
    the Application uses the bare form (or vice versa) is a different mistake from 'the
    repo is not permitted at all', and deserves to be named as such."""
    for entry in source_repos:
        e = entry.lstrip("!")
        if strip_git(e) == strip_git(repo) and e != repo:
            return e
    return None


class GoTemplate(Exception):
    """Not YAML and never will be — Helm template source."""


def load_docs(path: pathlib.Path):
    """Multi-document YAML. A parse error is FATAL, not a skip — the one exception being
    Go-template source, which is identified by its syntax rather than by its location."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise RuntimeError(f"could not READ {path}: {e}") from e
    try:
        return [d for d in yaml.safe_load_all(text) if isinstance(d, dict)]
    except yaml.YAMLError as e:
        if looks_like_go_template(text):
            raise GoTemplate() from e
        raise RuntimeError(f"could not PARSE {path}: {e}") from e


def sources_of(spec: dict) -> list[str]:
    """ArgoCD accepts `source:` (single) or `sources:` (multi). Both must be checked."""
    out = []
    src = spec.get("source")
    if isinstance(src, dict) and src.get("repoURL"):
        out.append(str(src["repoURL"]))
    for s in spec.get("sources") or []:
        if isinstance(s, dict) and s.get("repoURL"):
            out.append(str(s["repoURL"]))
    return out


def main() -> int:
    read_errors: list[str] = []
    projects: dict[str, dict] = {}      # name -> {sourceRepos, path}
    apps: list[dict] = []
    dir_hits: dict[str, int] = {d: 0 for d in REQUIRED_DIRS}
    skipped_templates = 0
    skipped_helm = 0

    for path in sorted(ROOT.rglob("*.y*ml")):
        rel = path.relative_to(ROOT).as_posix()
        if "node_modules" in rel or "/.git/" in f"/{rel}":
            continue
        if rel.startswith(SKIP_PREFIXES):
            skipped_templates += 1
            continue
        try:
            docs = load_docs(path)
        except GoTemplate:
            skipped_helm += 1
            continue
        except RuntimeError as e:
            read_errors.append(str(e))
            continue

        for doc in docs:
            kind = doc.get("kind")
            if kind not in ("Application", "AppProject", "ApplicationSet"):
                continue
            top = rel.split("/", 1)[0]
            if top in dir_hits and kind in REQUIRED_DIRS[top]:
                dir_hits[top] += 1

            meta = doc.get("metadata") or {}
            spec = doc.get("spec") or {}
            name = str(meta.get("name", "<unnamed>"))

            if kind == "AppProject":
                projects[name] = {
                    "sourceRepos": [str(r) for r in (spec.get("sourceRepos") or [])],
                    "path": rel,
                    "description": str(spec.get("description") or ""),
                }
            elif kind == "Application":
                apps.append({"name": name, "path": rel, "project": str(spec.get("project", "")),
                             "repos": sources_of(spec), "via": "Application"})
            else:  # ApplicationSet — check the Application it will generate
                tmpl = (spec.get("template") or {}).get("spec") or {}
                if tmpl:
                    apps.append({"name": f"{name} (template)", "path": rel,
                                 "project": str(tmpl.get("project", "")),
                                 "repos": sources_of(tmpl), "via": "ApplicationSet"})

    # ---- fail closed: could not read the subject -----------------------------
    if read_errors:
        print("FAIL: could not read or parse manifests — refusing to report a clean tree")
        print("      from a scan that did not complete:")
        for e in read_errors:
            print(f"       - {e}")
        return 1

    empty = [d for d, n in dir_hits.items() if (ROOT / d).is_dir() and n == 0]
    missing = [d for d in REQUIRED_DIRS if not (ROOT / d).is_dir()]
    if missing or empty:
        print("FAIL: guard input missing or empty:")
        for d in missing:
            print(f"       - {d}/ does not exist (moved? update REQUIRED_DIRS)")
        for d in empty:
            print(f"       - {d}/ exists but yielded ZERO Argo resources")
        print("      A per-directory count, not a repo-wide total: the total stays healthy")
        print("      while one directory silently empties.")
        return 1

    # ---- CRD FIELD-LENGTH LIMITS (offline half of the server-dry-run lesson) ----
    # `AppProject.spec.description` may not exceed 255 characters. That is a constraint in
    # the CRD's own openAPIV3Schema, and STRUCTURAL VALIDATION CANNOT SEE IT: a 337-char
    # description passed `make validate`, passed `kubectl apply --dry-run=client`, and was
    # then REJECTED by the API server on apply — after the PR had merged.
    # (kubeconform is doubly blind here: guard [1/8] only scans */namespaces/*.yaml, and
    # pointed at an AppProject it errors "could not find schema for AppProject" anyway.)
    #
    # The AUTHORITATIVE check is `make verify-argocd-apply` (--dry-run=server), which needs
    # a cluster and so cannot live in this offline gate. This is the cheap offline half:
    # it catches the one class that actually cost a merge, in CI, with no kubeconfig.
    #
    # The value is not a guess — it is every maxLength in the live CRDs, read with
    #   kubectl get crd appprojects.argoproj.io -o json
    # which yields exactly one: .spec.description = 255. The Application CRD has none.
    # If ArgoCD adds more, this list goes stale silently; the server dry-run is what
    # covers that, which is why both exist.
    MAX_LEN = {"AppProject.spec.description": 255}
    too_long = []
    for pname, p in projects.items():
        limit = MAX_LEN["AppProject.spec.description"]
        if len(p["description"]) > limit:
            too_long.append((pname, p["path"], len(p["description"]), limit))
    if too_long:
        print(f"FAIL: {len(too_long)} AppProject(s) exceed a CRD field-length limit.")
        print("      The API server REJECTS these on apply; structural validation cannot")
        print("      see CRD field constraints, so nothing else here catches them.")
        for pname, ppath, n, limit in too_long:
            print(f"    - {ppath} :: {pname}")
            print(f"      spec.description is {n} characters, limit is {limit}")
            print(f"      Move the reasoning into a YAML COMMENT above the field — comments")
            print(f"      have no length limit; only the field does.")
        return 1

    # ---- the three outcomes ---------------------------------------------------
    orphans, forbidden, unresolved, ok = [], [], [], 0
    for a in apps:
        if not a["project"] or is_templated(a["project"]):
            unresolved.append((a, "project is templated/absent"))
            continue
        if a["project"] not in projects:
            orphans.append(a)
            continue
        proj = projects[a["project"]]
        if not a["repos"]:
            unresolved.append((a, "no repoURL found"))
            continue
        for repo in a["repos"]:
            if is_templated(repo):
                unresolved.append((a, f"repoURL is templated: {repo}"))
                continue
            permitted, why = repo_permitted(repo, proj["sourceRepos"])
            if permitted:
                ok += 1
            else:
                forbidden.append((a, repo, proj, why, near_miss(repo, proj["sourceRepos"])))

    total = len(apps)
    print(f"  scanned {total} Application/ApplicationSet definition(s) against "
          f"{len(projects)} AppProject(s); skipped {skipped_templates} scaffolder-template "
          f"and {skipped_helm} Helm-template file(s)")
    for d, n in sorted(dir_hits.items()):
        print(f"    {d}/: {n} Argo resource(s)")

    if unresolved:
        print(f"  {len(unresolved)} source(s) NOT STATICALLY CHECKABLE (reported, not passed):")
        for a, why in unresolved:
            print(f"    ? {a['path']} :: {a['name']} — {why}")

    if orphans:
        print(f"FAIL: {len(orphans)} Application(s) name an AppProject that DOES NOT EXIST.")
        print("      ArgoCD cannot place these at all — distinct from a project that exists")
        print("      and forbids the repo (below).")
        for a in orphans:
            print(f"    - {a['path']} :: {a['name']}")
            print(f"      project {a['project']!r} not found in any AppProject in this repo")

    if forbidden:
        print(f"FAIL: {len(forbidden)} Application source(s) are FORBIDDEN by their AppProject.")
        print("      ArgoCD refuses to reconcile these with InvalidSpecError. If the app already")
        print("      synced once, it stays Healthy and the failure is invisible: the workload")
        print("      keeps running while every future change silently fails to deploy.")
        for a, repo, proj, why, nm in forbidden:
            print(f"    - {a['path']} :: {a['name']}")
            print(f"      repoURL : {repo}")
            print(f"      project : {a['project']}  ({proj['path']})")
            print(f"      permits : {proj['sourceRepos'] or '<none>'}  [{why}]")
            if nm:
                print(f"      NOTE: {nm!r} differs from the repoURL only by the '.git' suffix —")
                print(f"            this is a suffix-convention mismatch, not a missing grant.")

    if orphans or forbidden:
        print("      Fix ONE side deliberately: either add the repo to the AppProject's")
        print("      sourceRepos, or point the Application at a repo the project already")
        print("      permits. Check whether the project's sourceRepos list is a deliberate")
        print("      security fence before widening it.")
        return 1

    print(f"  OK — {ok} Application source(s) permitted by their AppProject; 0 orphaned, 0 forbidden")
    return 0


if __name__ == "__main__":
    sys.exit(main())
