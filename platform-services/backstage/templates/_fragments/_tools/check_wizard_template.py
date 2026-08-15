#!/usr/bin/env python3
"""check_wizard_template.py — asserts new-project/template.yaml's fragment enums and
database-engine partitions are internally consistent, and stay consistent with the
fragment library.

Recommended by review-fix1-wizard-postgres-guard.md (line 146, WIZ-002/D-067): the
wizard's rjsf `oneOf` groups are hand-maintained YAML with no CI coverage of their own
(green-check.py never reads template.yaml). A maintainer adding a new needsDB fragment
to `singleFragment`'s enum but forgetting to file it into exactly one `oneOf` group
fails SILENTLY -- the Database question just disappears for that fragment, CI stays
green. This script is that missing assertion.

FIX-16/D-092 extended it: `host-postgres` is no longer offered for a single reason
(blank/bring-your-own ships no driver) -- it is also offered for the four fragments
that ship a REAL Postgres driver (django/express/fastapi/go). The check below is
bidirectional: it fails if host-postgres is offered to a MySQL-only group (D-054
regression) OR if it is missing from a fully Postgres-capable group (FIX-16
regression) -- proving the partition, not just checking it doesn't obviously break.

FIX-5/MOB-002 (review-fix5-mobile-hide.md) added a second, unrelated consistency check:
green-check.py's QUARANTINE dict (the four mobile/* fragments, F-3/D-058) has no
structural link to template.yaml's `projectType` enum -- the documented restore path
("put 'mobile' back in the enum") is one step short of correct on its own, because it
re-arms the F-3 bug (mobile selectable again, its build artifact still never produced)
with the gate still green, silently, unless the QUARANTINE entries are ALSO removed.
This is this script's natural home for that assertion (same "partition/consistency
audit of template.yaml" job), not green-check.py itself.

FIX-17/FIX5-REV-1 (review-fix5-land.md): PR #432's original check_wizard_template()
(the one FIX-5-LAND superseded with this file) had a FOURTH assertion this file never
carried forward: every needsDB fragment must land in a group whose schema actually
offers a `database` property -- catching a fragment correctly placed in exactly one
group (so check_exact_partition sees nothing wrong) but placed in the WRONG group, one
that never asks the Database question at all. Proven missing by mutation: moving
backend/flask (needsDB: true) into the DB-less group keeps the partition exact and
produced ZERO errors before this fix. check_needsdb_fragments_offer_database() below
closes that gap, applied across all three branches (single/frontend-backend/mobile) the
way every other check here already is -- a strict superset of PR #432's single-branch
original.

Usage:  python3 check_wizard_template.py
Exits 0 and prints OK on success; exits 1 and prints every violation on failure.
"""
import glob
import importlib.util
import os
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
FRAGMENTS = os.path.dirname(HERE)
TEMPLATE_PATH = os.path.join(FRAGMENTS, "..", "new-project", "template.yaml")
GREEN_CHECK_PATH = os.path.join(HERE, "green-check.py")

# Fragments that ship a REAL Postgres driver alongside their MySQL one, branching on
# the DATABASE_URL scheme at their DSN entry point (FIX-16). An explicit allowlist,
# not derived from fragment.yaml (which has no needsPostgres field) -- a fragment
# claiming Postgres support is a deliberate, reviewed addition to this list, not
# something that should be inferred and silently trusted.
POSTGRES_CAPABLE_WITH_DRIVER = frozenset(
    {
        "backend/django",
        "backend/express",
        "backend/fastapi",
        "backend/go",
    }
)
# Ships NO database driver at all (a throwaway placeholder) -- Auto PostgreSQL is safe
# for a different reason: there is no MySQL-only driver for it to conflict with.
POSTGRES_CAPABLE_NO_DRIVER = frozenset({"blank/bring-your-own"})
POSTGRES_CAPABLE = POSTGRES_CAPABLE_WITH_DRIVER | POSTGRES_CAPABLE_NO_DRIVER


class PartitionError(AssertionError):
    """Raised on any partition/consistency violation. Collected, not fail-fast, so a
    single run reports every problem instead of just the first."""


def load_fragments():
    """Ground truth from the fragment library -- the SAME source gen-wizard-enums.py
    reads, so this can be checked against the wizard without a second copy drifting."""
    out = []
    for f in sorted(glob.glob(os.path.join(FRAGMENTS, "*", "*", "fragment.yaml"))):
        with open(f) as fh:
            d = yaml.safe_load(fh)
        cat = os.path.basename(os.path.dirname(os.path.dirname(f)))
        if cat.startswith("_") or str(d.get("id", "")).startswith("_"):
            continue
        d["_path"] = f"{cat}/{d['id']}"
        out.append(d)
    return out


