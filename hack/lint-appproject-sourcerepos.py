#!/usr/bin/env python3
"""Every ArgoCD Application must be permitted by its AppProject — both its repoURL
(sourceRepos) and every KIND it deploys (namespaceResourceWhitelist).

CHECK WHAT YOU CHANGED, NOT ONLY WHAT YOU BUILT.
Read this before adding to this file. Both defects that produced this guard were the same
mistake, and it was not a missing check — it was a rigorous check pointed at the wrong
object:
  - #589 shipped an AppProject with a 337-character spec.description into a field with a
    documented 255-char limit. The guard was correct; the object was never checked.
  - #591 then shipped that same AppProject with a namespaceResourceWhitelist omitting
    SealedSecret — a kind sitting in the very directory the Application points at.
Both times the tooling was verified and the thing being added was not. The systemic answer
is `make verify-argocd-apply` and the kind check below; the habit is the sentence above.

WHY THE OFFLINE HALF IS TRACTABLE AT ALL. It is tempting to assume `kubeconform -strict`
already covers AppProjects. It does not, for two separate reasons, and the distinction
matters:
  1. kubeconform CANNOT LOAD A SCHEMA for AppProject — pointed at one directly it errors
     "could not find schema for AppProject". It is a CRD; kubeconform ships Kubernetes
     API schemas.
  2. validate [1/8] only scans */namespaces/*.yaml, so IT NEVER LOOKED AT THE FILE. The
     gate was not blind to the constraint; it was not looking.
That is why a small number of exact, CRD-derived assertions here is worth having, rather
than assuming a general-purpose validator has it covered.

--- the repo check (original purpose) ---------------------------------------------

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

--- the kind check ------------------------------------------------------------------
Every kind an Application deploys must appear in its AppProject's whitelist. A missing
kind fails at SYNC time, not at admission:

    SyncFailed — resource bitnami.com:SealedSecret is not permitted
                 in project crimson-copies-stripped-vm-platform

and it fails PARTIALLY: the other three resources in that directory synced fine, so the
Application sits part-applied and Healthy-looking.

`make verify-argocd-apply` DOES NOT CATCH THIS — verified, not assumed: run against a
whitelist missing SealedSecret it reports "51 checked, 0 rejected". An AppProject whose
whitelist omits a kind is a perfectly VALID AppProject, so the API server has no opinion;
the is-this-kind-permitted decision belongs to ArgoCD's application controller at sync
time. (And that target only dry-runs Application/AppProject manifests, never the workload
manifests an Application points at.) Server-side dry-run and this check cover different
failures; neither replaces the other.

DERIVE THE WHITELIST, DO NOT GROW IT ONE REJECTION AT A TIME. Reconcile it against the
source directory in BOTH directions — nothing needed missing, nothing unneeded present.
A whitelist assembled by fixing rejections one at a time costs a live reconcile cycle per
missing kind, and accumulates grants nobody audits.
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
    return [r for r, _ in source_pairs(spec)]


def source_pairs(spec: dict) -> list[tuple[str, str]]:
    """(repoURL, path) for every source. The path is what lets the kind check below
    enumerate the manifests an Application actually deploys."""
    out = []
    for s in ([spec.get("source")] if isinstance(spec.get("source"), dict) else []) + list(
        spec.get("sources") or []
    ):
        if isinstance(s, dict) and s.get("repoURL"):
            out.append((str(s["repoURL"]), str(s.get("path") or "")))
    return out


# This repo's own URL, in both spellings. Only Applications sourcing THIS repo can have
# their manifests enumerated offline; anything pointing at a Helm chart repo or another
# GitHub repo is reported UNRESOLVED, never passed.
SELF_REPOS = {
    "https://github.com/UA-MIS/platform-infra",
    "https://github.com/UA-MIS/platform-infra.git",
}


def kinds_in_path(
    root: pathlib.Path, rel_path: str
) -> tuple[set[tuple[str, str]], list[str], list[str]]:
    """Every (group, kind) declared under an in-repo source path.

    Returns (kinds, unknowable, errors) — THREE outcomes, deliberately, because two would
    collapse the distinction that matters:
      - unknowable: Helm chart source (`{{- if .Values.x }}`). The kinds are real but only
        exist after rendering. Reported, never silently passed, never a hard failure — a
        guard that fails on every Helm-sourced Application gets deleted by the first
        person it blocks.
      - errors: a manifest that genuinely will not parse. FATAL, so a directory we cannot
        fully read never yields a clean bill of health.
    """
    kinds: set[tuple[str, str]] = set()
    unknowable: list[str] = []
    errors: list[str] = []
    base = (root / rel_path).resolve()
    if not base.is_dir():
        return kinds, unknowable, [f"source path {rel_path!r} is not a directory in this repo"]
    for f in sorted(base.rglob("*.y*ml")):
        try:
            docs = load_docs(f)
        except GoTemplate:
            unknowable.append(str(f.relative_to(root)))
            continue
        except RuntimeError as e:
            errors.append(str(e))
            continue
        for doc in docs:
            kind = doc.get("kind")
            if not kind:
                continue
            api = str(doc.get("apiVersion", ""))
            group = api.split("/")[0] if "/" in api else ""
            kinds.add((group, str(kind)))
    return kinds, unknowable, errors


def kind_permitted(group: str, kind: str, whitelist: list[dict]) -> bool:
    """ArgoCD matches group and kind with `*` wildcards. An EMPTY/absent
    namespaceResourceWhitelist means ALLOW-ALL in ArgoCD (unlike clusterResourceWhitelist,
    where empty means deny-all) — the caller handles that asymmetry, not this function."""
    for e in whitelist:
        if not isinstance(e, dict):
            continue
        g, k = str(e.get("group", "")), str(e.get("kind", ""))
        if (g == "*" or g == group) and (k == "*" or k == kind):
            return True
    return False


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
                    "nsWhitelist": spec.get("namespaceResourceWhitelist") or [],
                    "clusterWhitelist": spec.get("clusterResourceWhitelist") or [],
                }
            elif kind == "Application":
                apps.append({"name": name, "path": rel, "project": str(spec.get("project", "")),
                             "repos": sources_of(spec), "pairs": source_pairs(spec),
                             "via": "Application"})
            else:  # ApplicationSet — check the Application it will generate
                tmpl = (spec.get("template") or {}).get("spec") or {}
                if tmpl:
                    apps.append({"name": f"{name} (template)", "path": rel,
                                 "project": str(tmpl.get("project", "")),
                                 "repos": sources_of(tmpl), "pairs": source_pairs(tmpl),
                                 "via": "ApplicationSet"})

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

    # ---- KIND check: every kind an Application deploys must be whitelisted ---------
    # The direct sibling of the repo check above, one field over. A missing KIND fails at
    # SYNC time, not at admission:
    #     SyncFailed — resource bitnami.com:SealedSecret is not permitted
    #                  in project crimson-copies-stripped-vm-platform
    # `make verify-argocd-apply` does NOT catch it, and that was verified rather than
    # assumed: run against a whitelist missing SealedSecret it reports "51 checked, 0
    # rejected". Two independent reasons — an AppProject whose whitelist omits a kind is a
    # perfectly VALID AppProject, so the API server has no opinion; and the
    # is-this-kind-permitted decision belongs to ArgoCD's application controller at sync
    # time. (A third: that target only dry-runs Application/AppProject manifests, never the
    # workload manifests the Application points at.)
    bad_kinds: list[tuple] = []
    kind_errors: list[str] = []
    kinds_checked = 0
    for a in apps:
        if a["project"] not in projects:
            continue
        proj = projects[a["project"]]
        for repo, spath in a.get("pairs", []):
            if is_templated(repo) or is_templated(spath) or not spath:
                continue
            if repo not in SELF_REPOS:
                # Another repo or a Helm chart repo — not enumerable offline. Reported so
                # it cannot be mistaken for "checked and clean".
                unresolved.append((a, f"source {repo} is not this repo; kinds not checkable offline"))
                continue
            found, unknowable, errs = kinds_in_path(ROOT, spath)
            kind_errors.extend(errs)
            if unknowable:
                unresolved.append((a, f"{len(unknowable)} Helm-template file(s) under {spath}/ — kinds only exist after rendering"))
            ns_wl, cl_wl = proj["nsWhitelist"], proj["clusterWhitelist"]
            for group, kind in sorted(found):
                kinds_checked += 1
                # ArgoCD asymmetry: an EMPTY namespaceResourceWhitelist means ALLOW-ALL
                # namespaced kinds, whereas an empty clusterResourceWhitelist means
                # DENY-ALL cluster kinds. So an empty ns list is not a finding.
                if not ns_wl and not cl_wl:
                    continue
                if ns_wl and kind_permitted(group, kind, ns_wl):
                    continue
                if cl_wl and kind_permitted(group, kind, cl_wl):
                    continue
                if not ns_wl:
                    continue  # permissive namespaced default; nothing to assert
                bad_kinds.append((a, group, kind, spath, proj))

    if kind_errors:
        print("FAIL: could not enumerate the kinds an Application deploys —")
        print("      refusing to report a clean tree from a scan that did not complete:")
        for e in kind_errors:
            print(f"       - {e}")
        return 1

    if bad_kinds:
        print(f"FAIL: {len(bad_kinds)} kind(s) deployed by an Application are NOT permitted")
        print("      by its AppProject. ArgoCD fails these at SYNC time with")
        print("      'resource <group>:<kind> is not permitted in project <name>'. The other")
        print("      resources in the same directory sync fine, so the app sits part-applied.")
        for a, group, kind, spath, proj in bad_kinds:
            print(f"    - {a['path']} :: {a['name']}")
            print(f"      deploys : {group or '(core)'}:{kind}   (from {spath}/)")
            print(f"      project : {a['project']}  ({proj['path']})")
            print(f"      Add it to namespaceResourceWhitelist, or stop deploying it. Derive")
            print(f"      the whole list from the source directory rather than adding one")
            print(f"      entry per rejection — that is how you get four more of these.")
        return 1

    total = len(apps)
    print(f"  checked {kinds_checked} deployed kind(s) against their AppProject whitelist")
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
