#!/usr/bin/env python3
"""check_wizard_template.test.py — tests for check_wizard_template.py (FIX-16/D-092).

Sibling-named after the gate it tests (like green-check.py + green-check.test.py).
Run it directly:  python3 check_wizard_template.test.py

Two layers:
  - POSITIVE: the real template.yaml + fragment library must pass clean.
  - HAZARD MUTATIONS (the point of this file): a set of small, deliberately-broken
    copies of a minimal doc/fragment fixture, each engineered to violate exactly one
    assertion. If a mutation does NOT get caught, the checker has a blind spot -- these
    prove the partition assertion actually bites rather than passing vacuously.
"""
import copy
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import check_wizard_template as cwt  # noqa: E402


class RealTemplateTest(unittest.TestCase):
    """The actual template.yaml, checked as CI will check it."""

    def test_real_template_and_fragment_library_pass_clean(self):
        errors = cwt.run()
        self.assertEqual(errors, [], f"real template.yaml should pass clean, got: {errors}")

    def test_real_template_offers_postgres_for_exactly_the_capable_set(self):
        # Direct proof FIX-16 landed: host-postgres reachable for all five capable
        # fragments (four with a real driver + blank/BYO), in every branch that offers
        # them, and reachable for no MySQL-only fragment anywhere.
        doc = cwt.load_template()
        for groups, field in (
            (cwt.single_groups(doc), "singleFragment"),
            (cwt.fb_groups(doc), "backendFragment"),
            (cwt.mobile_groups(doc), "backendFragment"),
        ):
            for g in groups:
                frags = cwt._group_fragments(g, field)
                has_pg = "host-postgres" in cwt._group_database_enum(g)
                capable_frags = [f for f in frags if f in cwt.POSTGRES_CAPABLE]
                mysql_only_frags = [f for f in frags if f not in cwt.POSTGRES_CAPABLE and f]
                if capable_frags and not mysql_only_frags:
                    self.assertTrue(has_pg, f"{frags} are all Postgres-capable but host-postgres missing")
                if mysql_only_frags:
                    self.assertFalse(has_pg, f"{frags} includes MySQL-only fragment(s) but host-postgres offered")

    def test_real_flask_into_dbless_group_mutation_is_caught(self):
        # FIX-17/FIX5-REV-1's exact reproduction, against the REAL template.yaml and REAL
        # fragment library (not the minimal fixture): move backend/flask (needsDB: true)
        # from the MySQL-only group into the DB-less group. The partition itself stays
        # exact, which is precisely why this hazard survived undetected before this fix --
        # confirmed here with the real file, not just the synthetic fixture in
        # HazardMutationTest.
        doc = cwt.load_template()
        groups = cwt.single_groups(doc)
        dbless_group = next(g for g in groups if not cwt._group_database_enum(g))
        mysql_group = next(g for g in groups if "backend/flask" in cwt._group_fragments(g, "singleFragment"))
        mysql_group["properties"]["singleFragment"]["enum"].remove("backend/flask")
        dbless_group["properties"]["singleFragment"]["enum"].append("backend/flask")
        errors = cwt.run(doc=doc)
        self.assertFalse(any("exact-partition" in e for e in errors), errors)
        self.assertTrue(
            any("needsDB fragment(s) placed in a group with no database question" in e and "backend/flask" in e
                for e in errors),
            errors,
        )


# ---- minimal fixture for hazard mutations (small, so each break is obvious) --------

FRAGMENTS_FIXTURE = [
    {"_path": "backend/fastapi", "slots": ["single", "backend"], "needsDB": True},
    {"_path": "backend/flask", "slots": ["single", "backend"], "needsDB": True},
    {"_path": "blank/bring-your-own", "slots": ["single"], "needsDB": True},
    {"_path": "frontend/angular", "slots": ["single", "frontend"], "needsDB": False},
]


