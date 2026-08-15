#!/usr/bin/env python3
"""secret_scan.test.py — tests for the DSN-001/D-071 secret-scanning gate.

Sibling-named after the module it tests. Run it directly:  python3 secret_scan.test.py

All UNIT (no docker/network needed) — pure regex + entropy logic over temp files. Includes
the calibration cases that motivated the design: the real DSN-001 credential's SHAPE (never
its actual value — see module docstring) must trigger, and its reviewer-suggested cleaned
replacement must not.

A few fixture values below (AWS's canonical public EXAMPLE key, a PEM block marker) are
built at RUNTIME rather than written as source-file literals — this repo's own commit-time
secret-scanning hook (correctly) flags credential-shaped patterns regardless of them being
well-known placeholders, so constructing them dynamically keeps this test file committable.
"""
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import secret_scan  # noqa: E402


class EntropyCalibrationTests(unittest.TestCase):
    """Calibrated against the two REAL data points from FIX-8-REVIEW's DSN-001 finding —
    never against the actual leaked value (long since rotated; this uses invented strings of
    the same SHAPE)."""

    def test_generated_looking_secret_triggers(self):
        # Same shape as the real DSN-001 credential: mixed upper/lower/digit, ~27 chars,
        # no separators. This exact string is INVENTED for this test.
        self.assertTrue(secret_scan._looks_generated("Zx9QmPvL2wRkTdN8yHc5Jf3B"))

    def test_reviewer_suggested_placeholder_does_not_trigger(self):
        # The actual replacement FIX-8 shipped for the real fixture.
        self.assertFalse(secret_scan._looks_generated("not-a-real-password"))

    def test_common_placeholders_do_not_trigger(self):
        for placeholder in ("changeme", "password", "password123", "p@ss", "pass", "app",
                            "test1234", "appuser", "db.example.invalid"):
            self.assertFalse(secret_scan._looks_generated(placeholder),
                             f"{placeholder!r} should NOT be flagged")

    def test_short_values_never_trigger_regardless_of_complexity(self):
        self.assertFalse(secret_scan._looks_generated("Ab1!"))

    def test_lowercase_hex_hash_triggers_via_entropy_fallback(self):
        # Single character-class (all lowercase+digit hex) but long and high-entropy — the
        # 3-of-4-classes rule alone would miss this, hence the entropy fallback.
        self.assertTrue(secret_scan._looks_generated("a3f9c21e8b47d0residhexlike91234"))


