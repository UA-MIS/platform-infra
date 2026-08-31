#!/usr/bin/env python3
"""Offline lint: every project token in an ArgoCD `p, role:...` policy must name a
real AppProject (SEC-006). This is `make validate` guard [4/6].

WHY THIS IS A SCRIPT AND NOT A `sed` PIPELINE
---------------------------------------------
It used to be one, and the pipeline was wrong in a way that mattered: it matched
only the `<project>/<app>` object form with a `[a-z0-9-]+` project token, then
threw away anything that did not match by grepping out lines that still contained
commas. Every input it could not parse therefore vanished SILENTLY and the guard
reported success. Three real shapes disappeared that way:

  p, role:x, applications, get, ghost_team/*, allow   <- underscore in the slug
  p, role:x, applications, get, GhostTeam/*, allow    <- uppercase in the slug
  p, role:x, projects,     get, ghostproj,    allow   <- BARE-project object form

The third is not hypothetical: `p, role:sample, projects, get, sample, allow` was
one of the four lines this guard was created to catch, and it had never once been
checked by it.

That is the SEC-006 defect wearing the guard's own uniform. A policy naming a
project that does not exist is silently inert — the students it was meant to
authorise cannot deploy and nothing emits an error — and a guard that cannot
parse the policy reports the same green as one that checked it.

So: parse every `p,` line explicitly, and make anything unparseable LOUD.

THE RULE THIS ENFORCES
----------------------
An ArgoCD casbin policy line is exactly six comma-separated fields:

    p, <subject>, <resource>, <action>, <object>, <effect>

`<object>` is either `<project>/<app>` or a bare `<project>` (the form the
`projects` resource uses). The leading token is a project reference unless it is
`*`. Every project reference must resolve to an AppProject that exists in this
repo, or the policy is inert.

"COULD NOT PARSE" IS NOT "NOT PRESENT"
-------------------------------------
These are different facts and only one of them is benign, so they are reported
separately and only one of them exits 0. Emptiness-based detection ("if we parsed
nothing, complain") is NOT sufficient: it goes quiet the moment a single line
parses, which is exactly what happens when a cohort-baseline policy naming
`platform/*` sits next to a malformed one. The check is therefore PER LINE.
"""
import glob
import os
import re
import sys

REPO = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else
                       os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

RBAC = os.path.join(REPO, "platform-services", "argocd-config", "argocd-rbac-cm.yaml")

# Where AppProjects are declared IN THIS REPO. Note this is deliberately the same
# set the shell guard used, so the accept-set does not silently widen. Tenant VM
# AppProjects (tenants/*/vm/appproject-vm.yaml) are NOT included — that gap is
# pre-existing and recorded as KVT-6 in the KubeVirt security review; widening
# the accept-set is a separate, deliberate decision.
APPPROJECT_SOURCES = [
    os.path.join(REPO, "bootstrap", "platform-appproject.yaml"),
    os.path.join(REPO, "tenants", "*", "appproject.yaml"),
]

VALID_EFFECTS = {"allow", "deny"}
DOC_SPLIT = re.compile(r"^---\s*$", re.M)
KIND_APPPROJECT = re.compile(r"^kind:\s*AppProject\s*$", re.M)
METADATA_NAME = re.compile(r"^metadata:\s*$.*?^\s+name:\s*[\"']?([A-Za-z0-9_.-]+)",
                           re.M | re.S)


def die(*lines):
    for ln in lines:
        print(ln)
    sys.exit(1)


def known_appprojects():
    """Every AppProject name declared in this repo.

    An empty result is a FAILURE, not an empty accept-set: if the sources moved or
    were deleted, every reference would 'correctly' fail to resolve and the error
    would point at the policy instead of at the missing file. Fail on the real
    cause.
    """
    files = []
    for pattern in APPPROJECT_SOURCES:
        files.extend(sorted(glob.glob(pattern)))
    if not files:
        die("FAIL: found no AppProject source files under this repo.",
            "      Expected at least one of:",
            *[f"        {os.path.relpath(p, REPO)}" for p in APPPROJECT_SOURCES],
            "      Guard [4/6] cannot build its list of real AppProjects, so it cannot",
            "      resolve anything. An unknown accept-set is NOT a pass (SEC-006).")

    names = {}
    for path in files:
        try:
            text = open(path, encoding="utf-8").read()
        except OSError as e:
            die(f"FAIL: cannot read AppProject source {os.path.relpath(path, REPO)}: {e}")
        for doc in DOC_SPLIT.split(text):
            if not KIND_APPPROJECT.search(doc):
                continue
            m = METADATA_NAME.search(doc)
            if m:
                names[m.group(1)] = os.path.relpath(path, REPO)

    if not names:
        die("FAIL: parsed AppProject source files but found no AppProject names in them:",
            *[f"        {os.path.relpath(p, REPO)}" for p in files],
            "      Guard [4/6] would then reject every policy for the wrong reason.",
            "      An empty accept-set is NOT a pass (SEC-006).")
    return names


