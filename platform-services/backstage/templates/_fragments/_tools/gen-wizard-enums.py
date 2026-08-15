#!/usr/bin/env python3
"""gen-wizard-enums.py — print the wizard fragment enums from the fragment library.

The fan-out story: a fragment-builder drops a new <category>/<id>/fragment.yaml, runs this,
and pastes the generated enum/enumNames blocks into ../new-project/template.yaml (the single
spot the wizard hardcodes the choice lists). The compose engine itself needs NO change — it
reads fragment.yaml at scaffold time. This keeps the wizard's lists in sync with the library
without a custom Backstage frontend field. (A future enhancement could replace this with a
dynamic scaffolder field extension; for now this generator is the low-risk path.)

Usage:  python3 gen-wizard-enums.py
"""
import glob
import os
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
FRAGMENTS = os.path.dirname(HERE)


def load():
    out = []
    for f in sorted(glob.glob(os.path.join(FRAGMENTS, "*", "*", "fragment.yaml"))):
        with open(f) as fh:
            d = yaml.safe_load(fh)
        cat = os.path.basename(os.path.dirname(os.path.dirname(f)))
        # Skip the _contract dir (a category starting with "_") AND placeholder/example
        # fragments whose id starts with "_" (e.g. mobile/_EXAMPLE) — those document the
        # contract for fan-out authors and must NOT surface as user-facing wizard choices.
        if cat.startswith("_") or str(d.get("id", "")).startswith("_"):
            continue
        d["_path"] = f"{cat}/{d['id']}"
        out.append(d)
    return out


def by_slot(frags, slot):
    """The fragments (in `load()` order) that fill `slot`. Hoisted to module level (was a
    main()-local lambda) so green-check.py's WIZ-001 assertion can import this exact
    derivation as ground truth for template.yaml's singleFragment enum — one source of
    truth for "what fills a slot", not a second hand-copied definition."""
    return [d for d in frags if slot in (d.get("slots") or [])]


def block(title, frags):
    print(f"# --- {title} ---")
    print("  enum:")
    for d in frags:
        print(f"    - {d['_path']}")
    print("  enumNames:")
    for d in frags:
        print(f"    - '{d['displayName']}'")
    print()


def main():
    frags = load()
    print("# Generated from _fragments/*/*/fragment.yaml — paste into new-project/template.yaml\n")
    block("single slot (web/single singleFragment)", by_slot(frags, "single"))
    block("frontend slot (web/frontend-backend frontendFragment)", by_slot(frags, "frontend"))
    block("backend slot (backendFragment)", by_slot(frags, "backend"))
    block("mobile slot (mobileFragment)", by_slot(frags, "mobile"))


if __name__ == "__main__":
    main()