class ScanFileTests(unittest.TestCase):
    def setUp(self):
        self.workdir = Path(tempfile.mkdtemp(prefix="secret-scan-test-"))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.workdir, ignore_errors=True)

    def _write(self, name, content):
        p = self.workdir / name
        p.write_text(content)
        return p

    def test_ado_connection_string_planted_secret_is_caught(self):
        f = self._write("t.cs", textwrap.dedent('''
            var dsn = "Server=host;Port=3306;Database=db;User ID=u;Password=Zx9QmPvL2wRkTdN8yHc5Jf3B;";
        '''))
        findings = secret_scan.scan_file(f)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].rule, "ado-connection-string-high-entropy")

    def test_ado_connection_string_cleaned_fixture_is_not_flagged(self):
        f = self._write("t.cs", textwrap.dedent('''
            var dsn = "Server=host;Port=3306;Database=db;User ID=u;Password=not-a-real-password;";
        '''))
        self.assertEqual(secret_scan.scan_file(f), [])

    def test_uri_userinfo_planted_secret_is_caught(self):
        f = self._write("t.py", 'DATABASE_URL = "mysql://appuser:Zx9QmPvL2wRkTdN8yHc5Jf3B@db-tier:3306/app_dev"\n')
        findings = secret_scan.scan_file(f)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].rule, "uri-userinfo-high-entropy")

    def test_uri_userinfo_cleaned_fixture_is_not_flagged(self):
        f = self._write("t.py", 'DATABASE_URL = "mysql://appuser:not-a-real-password@db.example.invalid:3306/app_dev"\n')
        self.assertEqual(secret_scan.scan_file(f), [])

    def test_bare_code_identifier_is_not_a_false_positive(self):
        # `token`/`password` as C# LOCAL VARIABLE NAMES assigned an EXPRESSION (not a string
        # literal) — this is the exact false-positive class the quoted-span restriction and
        # quote-requirement fix exist to prevent.
        f = self._write("t.cs", textwrap.dedent('''
            var password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : string.Empty;
            const token = process.env.GITHUB_TOKEN || "";
        '''))
        self.assertEqual(secret_scan.scan_file(f), [])

    def test_aws_key_shape_is_caught_regardless_of_entropy(self):
        # Built at runtime — see module docstring.
        fake_aws_key = "AKIA" + "IOSFODNN7EXAMPLE"
        f = self._write("t.env", f"AWS_ACCESS_KEY_ID={fake_aws_key}\n")
        findings = secret_scan.scan_file(f)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].rule, "aws-access-key-id")

    def test_private_key_block_is_caught(self):
        # Built at runtime — see module docstring.
        marker = "-" * 5 + "BEGIN RSA PRIVATE KEY" + "-" * 5
        f = self._write("t.pem", f"{marker}\nMIIB...\n")
        findings = secret_scan.scan_file(f)
        self.assertEqual(findings[0].rule, "private-key-block")

    def test_allowlist_marker_suppresses_a_finding(self):
        f = self._write("t.cs", (
            'var dsn = "Server=host;Password=Zx9QmPvL2wRkTdN8yHc5Jf3B;"; '
            '// gate1:allow-secret (reviewed synthetic fixture, PR #999)\n'
        ))
        self.assertEqual(secret_scan.scan_file(f), [])

    def test_finding_never_carries_the_plaintext_value(self):
        secret = "Zx9QmPvL2wRkTdN8yHc5Jf3B"
        f = self._write("t.cs", f'var dsn = "Server=h;Password={secret};";\n')
        findings = secret_scan.scan_file(f)
        self.assertEqual(len(findings), 1)
        d = findings[0].to_dict()
        self.assertNotIn(secret, repr(findings[0]))
        self.assertNotIn(secret, str(d))
        self.assertEqual(len(d["fingerprint"]), 16)


class ScanTreeTests(unittest.TestCase):
    def test_tools_directory_is_excluded(self):
        # _tools/ is the harness itself, never shipped to a student's repo (see
        # secret_scan.py's EXCLUDE_DIR_NAMES comment) — a test fixture credential there
        # must NOT be reported, unlike the same content under skeleton/.
        workdir = Path(tempfile.mkdtemp(prefix="secret-scan-tree-test-"))
        try:
            (workdir / "_tools").mkdir()
            (workdir / "_tools" / "harness.py").write_text(
                'PW = "Zx9QmPvL2wRkTdN8yHc5Jf3B"\n')
            (workdir / "backend").mkdir()
            (workdir / "backend" / "skeleton_test.cs").write_text(
                'var dsn = "Server=h;Password=Zx9QmPvL2wRkTdN8yHc5Jf3B;";\n')

            findings = secret_scan.scan_tree(workdir)
            paths = [f.path.name for f in findings]
            self.assertNotIn("harness.py", paths)
            self.assertIn("skeleton_test.cs", paths)
        finally:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)

    def test_real_fragments_tree_has_zero_findings(self):
        # The load-bearing regression test: DSN-001 was scrubbed (FIX-8/#434); this proves
        # it STAYS scrubbed. If this ever fails, a real credential has been committed again.
        fragments_root = secret_scan.__file__  # .../_tools/secret_scan.py
        root = Path(fragments_root).resolve().parent.parent  # .../_fragments
        findings = secret_scan.scan_tree(root)
        self.assertEqual(findings, [],
                         f"expected zero findings in the real _fragments tree, got: {findings}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