def _minimal_doc():
    """A minimal-but-structurally-real template doc: one DB-less group, one MySQL-only
    group, one Postgres-capable group, mirroring the real template's shape closely
    enough that the navigation helpers (single_top_enum, single_groups, ...) work
    unmodified. frontend-backend / mobile branches are included but trivial (empty
    backendFragment enums) since these mutations target the single-app branch only.
    """
    return {
        "spec": {
            "parameters": [
                {},
                {
                    # Mobile absent here (mirrors the real, shipped, post-FIX-5 state) so
                    # these fixture-driven hazard tests don't also trip the MOB-002
                    # mobile-quarantine-consistency check, which has its own dedicated
                    # tests below.
                    "properties": {"projectType": {"enum": ["web"]}},
                    "dependencies": {
                        "projectType": {
                            "oneOf": [
                                {  # web branch
                                    "dependencies": {
                                        "layout": {
                                            "oneOf": [
                                                {  # single
                                                    "properties": {
                                                        "singleFragment": {
                                                            # Order matches FRAGMENTS_FIXTURE's own
                                                            # order (the "library" ground truth is
                                                            # filtered in list order, not re-sorted).
                                                            "enum": [
                                                                "backend/fastapi",
                                                                "backend/flask",
                                                                "blank/bring-your-own",
                                                                "frontend/angular",
                                                            ]
                                                        }
                                                    },
                                                    "dependencies": {
                                                        "singleFragment": {
                                                            "oneOf": [
                                                                {
                                                                    "properties": {
                                                                        "singleFragment": {
                                                                            "enum": ["frontend/angular"]
                                                                        }
                                                                    }
                                                                },
                                                                {
                                                                    "properties": {
                                                                        "singleFragment": {"enum": ["backend/flask"]},
                                                                        "database": {
                                                                            "enum": [
                                                                                "host-mysql",
                                                                                "bring-your-own",
                                                                                "none",
                                                                            ]
                                                                        },
                                                                    }
                                                                },
                                                                {
                                                                    "properties": {
                                                                        "singleFragment": {
                                                                            "enum": [
                                                                                "backend/fastapi",
                                                                                "blank/bring-your-own",
                                                                            ]
                                                                        },
                                                                        "database": {
                                                                            "enum": [
                                                                                "host-mysql",
                                                                                "host-postgres",
                                                                                "bring-your-own",
                                                                                "none",
                                                                            ]
                                                                        },
                                                                    }
                                                                },
                                                            ]
                                                        }
                                                    },
                                                },
                                                {  # frontend-backend (structurally valid but not
                                                    # exercised by the hazard mutations below --
                                                    # they all target the single-app branch)
                                                    "properties": {
                                                        "backendFragment": {"enum": ["backend/fastapi", "backend/flask"]}
                                                    },
                                                    "dependencies": {
                                                        "backendFragment": {
                                                            "oneOf": [
                                                                {
                                                                    "properties": {
                                                                        "backendFragment": {"enum": ["backend/flask"]},
                                                                        "database": {
                                                                            "enum": [
                                                                                "host-mysql",
                                                                                "bring-your-own",
                                                                                "none",
                                                                            ]
                                                                        },
                                                                    }
                                                                },
                                                                {
                                                                    "properties": {
                                                                        "backendFragment": {"enum": ["backend/fastapi"]},
                                                                        "database": {
                                                                            "enum": [
                                                                                "host-mysql",
                                                                                "host-postgres",
                                                                                "bring-your-own",
                                                                                "none",
                                                                            ]
                                                                        },
                                                                    }
                                                                },
                                                            ]
                                                        }
                                                    },
                                                },
                                            ]
                                        }
                                    }
                                },
                                {  # mobile branch (same structurally-valid, unexercised shape)
                                    "properties": {
                                        "backendFragment": {"enum": ["backend/fastapi", "backend/flask"]}
                                    },
                                    "dependencies": {
                                        "backendFragment": {
                                            "oneOf": [
                                                {
                                                    "properties": {
                                                        "backendFragment": {"enum": ["backend/flask"]},
                                                        "database": {
                                                            "enum": ["host-mysql", "bring-your-own", "none"]
                                                        },
                                                    }
                                                },
                                                {
                                                    "properties": {
                                                        "backendFragment": {"enum": ["backend/fastapi"]},
                                                        "database": {
                                                            "enum": [
                                                                "host-mysql",
                                                                "host-postgres",
                                                                "bring-your-own",
                                                                "none",
                                                            ]
                                                        },
                                                    }
                                                },
                                            ]
                                        }
                                    },
                                },
                            ]
                        }
                    }
                },
            ]
        }
    }