def load_template(path=None):
    with open(path or TEMPLATE_PATH) as fh:
        return yaml.safe_load(fh)


# ---- navigation helpers: the wizard's nested rjsf oneOf/dependencies structure ----


def _web_branch(doc):
    return doc["spec"]["parameters"][1]["dependencies"]["projectType"]["oneOf"][0]


def _mobile_branch(doc):
    return doc["spec"]["parameters"][1]["dependencies"]["projectType"]["oneOf"][1]


def single_top_enum(doc):
    single_branch = _web_branch(doc)["dependencies"]["layout"]["oneOf"][0]
    return single_branch["properties"]["singleFragment"]["enum"]


def single_groups(doc):
    single_branch = _web_branch(doc)["dependencies"]["layout"]["oneOf"][0]
    return single_branch["dependencies"]["singleFragment"]["oneOf"]


def fb_top_enum(doc):
    fb_branch = _web_branch(doc)["dependencies"]["layout"]["oneOf"][1]
    return fb_branch["properties"]["backendFragment"]["enum"]


def fb_groups(doc):
    fb_branch = _web_branch(doc)["dependencies"]["layout"]["oneOf"][1]
    return fb_branch["dependencies"]["backendFragment"]["oneOf"]


def mobile_top_enum(doc):
    return _mobile_branch(doc)["properties"]["backendFragment"]["enum"]


def mobile_groups(doc):
    return _mobile_branch(doc)["dependencies"]["backendFragment"]["oneOf"]


def project_type_enum(doc):
    """The top-level `projectType` enum -- what's actually SELECTABLE, as opposed to the
    `dependencies.projectType.oneOf` branches (both WEB and MOBILE stay structurally
    present and valid even while MOBILE is unreachable, FIX-5's "hide, don't delete")."""
    return doc["spec"]["parameters"][1]["properties"]["projectType"]["enum"]


