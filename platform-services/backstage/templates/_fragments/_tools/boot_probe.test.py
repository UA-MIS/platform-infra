#!/usr/bin/env python3
"""boot_probe.test.py — tests for the GATE-1 boot-and-probe harness (F-6/DSN-001).

Sibling-named after the module it tests (green-check.test.py convention). Run it directly:
  python3 boot_probe.test.py

Two layers:
  - UNIT (always run): the pure logic — no docker needed.
  - INTEGRATION (skipped if docker/podman absent): a REAL MariaDB fixture + REAL containers.
    Uses hand-built, MINIMAL Dockerfiles (not a real fragment) so these tests stay correct
    regardless of any particular fragment's fix status over time — the "broken" case is a
    synthetic crash-on-start image, not "whatever fragment happens to be unfixed today".
"""
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import boot_probe  # noqa: E402

HAVE_DOCKER = boot_probe.DOCKER_CMD is not None


class PureLogicTests(unittest.TestCase):
    def test_probe_budget_matches_the_real_chart_startup_probe(self):
        # This constant pairing IS the fidelity contract with
        # _contract/.devops/chart/base/deployments.yaml's startupProbe
        # (periodSeconds: 2, failureThreshold: 30) — if the chart ever changes that budget,
        # this assertion is the tripwire reminding a future editor to update both.
        self.assertEqual(boot_probe.PROBE_PERIOD_SECONDS, 2)
        self.assertEqual(boot_probe.PROBE_FAILURE_THRESHOLD, 30)
        self.assertEqual(boot_probe.PROBE_PERIOD_SECONDS * boot_probe.PROBE_FAILURE_THRESHOLD, 60)


@unittest.skipUnless(HAVE_DOCKER, "needs docker or podman")
class MariaDBFixtureTests(unittest.TestCase):
    """One shared fixture for the whole class — starting MariaDB is the slow part."""

    @classmethod
    def setUpClass(cls):
        cls.mariadb = boot_probe.MariaDBFixture.start()

    @classmethod
    def tearDownClass(cls):
        cls.mariadb.stop()

    def test_make_database_is_idempotent_per_call(self):
        # Two fragments' worth of provisioning against the SAME shared server must not
        # collide — this is the property that makes sharing one MariaDB across a whole
        # sweep safe (see boot_probe.py's module docstring).
        self.mariadb.make_database("gate1_test_db_a", "gate1_test_user_a", "pw-a")
        self.mariadb.make_database("gate1_test_db_b", "gate1_test_user_b", "pw-b")
        # No exception = pass; a second identical call must also not raise (CREATE ... IF
        # NOT EXISTS semantics).
        self.mariadb.make_database("gate1_test_db_a", "gate1_test_user_a", "pw-a")


@unittest.skipUnless(HAVE_DOCKER, "needs docker or podman")
class BootProbeComponentTests(unittest.TestCase):
    """Synthetic, hand-built minimal images — deliberately NOT a real fragment, so these
    stay correct regardless of any fragment's fix status changing over time."""

    @classmethod
    def setUpClass(cls):
        cls.mariadb = boot_probe.MariaDBFixture.start()

    @classmethod
    def tearDownClass(cls):
        cls.mariadb.stop()

    def setUp(self):
        self.workdir = Path(tempfile.mkdtemp(prefix="boot-probe-test-"))

    def tearDown(self):
        shutil.rmtree(self.workdir, ignore_errors=True)

    def test_healthy_container_passes(self):
        # A minimal stdlib HTTP server that answers 200 on /healthz immediately, independent
        # of the DATABASE_URL it's handed (mirrors blank/bring-your-own's real contract:
        # needsDb wiring is EFFECTIVE, but a correct app degrades gracefully).
        ctx = self.workdir / "healthy"
        ctx.mkdir()
        (ctx / "app.py").write_text(textwrap.dedent("""\
            import http.server, os
            class H(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path == "/healthz":
                        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
                    else:
                        self.send_response(404); self.end_headers()
                def log_message(self, *a): pass
            http.server.HTTPServer(("0.0.0.0", int(os.environ.get("PORT", 8080))), H).serve_forever()
            """))
        (ctx / "Dockerfile").write_text(
            "FROM python:3.12-slim\nCOPY app.py .\nCMD [\"python3\", \"app.py\"]\n")
        comp = {"name": "app", "context": "healthy", "dockerfile": "Dockerfile", "port": 8080}

        ok, detail = boot_probe.boot_probe_component(comp, self.workdir, self.mariadb)
        self.assertTrue(ok, f"expected the healthy synthetic image to pass, got: {detail}")
        self.assertIn("healthy after", detail)

    def test_crash_on_start_container_is_caught_fast(self):
        # Proves the harness catches a non-booting image WITHOUT waiting out the full 60s
        # budget (the fast-exit-detection path in _probe_healthz).
        ctx = self.workdir / "broken"
        ctx.mkdir()
        (ctx / "Dockerfile").write_text(
            "FROM python:3.12-slim\n"
            "CMD [\"python3\", \"-c\", \"import sys; sys.exit(1)\"]\n"
        )
        comp = {"name": "app", "context": "broken", "dockerfile": "Dockerfile", "port": 8080}

        import time
        t0 = time.time()
        ok, detail = boot_probe.boot_probe_component(comp, self.workdir, self.mariadb)
        elapsed = time.time() - t0

        self.assertFalse(ok, "a crash-on-start image must be caught RED")
        self.assertIn("exited", detail)
        self.assertIn("container logs", detail)
        self.assertLess(elapsed, 30, "fast-exit detection should not wait out the full 60s budget")

    def test_build_failure_is_reported_not_raised(self):
        # A Dockerfile that fails to BUILD (not just fails to boot) must be a finding
        # (False, detail), not an unhandled exception — the caller's per-fragment loop
        # relies on this.
        ctx = self.workdir / "unbuildable"
        ctx.mkdir()
        (ctx / "Dockerfile").write_text("FROM this-image-does-not-exist-anywhere:latest\n")
        comp = {"name": "app", "context": "unbuildable", "dockerfile": "Dockerfile", "port": 8080}

        ok, detail = boot_probe.boot_probe_component(comp, self.workdir, self.mariadb)
        self.assertFalse(ok)
        self.assertIn("image build failed", detail)


if __name__ == "__main__":
    unittest.main(verbosity=2)