class HazardMutationTest(unittest.TestCase):
    """Each test proves one specific way the partition CAN break, and that run()
    reports it. A hazard test that passes silently (finds nothing) is the failure mode
    this whole file exists to prevent."""

    def test_baseline_fixture_is_clean(self):
        # Control: the fixture itself, unmutated, must pass -- otherwise the mutation
        # tests below would be proving nothing (a broken baseline "catches" everything).
        errors = cwt.run(doc=_minimal_doc(), fragments=FRAGMENTS_FIXTURE)
        self.assertEqual(errors, [])

    def test_hazard_gap_uncovered_fragment_is_caught(self):
        # A fragment present in the top enum but filed into NO group (the exact WIZ-002
        # scenario: a maintainer adds a fragment and forgets the oneOf group).
        doc = copy.deepcopy(_minimal_doc())
        single_top = cwt.single_top_enum(doc)
        single_top.append("backend/new-stack")  # top enum knows it, no group does
        fragments = FRAGMENTS_FIXTURE + [{"_path": "backend/new-stack", "slots": ["single", "backend"]}]
        errors = cwt.run(doc=doc, fragments=fragments)
        self.assertTrue(any("no group" in e for e in errors), errors)

    def test_hazard_overlap_fragment_in_two_groups_is_caught(self):
        # The same fragment misfiled into two oneOf branches (schema-invalid in
        # practice, but the checker must not silently ignore it either).
        doc = copy.deepcopy(_minimal_doc())
        groups = cwt.single_groups(doc)
        groups[1]["properties"]["singleFragment"]["enum"].append("backend/fastapi")
        errors = cwt.run(doc=doc, fragments=FRAGMENTS_FIXTURE)
        self.assertTrue(any("overlap" in e for e in errors), errors)

    def test_hazard_postgres_leaked_into_mysql_only_group_is_caught(self):
        # D-054 regression: host-postgres offered to a fragment with no Postgres driver.
        doc = copy.deepcopy(_minimal_doc())
        groups = cwt.single_groups(doc)
        groups[1]["properties"]["database"]["enum"] = ["host-mysql", "host-postgres", "bring-your-own", "none"]
        errors = cwt.run(doc=doc, fragments=FRAGMENTS_FIXTURE)
        self.assertTrue(any("MySQL-only fragment" in e for e in errors), errors)

    def test_hazard_postgres_missing_from_capable_group_is_caught(self):
        # FIX-16 regression: a fully Postgres-capable group loses host-postgres (e.g. a
        # careless future edit reverting toward the old D-054 blanket rule).
        doc = copy.deepcopy(_minimal_doc())
        groups = cwt.single_groups(doc)
        groups[2]["properties"]["database"]["enum"] = ["host-mysql", "bring-your-own", "none"]
        errors = cwt.run(doc=doc, fragments=FRAGMENTS_FIXTURE)
        self.assertTrue(any("host-postgres is missing" in e for e in errors), errors)

    def test_hazard_template_drifts_from_fragment_library_is_caught(self):
        # The fragment library gained a new single-slot fragment that the template's
        # top-level enum never learned about (or vice versa) -- gen-wizard-enums.py's
        # ground truth and the hand-maintained template.yaml disagree.
        doc = copy.deepcopy(_minimal_doc())
        fragments = FRAGMENTS_FIXTURE + [{"_path": "backend/undeclared", "slots": ["single"]}]
        errors = cwt.run(doc=doc, fragments=fragments)
        self.assertTrue(any("does not match gen-wizard-enums.py" in e for e in errors), errors)

    def test_hazard_needsdb_fragment_moved_into_dbless_group_is_caught(self):
        # FIX-17/FIX5-REV-1 (review-fix5-land.md): the hazard check_exact_partition alone
        # CANNOT catch -- backend/flask (needsDB: True in the fixture) moved from the
        # MySQL-only group into the DB-less group. The partition stays EXACT (flask is
        # still in exactly one group), so check_exact_partition sees nothing wrong; only
        # the needsDB-placement check catches that flask's Database question vanished.
        doc = copy.deepcopy(_minimal_doc())
        groups = cwt.single_groups(doc)
        groups[1]["properties"]["singleFragment"]["enum"].remove("backend/flask")
        groups[0]["properties"]["singleFragment"]["enum"].append("backend/flask")
        errors = cwt.run(doc=doc, fragments=FRAGMENTS_FIXTURE)
        # The partition itself must still be reported exact -- proves this specific
        # mutation is invisible to check_exact_partition, exactly as the review found.
        self.assertFalse(any("exact-partition" in e for e in errors), errors)
        self.assertTrue(
            any("needsDB fragment(s) placed in a group with no database question" in e and "backend/flask" in e
                for e in errors),
            errors,
        )


