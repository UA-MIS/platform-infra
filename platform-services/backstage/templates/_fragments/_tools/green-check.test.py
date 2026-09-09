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
from unittest.mock import patch

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


@unittest.skipUnless(HAVE_NODE and HAVE_KUSTOMIZE, "needs node + kustomize/kubectl")
class BootProbeWiringTests(unittest.TestCase):
    """GATE-1's --boot-probe wiring (check_fragment's `mariadb` param), WITHOUT a real docker
    daemon: boot_probe.boot_probe_component() is mocked, so these assert the SELECTION logic
    (which fragments get boot-probed, and how a result propagates) — boot_probe.py's own
    build/run/probe behavior is covered separately by boot_probe.test.py."""

    def setUp(self):
        self.workdir = Path(tempfile.mkdtemp(prefix="green-check-test-bootprobe-"))

    def tearDown(self):
        shutil.rmtree(self.workdir, ignore_errors=True)

    def test_boot_probe_runs_for_a_single_slot_fragment_when_mariadb_given(self):
        with patch.object(gc.boot_probe, "boot_probe_component",
                          return_value=(True, "fake healthy")) as m:
            r = gc.check_fragment("backend/express", self.workdir, mariadb=object())
        m.assert_called_once()
        # First positional arg is the composed 'app' component (the single-slot component name).
        called_comp = m.call_args[0][0]
        self.assertEqual(called_comp["name"], "app")
        names = [c["name"] for c in r["checks"]]
        self.assertIn("boot-probe", names)
        self.assertTrue(r["ok"])

    def test_boot_probe_skipped_when_mariadb_not_given(self):
        # Default (no --boot-probe): the existing checks run, but boot-probe never fires —
        # this is what keeps green-check.py's normal (fast, docker-less) path unchanged.
        r = gc.check_fragment("backend/express", self.workdir)
        names = [c["name"] for c in r["checks"]]
        self.assertNotIn("boot-probe", names)

    def test_boot_probe_skipped_for_a_frontend_only_fragment(self):
        # BEHAVIOUR CONTRACT: a fragment that fills ONLY the 'frontend' slot resolves to the
        # frontend-backend layout (compose_lib.scenario_for) and must NOT be independently
        # boot-probed — the probed component would be a partner backend, not the fragment
        # under test. See check_fragment's docstring.
        #
        # This used to be asserted against the REAL frontend/react. Board #207 gave
        # react/vue/solid the `single` slot (they are now boot-probed — see the next test), so
        # no real fragment has this shape any more and the assertion had to move to a patched
        # meta or be deleted. Deleting it would have retired the guard silently: the selection
        # rule still exists and still matters for any future frontend-only fragment.
        real_meta, _ = compose_lib.load_meta("frontend/react")
        fe_only = dict(real_meta, slots=["frontend"])
        with patch.object(gc, "load_meta", return_value=(fe_only, None)):
            with patch.object(gc.boot_probe, "boot_probe_component") as m:
                r = gc.check_fragment("frontend/react", self.workdir, mariadb=object())
        self.assertEqual(r["scenario"]["layout"], "frontend-backend")
        m.assert_not_called()
        names = [c["name"] for c in r["checks"]]
        self.assertNotIn("boot-probe", names)

    def test_boot_probe_runs_for_the_framework_frontends_added_by_207(self):
        # Board #207: react/vue/solid declare `single`, so they now resolve to the single
        # layout and ARE boot-probed — the coverage gap this closes. Pinned as a POSITIVE
        # assertion so removing `single` from any of them (which would silently drop them from
        # the sweep again, exactly how the gap was created) fails loudly here.
        for rel in ("frontend/react", "frontend/vue", "frontend/solid"):
            with self.subTest(fragment=rel):
                with patch.object(gc.boot_probe, "boot_probe_component",
                                  return_value=(True, "fake healthy")) as m:
                    r = gc.check_fragment(rel, self.workdir, mariadb=object())
                m.assert_called_once()
                self.assertEqual(r["scenario"]["layout"], "single")
                # The probed component is the fragment's OWN single component, not a partner.
                self.assertEqual(m.call_args[0][0]["name"], "app")
                self.assertIn("boot-probe", [c["name"] for c in r["checks"]])
                self.assertTrue(r["ok"], r["errors"])

    def test_boot_probe_failure_marks_the_fragment_red(self):
        with patch.object(gc.boot_probe, "boot_probe_component",
                          return_value=(False, "container exited before healthy")):
            r = gc.check_fragment("backend/express", self.workdir, mariadb=object())
        self.assertFalse(r["ok"], "a failed boot-probe must fail the fragment overall")
        self.assertTrue(any("boot-probe" in e for e in r["errors"]))

    def test_boot_probe_environment_error_is_reported_not_raised(self):
        # BootProbeError from boot_probe_component (docker missing, etc.) must become a
        # finding, not an unhandled exception that kills the whole sweep mid-run.
        with patch.object(gc.boot_probe, "boot_probe_component",
                          side_effect=gc.boot_probe.BootProbeError("docker/podman not found")):
            r = gc.check_fragment("backend/express", self.workdir, mariadb=object())
        self.assertFalse(r["ok"])
        self.assertTrue(any("environment error" in e for e in r["errors"]))