def policy_lines(text):
    """Yield (lineno, raw) for each casbin `p,` policy line."""
    for i, raw in enumerate(text.splitlines(), 1):
        s = raw.strip()
        if s.startswith("#") or not s:
            continue
        if s.startswith("p,") or re.match(r"^p\s*,", s):
            yield i, raw


def main():
    if not os.path.isfile(RBAC):
        die(f"FAIL: {os.path.relpath(RBAC, REPO)} is missing.",
            "      Guard [4/6] cannot read its own subject. A guard that cannot find",
            "      the file it checks has NOT checked it — that is a failure, not a",
            "      pass (SEC-006). If the file moved, update APPPROJECT/RBAC paths in",
            "      hack/lint-argocd-rbac-projects.py.")
    try:
        text = open(RBAC, encoding="utf-8").read()
    except OSError as e:
        die(f"FAIL: cannot read {os.path.relpath(RBAC, REPO)}: {e}",
            "      An unreadable subject is not a pass (SEC-006).")

    projects = known_appprojects()
    lines = list(policy_lines(text))

    # --- the legitimately vacuous case, reported as vacuous and nothing else ----
    if not lines:
        print("  OK (vacuous) — argocd-rbac-cm.yaml declares no 'p, role:' policy lines,")
        print("                 so this guard had nothing to resolve. Per-project roles")
        print("                 live in each tenant's own AppProject, rendered by the")
        print("                 Crossplane composition, and are linted separately.")
        print("                 Reported as VACUOUS, not as a clean pass: an empty check")
        print("                 list is not evidence of correctness (SEC-006).")
        print(f"                 Known AppProjects: {', '.join(sorted(projects))}")
        return 0

    unparseable, inert, refs, wildcards = [], [], set(), 0

    for lineno, raw in lines:
        fields = [f.strip() for f in raw.strip().split(",")]
        if len(fields) != 6:
            unparseable.append((lineno, raw,
                                f"expected 6 comma-separated fields, got {len(fields)}"))
            continue
        _, subject, resource, action, obj, effect = fields
        if effect not in VALID_EFFECTS:
            unparseable.append((lineno, raw,
                                f"effect must be allow|deny, got {effect!r}"))
            continue
        if not obj:
            unparseable.append((lineno, raw, "empty object field"))
            continue
        token = obj.split("/", 1)[0]
        if token == "*":
            wildcards += 1
            continue
        refs.add(token)
        if token not in projects:
            inert.append((lineno, token, raw))

    if unparseable:
        print("FAIL: argocd-rbac-cm.yaml has 'p,' policy line(s) this guard could not parse.")
        print("An unparseable policy is NOT an absent one. Reporting these as 'no policy")
        print("found' is how a silently-inert grant (SEC-006) slips through the guard that")
        print("exists to catch it, so they are a hard failure instead.\n")
        for lineno, raw, why in unparseable:
            print(f"  argocd-rbac-cm.yaml:{lineno}: {raw.strip()}")
            print(f"      -> {why}")
        return 1

    if inert:
        print("FAIL: argocd-rbac policy references a project with no matching AppProject")
        print("      (inert role, SEC-006). ArgoCD accepts this silently and enforces")
        print("      nothing: the users it was meant to authorise simply cannot deploy.\n")
        for lineno, token, raw in inert:
            print(f"FAIL: argocd-rbac policy references project '{token}' with no "
                  f"matching AppProject (inert role, SEC-006)")
            print(f"      argocd-rbac-cm.yaml:{lineno}: {raw.strip()}")
        print(f"\n  known AppProjects: {' '.join(sorted(projects))}")
        return 1

    # --- success, stated in terms of what was actually examined ----------------
    if refs:
        print(f"  OK — {len(lines)} policy line(s) parsed; project reference(s) "
              f"({', '.join(sorted(refs))}) all resolve to AppProjects"
              + (f"; {wildcards} wildcard-scoped line(s) carry no project token"
                 if wildcards else ""))
    else:
        print(f"  OK (nothing to resolve) — {len(lines)} policy line(s) parsed, all "
              f"{wildcards} of them wildcard-scoped (`*`),")
        print("                 so none names a project. Parsed and checked, but no")
        print("                 project reference existed to verify (SEC-006).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