class MobileQuarantineConsistencyTests(unittest.TestCase):
    """MOB-002 (review-fix5-mobile-hide.md): green-check.py's QUARANTINE dict has no
    structural link to template.yaml's projectType enum on its own -- these tests prove
    check_mobile_quarantine_consistency() supplies that missing link, both as a pure
    function (fast, no doc parsing) and wired end-to-end through run().
    """

    def test_mobile_unreachable_with_quarantine_populated_is_fine(self):
        # The REAL, current, shipped state (FIX-5): mobile hidden, four mobile/* fragments
        # still quarantined (they are genuinely broken; hiding does not fix them, D-058).
        errors = []
        cwt.check_mobile_quarantine_consistency(["web"], {"mobile/flutter": "..."}, errors)
        self.assertEqual(errors, [])

    def test_mobile_reachable_with_empty_quarantine_is_fine(self):
        # A COMPLETE, correct restore: 'mobile' put back AND the quarantine cleared.
        errors = []
        cwt.check_mobile_quarantine_consistency(["web", "mobile"], {}, errors)
        self.assertEqual(errors, [])

    def test_mobile_reachable_with_nonmobile_quarantine_entries_is_fine(self):
        # A quarantine entry for something other than mobile/* must not false-positive.
        errors = []
        cwt.check_mobile_quarantine_consistency(["web", "mobile"], {"backend/flask": "unrelated"}, errors)
        self.assertEqual(errors, [])

    def test_hazard_mobile_restored_with_quarantine_still_populated_is_caught(self):
        # THE bug MOB-002 exists to prevent: someone follows the documented restore's
        # first step (put 'mobile' back) and forgets the second (clear QUARANTINE) --
        # F-3/D-058 re-arms with the gate still green, silently, unless this catches it.
        errors = []
        cwt.check_mobile_quarantine_consistency(
            ["web", "mobile"],
            {"mobile/android-kotlin": "...", "mobile/flutter": "...",
             "mobile/ios-swift": "...", "mobile/react-native": "..."},
            errors,
        )
        self.assertEqual(len(errors), 1)
        self.assertIn("mobile-quarantine-consistency", errors[0])
        for rel in ("mobile/android-kotlin", "mobile/flutter", "mobile/ios-swift", "mobile/react-native"):
            self.assertIn(rel, errors[0])

    def test_wired_end_to_end_through_run(self):
        # Proves the wiring, not just the standalone function: run() with a doc whose
        # projectType enum includes 'mobile' and a quarantine dict that still lists it.
        doc = copy.deepcopy(_minimal_doc())
        doc["spec"]["parameters"][1]["properties"]["projectType"]["enum"] = ["web", "mobile"]
        errors = cwt.run(doc=doc, fragments=FRAGMENTS_FIXTURE, quarantine={"mobile/flutter": "..."})
        self.assertTrue(any("mobile-quarantine-consistency" in e for e in errors), errors)

    def test_load_quarantine_reads_the_real_green_check_module(self):
        # Not a mock -- proves this script actually imports green-check.py's real QUARANTINE,
        # so a change to that dict is picked up automatically, not hand-copied here.
        q = cwt.load_quarantine()
        for rel in ("mobile/android-kotlin", "mobile/flutter", "mobile/ios-swift", "mobile/react-native"):
            self.assertIn(rel, q)


if __name__ == "__main__":
    unittest.main()
