#!/usr/bin/env python3
"""green-check.test.py — tests for the green-out-of-box gate (ADR-035 §B).

Sibling-named after the gate it tests (like the .devops/ci/*.test.sh + composePlan.test.cjs
convention). Run it directly:  python3 green-check.test.py

Two layers (test pyramid):
  - UNIT (always run): the pure logic — fragment discovery, scenario selection, and the
    build-artifact expectation map — with no node/kustomize needed.
  - INTEGRATION (skipped if node/kustomize absent): compose a real fragment end-to-end and
    assert GREEN, plus a NEGATIVE test that a deliberately broken fragment (skeleton missing
    its Dockerfile) is caught RED — proving the gate actually fails a red-out-of-box scaffold.
"""
import importlib.util
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import compose_lib  # noqa: E402
from compose_lib import ComposeError, FRAGMENTS  # noqa: E402


def _load_module(filename, name):
    """Import a hyphenated sibling script (e.g. green-check.py) as a module."""
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gc = _load_module("green-check.py", "green_check")

HAVE_NODE = shutil.which("node") is not None
HAVE_KUSTOMIZE = compose_lib.kustomize_tool() is not None


class DiscoveryTests(unittest.TestCase):
    def test_discovers_known_fragments(self):
        frags = compose_lib.discover_fragments()
        self.assertIn("backend/express", frags)
        self.assertIn("frontend/react", frags)
        self.assertIn("static/react-static", frags)
        self.assertGreaterEqual(len(frags), 20, "expected the full fragment library")

    def test_excludes_underscore_and_contract_dirs(self):
        frags = compose_lib.discover_fragments()
        # The mobile contract STUB and the shared _contract/_tools must never be gated.
        self.assertNotIn("mobile/_EXAMPLE", frags)
        for f in frags:
            self.assertFalse(any(part.startswith("_") for part in f.split("/")),
                             f"underscore dir leaked into discovery: {f}")


class ScenarioTests(unittest.TestCase):
    def test_single_slot_fragment_uses_single_layout(self):
        meta = {"id": "x", "category": "backend", "slots": ["backend", "single"], "needsDB": True}
        sel = compose_lib.scenario_for(meta, "backend/x")
        self.assertEqual(sel["projectType"], "web")
        self.assertEqual(sel["layout"], "single")
        self.assertEqual(sel["single"], "backend/x")
        self.assertEqual(sel["database"], "host-mysql")  # needsDB -> exercise the DB overlays

    def test_single_slot_no_db_uses_none(self):
        meta = {"id": "s", "category": "static", "slots": ["single"], "needsDB": False}
        sel = compose_lib.scenario_for(meta, "static/s")
        self.assertEqual(sel["database"], "none")

    def test_pure_frontend_pairs_with_default_backend(self):
        meta = {"id": "fe", "category": "frontend", "slots": ["frontend"], "needsDB": False}
        sel = compose_lib.scenario_for(meta, "frontend/fe")
        self.assertEqual(sel["layout"], "frontend-backend")
        self.assertEqual(sel["frontend"], "frontend/fe")
        self.assertEqual(sel["backend"], compose_lib.DEFAULT_BACKEND)

    def test_mobile_pairs_with_backend(self):
        meta = {"id": "m", "category": "mobile", "slots": ["mobile"], "needsDB": False}
        sel = compose_lib.scenario_for(meta, "mobile/m")
        self.assertEqual(sel["projectType"], "mobile")
        self.assertEqual(sel["mobile"], "mobile/m")
        self.assertEqual(sel["backend"], compose_lib.DEFAULT_BACKEND)

    def test_backend_only_pairs_with_default_frontend(self):
        meta = {"id": "be", "category": "backend", "slots": ["backend"], "needsDB": True}
        sel = compose_lib.scenario_for(meta, "backend/be")
        self.assertEqual(sel["layout"], "frontend-backend")
        self.assertEqual(sel["backend"], "backend/be")
        self.assertEqual(sel["frontend"], compose_lib.DEFAULT_FRONTEND)

    def test_slotless_fragment_raises(self):
        with self.assertRaises(ComposeError):
            compose_lib.scenario_for({"id": "z", "category": "backend", "slots": []}, "backend/z")