class WorkflowReachabilityTests(unittest.TestCase):
    """F-3/D-058: (a) build-file only proves the buildWorkflow file EXISTS; these prove the
    NEW check catches it existing in the wrong place (not under .github/workflows/)."""

    def _fake_composed(self, components, copies, metas):
        return compose_lib.Composed(out=Path("/nowhere"), plan={"components": components,
                                    "copies": copies}, values={}, metas=metas, srcdirs={},
                                    selection={})

    def test_mobile_ci_path_is_unreachable(self):
        # This is exactly what every shipped mobile fragment declares today.
        comp = {"name": "mobile", "context": "mobile", "buildType": "mobile-artifact", "dockerfile": ""}
        meta = {"id": "m", "buildType": "mobile-artifact", "buildWorkflow": ".mobile-ci/build.yaml"}
        c = self._fake_composed([comp], [{"fragment": {"id": "m"}, "targetDir": "mobile"}],
                                {"mobile": meta})
        self.assertEqual(compose_lib.mobile_workflow_reachability(c),
                         [("mobile", "mobile/.mobile-ci/build.yaml", False)])

    def test_github_workflows_path_is_reachable(self):
        # Simulate a fixed fragment whose targetDir composes INTO .github/workflows/ AND
        # whose buildWorkflow itself has no further subdirectory component (MOB-003: a real
        # fix needs BOTH — relocating targetDir alone while buildWorkflow keeps a nested
        # path, e.g. ".mobile-ci/build.yaml", would still compose one level too deep, see
        # test_nested_workflows_subdirectory_is_unreachable below). Deferred, D-058; this
        # only proves the check accepts the shape a real fix would need, without moving any
        # files. context must match the copy's targetDir (compose_lib links components to
        # copies by that field) — see expected_build_artifacts().
        comp = {"name": "mobile", "context": ".github/workflows", "buildType": "mobile-artifact",
               "dockerfile": ""}
        meta = {"id": "m", "buildType": "mobile-artifact", "buildWorkflow": "build.yaml"}
        c = self._fake_composed([comp], [{"fragment": {"id": "m"}, "targetDir": ".github/workflows"}],
                                {"mobile": meta})
        self.assertTrue(compose_lib.mobile_workflow_reachability(c)[0][2])

    def test_nested_workflows_subdirectory_is_unreachable(self):
        # MOB-003 (review-fix5-mobile-hide.md): GitHub Actions does not discover workflows in
        # a SUBDIRECTORY of .github/workflows/ either — a naive startswith() check would pass
        # this and still never run. This is the hardening case that proves it doesn't.
        comp = {"name": "mobile", "context": ".github/workflows/ios", "buildType": "mobile-artifact",
               "dockerfile": ""}
        meta = {"id": "m", "buildType": "mobile-artifact", "buildWorkflow": "build.yaml"}
        c = self._fake_composed([comp], [{"fragment": {"id": "m"}, "targetDir": ".github/workflows/ios"}],
                                {"mobile": meta})
        result = compose_lib.mobile_workflow_reachability(c)
        self.assertEqual(result, [("mobile", ".github/workflows/ios/build.yaml", False)])

    def test_container_components_are_not_in_scope(self):
        comp = {"name": "app", "context": "app", "buildType": "container", "dockerfile": "Dockerfile"}
        meta = {"id": "x", "dockerfile": "Dockerfile", "buildType": "container"}
        c = self._fake_composed([comp], [{"fragment": {"id": "x"}, "targetDir": "app"}],
                                {"single": meta})
        self.assertEqual(compose_lib.mobile_workflow_reachability(c), [])


