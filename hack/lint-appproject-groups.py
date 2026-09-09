#!/usr/bin/env python3
"""Offline lint: every AppProject role `groups:` entry must be `UA-MIS:<slug>`.

SEC-006 (June) and SEC-021 (August) are the same defect in two places: an ArgoCD
role bound to a group string no identity provider ever emits. It never raises an
error — the role is simply inert and users fall through to `policy.default` — so
only a lint catches it. This is the lint SEC-006 asked for and never got.

Dex's GitHub connector (`teamNameField: slug`, `orgs:` set) emits ONLY
`<org>:<team-slug>`, e.g. `UA-MIS:ida-llm`. Anything else is dead on arrival.

Scans both blueprint paths and the Crossplane generator. The generator's group
line is a go-template expression, so this is a deliberate line-based scan rather
than a YAML parse — `composition.yaml`'s tenant body is a template, not YAML,
and a YAML parser cannot see inside it.

SCOPE: only ArgoCD AppProject role `groups:` lists. The Kubernetes RoleBinding
subjects that carry the same `<team>-developers` string are a DIFFERENT identity
plane (kube-apiserver OIDC, which is not configured at all) and a different
finding, SEC-023 — deliberately not touched here.
"""
import pathlib
import re
import sys

REPO = pathlib.Path(
    sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent.parent
).resolve()
TARGETS = [
    REPO / "tenants",
    REPO / "platform-services" / "crossplane" / "apis" / "composition.yaml",
]
REQUIRED_PREFIX = "UA-MIS:"

# A lint that scanned nothing must never report PASS. Every tenant AppProject
# generator carries a role `groups:` list, so a zero count means the scan missed
# the tree (wrong root, moved file, renamed key) rather than "all clear" — the
# same "an empty check list is not a pass" failure this lint exists to prevent.
MIN_EXPECTED_GROUPS = 3

GROUPS_KEY = re.compile(r"^(\s*)groups:\s*$")
LIST_ITEM = re.compile(r"^(\s*)-\s*(.+?)\s*$")
# Strip go-template wrappers/quotes so `{{ printf "UA-MIS:%s" $team | quote }}`
# and `UA-MIS:__TEAM__` and `"UA-MIS:foo"` all reduce to something we can test.
TEMPLATE = re.compile(r"\{\{-?\s*(.*?)\s*-?\}\}")


def normalize(value: str) -> str:
    m = TEMPLATE.search(value)
    if m:
        value = m.group(1)
    # printf "FMT" args  ->  FMT
    pm = re.search(r'printf\s+"([^"]*)"', value)
    if pm:
        value = pm.group(1)
    return value.strip().strip('"').strip("'")


def yaml_files():
    for t in TARGETS:
        if t.is_file():
            yield t
        elif t.is_dir():
            yield from sorted(t.rglob("*.yaml"))


def scan(path):
    """Yield (lineno, raw, normalized) for each group entry in the file."""
    lines = path.read_text().splitlines()
    i = 0
    while i < len(lines):
        m = GROUPS_KEY.match(lines[i])
        if not m:
            i += 1
            continue
        key_indent = len(m.group(1))
        i += 1
        while i < len(lines):
            line = lines[i]
            if not line.strip() or line.lstrip().startswith("#"):
                i += 1
                continue
            item = LIST_ITEM.match(line)
            if not item or len(item.group(1)) <= key_indent:
                break  # dedent or non-list => end of this groups: block
            yield i + 1, item.group(2), normalize(item.group(2))
            i += 1


def main():
    failures = []
    checked = 0
    for path in yaml_files():
        for lineno, raw, value in scan(path):
            checked += 1
            rel = path.relative_to(REPO)
            if not value.startswith(REQUIRED_PREFIX):
                failures.append(
                    f"{rel}:{lineno}: {raw}\n"
                    f"    -> resolves to {value!r}, which Dex never emits.\n"
                    f"    AppProject role groups must be '{REQUIRED_PREFIX}<team-slug>'."
                )

    if failures:
        print("FAIL: inert AppProject role group(s) — SEC-021/SEC-006 regression.")
        print("Dex emits 'UA-MIS:<team-slug>' and nothing else. A role bound to any")
        print("other string matches no one: students silently fall through to")
        print("`policy.default` and cannot sync even their own application.\n")
        for f in failures:
            print(f)
        return 1

    if checked < MIN_EXPECTED_GROUPS:
        print(
            f"FAIL: scanned only {checked} AppProject role group(s) under {REPO} —\n"
            f"expected at least {MIN_EXPECTED_GROUPS}. The lint did not see the tree it\n"
            f"is meant to check, so this is NOT a pass. Check the repo root and that\n"
            f"the tenant AppProject generators still use a `groups:` key."
        )
        return 1

    print(f"  OK — {checked} AppProject role group(s), all '{REQUIRED_PREFIX}<slug>'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