class BuildArtifactTests(unittest.TestCase):
    def _fake_composed(self, components, copies, metas):
        return compose_lib.Composed(out=Path("/nowhere"), plan={"components": components,
                                    "copies": copies}, values={}, metas=metas, srcdirs={},
                                    selection={})

    def test_container_component_expects_dockerfile(self):
        comp = {"name": "app", "context": "app", "buildType": "container", "dockerfile": "Dockerfile"}
        meta = {"id": "x", "dockerfile": "Dockerfile", "buildType": "container"}
        c = self._fake_composed([comp], [{"fragment": {"id": "x"}, "targetDir": "app"}],
                                {"single": meta})
        self.assertEqual(compose_lib.expected_build_artifacts(c), [("app", "app/Dockerfile")])

    def test_mobile_component_expects_build_workflow(self):
        comp = {"name": "mobile", "context": "mobile", "buildType": "mobile-artifact", "dockerfile": ""}
        meta = {"id": "m", "buildType": "mobile-artifact", "buildWorkflow": ".mobile-ci/build.yaml"}
        c = self._fake_composed([comp], [{"fragment": {"id": "m"}, "targetDir": "mobile"}],
                                {"mobile": meta})
        self.assertEqual(compose_lib.expected_build_artifacts(c),
                         [("mobile", "mobile/.mobile-ci/build.yaml")])

    def test_mobile_without_workflow_raises(self):
        comp = {"name": "mobile", "context": "mobile", "buildType": "mobile-artifact", "dockerfile": ""}
        meta = {"id": "m", "buildType": "mobile-artifact"}  # no buildWorkflow
        c = self._fake_composed([comp], [{"fragment": {"id": "m"}, "targetDir": "mobile"}],
                                {"mobile": meta})
        with self.assertRaises(ComposeError):
            compose_lib.expected_build_artifacts(c)


@unittest.skipUnless(HAVE_NODE and HAVE_KUSTOMIZE, "needs node + kustomize/kubectl")
class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.workdir = Path(tempfile.mkdtemp(prefix="green-check-test-"))

    def tearDown(self):
        shutil.rmtree(self.workdir, ignore_errors=True)

    def test_known_fragment_is_green(self):
        r = gc.check_fragment("backend/express", self.workdir)
        self.assertTrue(r["ok"], f"expected express GREEN, got: {r['errors']}")
        # every gate present: compose + build-file + 4 overlays.
        names = [c["name"] for c in r["checks"]]
        self.assertIn("compose", names)
        self.assertTrue(any(n.startswith("build-file") for n in names))
        for env in ("dev", "staging", "prod", "preview"):
            self.assertIn(f"kustomize[{env}]", names)

    def test_broken_fragment_is_caught_red(self):
        # Materialize a fragment whose skeleton is MISSING its Dockerfile -> a red scaffold.
        # Leading underscore keeps a leftover out of a real discovery run if teardown is skipped.
        rel = "backend/_selftest_broken"
        frag_dir = FRAGMENTS / rel
        (frag_dir / "skeleton").mkdir(parents=True, exist_ok=True)
        try:
            (frag_dir / "fragment.yaml").write_text(textwrap.dedent("""\
                apiVersion: platform.capstone/fragment.v1
                id: _selftest_broken
                displayName: self-test broken fragment (no Dockerfile)
                category: backend
                language: none
                framework: none
                slots: [single]
                defaultPort: 8080
                ingressPath: /
                needsDB: false
                buildType: container
                dockerfile: Dockerfile
                healthPath: /healthz
                """))
            # A skeleton file exists, but NOT the declared Dockerfile.
            (frag_dir / "skeleton" / "README.md").write_text("no Dockerfile here\n")

            r = gc.check_fragment(rel, self.workdir)
            self.assertFalse(r["ok"], "gate must FAIL a fragment missing its Dockerfile")
            self.assertTrue(any("build-file" in e and "MISSING" in e for e in r["errors"]),
                            f"expected a build-file MISSING finding, got: {r['errors']}")
            # The kustomize overlays should still render (proves the RED is the Dockerfile,
            # not a broken chart) — a precise, non-flaky negative.
            self.assertTrue(all(c["ok"] for c in r["checks"] if c["name"].startswith("kustomize")),
                            "overlays should still build; only the Dockerfile is missing")
        finally:
            shutil.rmtree(frag_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
