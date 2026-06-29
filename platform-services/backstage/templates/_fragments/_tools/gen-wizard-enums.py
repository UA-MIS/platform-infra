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
        d = yaml.safe_load(open(f))
        cat = os.path.basename(os.path.dirname(os.path.dirname(f)))
        if cat.startswith("_"):
            continue
        d["_path"] = f"{cat}/{d['id']}"
        out.append(d)
    return out


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
    by_slot = lambda slot: [d for d in frags if slot in (d.get("slots") or [])]
    print("# Generated from _fragments/*/*/fragment.yaml — paste into new-project/template.yaml\n")
    block("single slot (web/single singleFragment)", by_slot("single"))
    block("frontend slot (web/frontend-backend frontendFragment)", by_slot("frontend"))
    block("backend slot (backendFragment)", by_slot("backend"))
    block("mobile slot (mobileFragment)", by_slot("mobile"))


if __name__ == "__main__":
    main()