class QuarantineTests(unittest.TestCase):
    def test_only_the_four_mobile_fragments_are_quarantined(self):
        for rel in ("mobile/android-kotlin", "mobile/flutter", "mobile/ios-swift", "mobile/react-native"):
            self.assertIn(rel, gc.QUARANTINE, f"{rel} must be quarantined (F-3/D-058)")
        for rel in compose_lib.discover_fragments():
            if not rel.startswith("mobile/"):
                self.assertNotIn(rel, gc.QUARANTINE,
                                 f"only the F-3/D-058 mobile fragments may be quarantined, found {rel}")

    def test_quarantine_hides_known_red_from_the_default_sweep(self):
        results = [{"fragment": "mobile/flutter", "ok": False},
                   {"fragment": "backend/express", "ok": True}]
        passed, quarantined, failed = gc.partition_results(results, quarantine_active=True)
        self.assertEqual([r["fragment"] for r in passed], ["backend/express"])
        self.assertEqual([r["fragment"] for r in quarantined], ["mobile/flutter"])
        self.assertEqual(failed, [], "a quarantined fragment must not block the default gate")

    def test_quarantine_inactive_reports_true_status(self):
        # This is the --only path: the fragment's true RED status must surface, proving the
        # reachability assertion is not silently defanged by quarantine.
        results = [{"fragment": "mobile/flutter", "ok": False}]
        passed, quarantined, failed = gc.partition_results(results, quarantine_active=False)
        self.assertEqual(quarantined, [])
        self.assertEqual([r["fragment"] for r in failed], ["mobile/flutter"])

    def test_ok_fragment_is_never_quarantined(self):
        # A fragment that's genuinely green must count as passed even if it happens to be
        # listed in QUARANTINE (defensive — quarantine should never mask a real pass/fail).
        results = [{"fragment": "mobile/flutter", "ok": True}]
        passed, quarantined, failed = gc.partition_results(results, quarantine_active=True)
        self.assertEqual([r["fragment"] for r in passed], ["mobile/flutter"])
        self.assertEqual(quarantined, [])


@unittest.skipUnless(HAVE_NODE and HAVE_KUSTOMIZE, "needs node + kustomize/kubectl")
class MobileIntegrationTests(unittest.TestCase):
    """Proves the assertion catches the REAL shipped mobile fragments, not just a fixture."""

    def setUp(self):
        self.workdir = Path(tempfile.mkdtemp(prefix="green-check-test-mobile-"))

    def tearDown(self):
        shutil.rmtree(self.workdir, ignore_errors=True)

    def test_real_mobile_fragment_is_caught_red(self):
        r = gc.check_fragment("mobile/flutter", self.workdir)
        self.assertFalse(r["ok"], "mobile/flutter's .mobile-ci/build.yaml is not under "
                         ".github/workflows/ — the fragment must be caught RED (F-3/D-058)")
        names = [c["name"] for c in r["checks"]]
        self.assertTrue(any(n.startswith("workflow-reachable") for n in names))
        unreachable = [c for c in r["checks"]
                      if c["name"].startswith("workflow-reachable") and not c["ok"]]
        self.assertTrue(unreachable, "expected a failed workflow-reachable check")
        # The build-file check (file EXISTS) should still PASS — proves this is specifically
        # the NEW reachability gap, not a re-detection of the old exists-check.
        self.assertTrue(all(c["ok"] for c in r["checks"] if c["name"].startswith("build-file")),
                        "the buildWorkflow file does exist; only its LOCATION is wrong")
        # kustomize should still be unaffected — isolates the RED to the workflow path only.
        self.assertTrue(all(c["ok"] for c in r["checks"] if c["name"].startswith("kustomize")),
                        "overlays should still build; only workflow reachability is wrong")


if __name__ == "__main__":
    unittest.main(verbosity=2)
