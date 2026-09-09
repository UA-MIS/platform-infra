#!/usr/bin/env python3
"""Replay portal-tests.yaml's `paths:` filter over real history.

A paths filter that never matches is indistinguishable from a check that passes:
ci-scripts-sync-check sat at ZERO runs for ten days because its filter never matched a
commit, and nobody noticed because "no runs" and "all runs green" look the same on a
branch page. So this filter is verified by replay, not by reading.

It also reports, separately, how many of those commits the EXISTING
backstage-process-build-push.yaml filter would have skipped because of its
`!**/*.test.ts` exclusion -- i.e. the commits that changed portal tests and started no
workflow at all.

Usage: hack/check-portal-test-paths.py <repo-root> [since-rev]
"""
import fnmatch, subprocess, sys, pathlib, re, yaml

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
SINCE = sys.argv[2] if len(sys.argv) > 2 else "origin/main~200"

wf = yaml.safe_load(
    re.sub(r"\$\{\{[^}]*\}\}", "X", (ROOT / ".github/workflows/portal-tests.yaml").read_text())
)
NEW = wf[True]["push"]["paths"]

# The existing build workflow's filter, for contrast.
OLD = [
    "platform-services/backstage/app/**",
    "!platform-services/backstage/app/**/*.test.ts",
    "!platform-services/backstage/app/**/*.md",
]


def matches(pats, files):
    """GitHub semantics: positive patterns include, !patterns exclude, last match wins."""
    hits = []
    for f in files:
        inc = False
        for p in pats:
            neg = p.startswith("!")
            pat = p[1:] if neg else p
            ok = fnmatch.fnmatch(f, pat) or (pat.endswith("/**") and f.startswith(pat[:-2]))
            if ok:
                inc = not neg
        if inc:
            hits.append(f)
    return hits


def git(*a):
    return subprocess.run(["git", "-C", str(ROOT), *a], capture_output=True, text=True).stdout


shas = git("log", "--format=%h", f"{SINCE}..origin/main").split()
print(f"replaying {len(shas)} commits on main\n")
print(f"  {'commit':9} {'new':>4} {'build-wf':>8}  subject")

fired_new = fired_old = only_new = 0
for s in shas:
    files = [f for f in git("show", "--format=", "--name-only", s).splitlines() if f]
    n, o = len(matches(NEW, files)), len(matches(OLD, files))
    if not n and not o:
        continue
    fired_new += bool(n)
    fired_old += bool(o)
    tag = ""
    if n and not o:
        only_new += 1
        tag = "   <-- portal change that started NO workflow before"
    print(f"  {s:9} {n:>4} {o:>8}  {git('log','-1','--format=%s',s).strip()[:52]}{tag}")

print(f"\n  commits this filter would trigger on: {fired_new}")
print(f"  commits the existing build workflow triggers on: {fired_old}")
print(f"  portal commits that previously started nothing: {only_new}")

if fired_new == 0:
    print(
        "::error::this paths filter would not have matched a single real commit. "
        "That is how ci-scripts-sync-check sat at zero runs -- fix the filter."
    )
    sys.exit(1)
print("OK: the filter matches real history.")