def load_quarantine():
    """Import green-check.py (hyphenated filename, loaded like a sibling module) and
    return its QUARANTINE dict. Returns {} if the file or the symbol doesn't exist yet,
    so this script degrades gracefully on a green-check.py that predates FIX-5 rather
    than crashing -- the mobile-quarantine-consistency check simply has nothing to
    cross-check in that case."""
    if not os.path.exists(GREEN_CHECK_PATH):
        return {}
    spec = importlib.util.spec_from_file_location("green_check_for_wizard_check", GREEN_CHECK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return getattr(mod, "QUARANTINE", {})


def _group_fragments(group, field):
    return group["properties"][field]["enum"]


def _group_database_enum(group):
    return group["properties"].get("database", {}).get("enum", [])


# ---- assertions ----


def check_matches_fragment_library(top_enum, expected_paths, label, errors):
    if list(top_enum) != list(expected_paths):
        errors.append(
            f"{label}: template enum does not match gen-wizard-enums.py's ground truth.\n"
            f"    template: {list(top_enum)}\n"
            f"    library:  {list(expected_paths)}"
        )


def check_exact_partition(top_enum, groups, field, label, errors):
    """The groups' fragment enums must exactly partition top_enum: every entry covered
    exactly once -- no gaps (a fragment with no Database question), no overlaps (a
    fragment matched by two rjsf branches, which the schema itself would reject), and
    no strays (a group referencing a fragment absent from the top enum)."""
    seen = {}
    for i, g in enumerate(groups):
        for frag in _group_fragments(g, field):
            if frag in seen:
                errors.append(f"{label}: '{frag}' appears in both group {seen[frag]} and group {i} (overlap)")
                continue
            seen[frag] = i
    top_set = set(top_enum)
    seen_set = set(seen)
    missing = top_set - seen_set
    if missing:
        errors.append(f"{label}: fragments with no group (Database question silently missing): {sorted(missing)}")
    stray = seen_set - top_set
    if stray:
        errors.append(f"{label}: groups reference fragments absent from the top enum: {sorted(stray)}")


def check_postgres_offered_correctly(groups, field, label, errors):
    """host-postgres must appear in a group's database enum IFF every fragment in that
    group is Postgres-capable. Bidirectional on purpose: catches D-054 regressions
    (host-postgres offered to a MySQL-only fragment) AND FIX-16 regressions
    (host-postgres missing from a fragment that now genuinely supports it)."""
    for i, g in enumerate(groups):
        frags = _group_fragments(g, field)
        if not frags:
            continue
        has_pg = "host-postgres" in _group_database_enum(g)
        capable = [f for f in frags if f in POSTGRES_CAPABLE]
        incapable = [f for f in frags if f not in POSTGRES_CAPABLE]
        if has_pg and incapable:
            errors.append(
                f"{label} group {i}: offers host-postgres but contains MySQL-only fragment(s) {incapable}"
            )
        if capable and not incapable and not has_pg:
            errors.append(
                f"{label} group {i}: every fragment is Postgres-capable {frags} but host-postgres is missing"
            )


def check_needsdb_fragments_offer_database(top_enum, groups, field, fragments_by_path, label, errors):
    """FIX-17/FIX5-REV-1: every needsDB fragment must land in a group that offers a
    `database` property. check_exact_partition alone does not catch this -- a fragment
    can be placed in exactly one group (partition stays exact) while that group is the
    DB-less one, silently dropping its Database question. Proven by mutation
    (review-fix5-land.md): move backend/flask (needsDB: true) into the DB-less group and
    the exact-partition check alone sees nothing wrong.

    A fragment absent from `membership` (not in any group at all) is already reported by
    check_exact_partition as a gap -- not re-reported here, to keep each failure mode's
    message attributable to the check that actually diagnoses it.
    """
    membership = {}
    for gi, g in enumerate(groups):
        for frag in _group_fragments(g, field):
            membership[frag] = gi
    dropped = []
    for frag in top_enum:
        meta = fragments_by_path.get(frag)
        if meta is None or not meta.get("needsDB"):
            continue
        gi = membership.get(frag)
        if gi is None:
            continue
        if not _group_database_enum(groups[gi]):
            dropped.append(frag)
    if dropped:
        errors.append(
            f"{label}: needsDB fragment(s) placed in a group with no database question: {sorted(dropped)}"
        )


def check_mobile_quarantine_consistency(pt_enum, quarantine, errors):
    """MOB-002: if 'mobile' is reachable (present in the top projectType enum), no mobile/*
    fragment may remain in green-check.py's QUARANTINE. Restoring mobile without clearing
    the quarantine re-arms F-3/D-058 (no .apk/.ipa ever built) with the gate still green --
    this makes that specific restore mistake loud instead of silent."""
    if "mobile" not in pt_enum:
        return
    still_quarantined = sorted(f for f in quarantine if f.startswith("mobile/"))
    if still_quarantined:
        errors.append(
            "mobile-quarantine-consistency: 'mobile' is reachable in projectType, but "
            f"green-check.py's QUARANTINE still lists {still_quarantined} -- restoring "
            "mobile requires ALSO removing these entries (see template.yaml's projectType "
            "comment), or the F-3/D-058 bug re-arms with no CI signal"
        )


def run(doc=None, fragments=None, quarantine=None):
    """Run every assertion against a parsed template doc + fragment list. Returns the
    list of violations (empty on success) rather than raising, so callers can choose to
    collect-and-report or assert on `not run(...)`."""
    doc = doc if doc is not None else load_template()
    fragments = fragments if fragments is not None else load_fragments()
    quarantine = quarantine if quarantine is not None else load_quarantine()
    fragments_by_path = {d["_path"]: d for d in fragments}
    single_expected = [d["_path"] for d in fragments if "single" in (d.get("slots") or [])]
    backend_expected = [d["_path"] for d in fragments if "backend" in (d.get("slots") or [])]

    errors = []

    s_top, s_groups = single_top_enum(doc), single_groups(doc)
    check_matches_fragment_library(s_top, single_expected, "singleFragment", errors)
    check_exact_partition(s_top, s_groups, "singleFragment", "singleFragment", errors)
    check_postgres_offered_correctly(s_groups, "singleFragment", "singleFragment", errors)
    check_needsdb_fragments_offer_database(s_top, s_groups, "singleFragment", fragments_by_path, "singleFragment", errors)

    fb_top, fb_grps = fb_top_enum(doc), fb_groups(doc)
    check_matches_fragment_library(fb_top, backend_expected, "frontend-backend backendFragment", errors)
    check_exact_partition(fb_top, fb_grps, "backendFragment", "frontend-backend backendFragment", errors)
    check_postgres_offered_correctly(fb_grps, "backendFragment", "frontend-backend backendFragment", errors)
    check_needsdb_fragments_offer_database(fb_top, fb_grps, "backendFragment", fragments_by_path, "frontend-backend backendFragment", errors)

    m_top, m_grps = mobile_top_enum(doc), mobile_groups(doc)
    check_matches_fragment_library(m_top, backend_expected, "mobile backendFragment", errors)
    check_exact_partition(m_top, m_grps, "backendFragment", "mobile backendFragment", errors)
    check_postgres_offered_correctly(m_grps, "backendFragment", "mobile backendFragment", errors)
    check_needsdb_fragments_offer_database(m_top, m_grps, "backendFragment", fragments_by_path, "mobile backendFragment", errors)

    check_mobile_quarantine_consistency(project_type_enum(doc), quarantine, errors)

    return errors


def main():
    errors = run()
    if errors:
        print("FAIL: template.yaml partition/consistency check found problems:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("OK: template.yaml enum partitions are exact and host-postgres is offered correctly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
