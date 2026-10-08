#!/usr/bin/env python3
"""Prove the keyportal suite actually catches a broken app.py.

A CI job that passes against broken code is worse than no job, because it
manufactures confidence. This is the same idea as the (now retired) two onboarding
retired onboarding suites' --mutation-check, deliberately kept much smaller: a table of exact
find/replace pairs plus a loop, not a harness. The onboarding suites need
a harness because they drive an external interpreter and parse its output;
here pytest already is the harness.

Each mutation names the test it MUST newly break. A mutation that survives,
or that only breaks something unrelated, fails this script -- that is a gap
in the assertions, not a pass. Mutations are judged by the failures they
ADD on top of the unmodified suite's baseline, so a real open defect cannot
mask one.

Every mutation is applied to a COPY of the keyportal directory in a temp
dir, never to the working tree. An earlier hand-run of these same
mutations restored app.py with `cp` between runs, which is one crashed
process away from leaving a mutated app.py behind and committing it.

The mutations chosen are all SILENT failures -- each one leaves a service
that starts, serves 200s, and looks right. That is the only class worth
spending a CI job on; a mutation that crashes on import needs no test to
find it.

Usage:
  python3 tests/mutation-check.py          # from appliances/gb10/keyportal
  python3 tests/mutation-check.py --list   # print the table and exit
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEYPORTAL = HERE.parent

# find/replace bodies are the literal text of app.py so they can be read and
# checked by eye. An anchor MUST match exactly once -- an ambiguous anchor
# fails the mutation rather than silently patching the wrong site.
MUTATIONS = [
    {
        "id": "M1-trust-the-email-header",
        "why": (
            "Authentication bypass: the student page trusts "
            "Cf-Access-Authenticated-User-Email instead of verifying the "
            "signed assertion, so anyone who can reach the port can name "
            "any student and be shown that student's key."
        ),
        "find": "def index(request: Request) -> HTMLResponse:\n"
        "    email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)",
        "repl": "def index(request: Request) -> HTMLResponse:\n"
        '    email = request.headers.get("Cf-Access-Authenticated-User-Email", "")',
        "expect": r"without_jwt_assertion_returns_401",
    },
    {
        "id": "M2-let-cloudflare-cache-the-key",
        "why": (
            "Worst-case cross-student leak: the page embeds the student's "
            "live key and Cloudflare sits in front of this service, so a "
            "cached copy of one student's page served to another hands out a "
            "working key under someone else's identity."
        ),
        "find": 'headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, private"},',
        "repl": 'headers={"Cache-Control": "public, max-age=3600"},',
        "expect": r"index_active_user_sees_key_and_config|index_first_time_visit",
    },
    {
        "id": "M3-unquote-the-apikey",
        "why": (
            "Silent truncation: the apiKey scalar goes back to being "
            "unquoted, so a key containing ' #' is cut off at the comment "
            "marker. Valid YAML, wrong key, opaque 401."
        ),
        "find": """    return "'" + value.replace("'", "''") + "'\"""",
        "repl": "    return value",
        "expect": r"substitutes_the_key_exactly",
    },
    {
        "id": "M4-accept-control-characters-in-a-key",
        "why": (
            "YAML injection: a newline in a key adds arbitrary lines to the "
            "config block a student pastes into their editor."
        ),
        "find": "        if _KEY_FORBIDDEN_CHARS_RE.search(api_key):",
        "repl": "        if False:",
        "expect": r"refuses_empty_or_control_char_key",
    },
    {
        "id": "M5-regress-the-agent-role",
        "why": (
            "The original defect: the Agent entry goes back to `roles: "
            "[agent]`, which Continue rejects (config fails to load). Must "
            "trip the valid-roles invariant, not a literal compare."
        ),
        "find": '    roles: [chat]\n    # "agent" is NOT a Continue role',
        "repl": '    roles: [agent]\n    # "agent" is NOT a Continue role',
        "expect": r"only_roles_continue_accepts",
    },
    {
        "id": "M6-drop-tool-use",
        "why": (
            "Agent mode silently lost: the Agent entry stops declaring "
            "tool_use, so Continue never offers agent mode on it. Valid "
            "YAML, valid roles."
        ),
        "find": "    capabilities:\n      - tool_use\n",
        "repl": "",
        "expect": r"agent_entry_declares_tool_use",
    },
    {
        "id": "M7-stop-escaping-the-email",
        "why": "Unescaped interpolation of the signed-in email into HTML.",
        "find": "<p>Signed in as <strong>{escape(email)}</strong>.</p>\n<section",
        "repl": "<p>Signed in as <strong>{email}</strong>.</p>\n<section",
        "expect": r"escape_email_and_admin_contact",
    },
    {
        "id": "M8-expose-the-openapi-schema",
        "why": (
            "Publishes every /admin* route and its exact form field names "
            "to any signed-in student. Mutated to the PARTIAL fix (docs and "
            "redoc off, schema still served) rather than to a full "
            "re-enable, because the partial one is the mistake somebody "
            "would actually make and it looks fixed."
        ),
        "find": "app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)",
        "repl": "app = FastAPI(docs_url=None, redoc_url=None)",
        "expect": r"openapi_surface_is_not_exposed",
    },
    {
        "id": "M9-show-a-pending-student-their-key",
        "why": (
            "A not-yet-activated student's real key is rendered on the page "
            "instead of the placeholder."
        ),
        "find": "block_html = escape(_manual_config_block(key if active else None, header=False))",
        "repl": "block_html = escape(_manual_config_block(key, header=False))",
        "expect": r"pending_page_block_has_placeholder",
    },
]


def run_pytest(directory: Path) -> tuple:
    """Run the suite against a staged copy. Returns (bad_node_ids, passed).

    Counts ERROR as well as FAILED. This is not pedantry: the first version
    of this script matched only `^FAILED`, and because the staging bug
    below left app.py unable to import, every single test ERRORed -- which
    that regex saw as an empty set, i.e. "the suite passed". All eight
    mutations were reported as SURVIVED, including ones already verified by
    hand. A mutation checker that reads "nothing ran" as "everything
    passed" is exactly the manufactured confidence it exists to prevent, so
    an import error must read as loudly as a failed assertion.

    `passed` is returned so main() can assert the baseline really executed
    the suite rather than collecting nothing -- the other half of that same
    bug, which made the baseline read GREEN for the wrong reason.
    """
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "tests/test_app.py",
            "-q",
            "--no-header",
            "--tb=no",
            "-p",
            "no:cacheprovider",
        ],
        cwd=directory,
        capture_output=True,
        text=True,
    )
    if "INTERNALERROR" in proc.stdout + proc.stderr:
        sys.stderr.write(proc.stdout + proc.stderr)
        raise SystemExit("HARNESS ERROR: pytest crashed rather than reporting")
    bad = set(re.findall(r"^(?:FAILED|ERROR) (\S+)", proc.stdout, re.MULTILINE))
    match = re.search(r"(\d+) passed", proc.stdout)
    return bad, int(match.group(1)) if match else 0


def stage(tmp: Path, mutation=None) -> Path:
    """Stage a runnable copy of the appliance layout and optionally apply a
    mutation. Returns the directory to run pytest from.

    Copies keyportal/ only (app.py reads nothing outside its own directory).

    Never touches the working tree. An earlier hand-run of these same
    mutations edited app.py in place and restored it with `cp`, which is one
    crashed process away from committing a mutated app.py.
    """
    root = tmp / (mutation["id"] if mutation else "baseline")
    ignore = shutil.ignore_patterns("__pycache__", ".pytest_cache", "*.db")
    shutil.copytree(KEYPORTAL, root / KEYPORTAL.name, ignore=ignore)
    dest = root / KEYPORTAL.name
    if mutation is None:
        return dest
    target = dest / "app.py"
    text = target.read_text(encoding="utf-8")
    found = text.count(mutation["find"])
    if found != 1:
        raise SystemExit(
            f"MUTANT-ERROR: {mutation['id']} -- anchor matched {found} times "
            "(need exactly 1). The mutation could not be applied, so it "
            "proves nothing. Update its `find` body in tests/mutation-check.py "
            "to match the current app.py."
        )
    target.write_text(
        text.replace(mutation["find"], mutation["repl"], 1), encoding="utf-8"
    )
    return dest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true", help="print the table and exit")
    args = parser.parse_args()

    if args.list:
        for m in MUTATIONS:
            print(f"{m['id']}\n    expects: {m['expect']}\n    {m['why']}\n")
        return 0

    print("=== Mutation check: does the keyportal suite catch broken code? ===\n")
    with tempfile.TemporaryDirectory(prefix="keyportal-mut-") as tmpdir:
        tmp = Path(tmpdir)

        print("--- baseline: the suite against UNMODIFIED app.py ---")
        baseline, passed = run_pytest(stage(tmp))
        # The guard that would have caught this script's own first bug: a
        # baseline of "0 failures" means nothing unless the suite actually
        # ran. Staged wrong, it collected 230 import errors and reported an
        # empty failure set, which read as a clean baseline.
        if passed < 100:
            raise SystemExit(
                f"HARNESS ERROR: baseline ran only {passed} passing test(s). "
                "The suite is not being executed properly (staging, imports, "
                "or missing dev dependencies) -- refusing to report mutation "
                "results that would be meaningless."
            )
        print(f"baseline: {passed} test(s) passed.")
        if baseline:
            print(
                f"baseline: suite is RED with {len(baseline)} pre-existing failure(s):"
            )
            for node in sorted(baseline):
                print(f"    {node}")
            print(
                "(Mutations are judged by the failures they ADD on top of this "
                "baseline, so a real open defect does not mask a mutation.)"
            )
        print()

        failed = 0
        for mutation in MUTATIONS:
            print(f"--- {mutation['id']} ---")
            print(f"    {mutation['why']}")
            ids, _ = run_pytest(stage(tmp, mutation))
            added = sorted(ids - baseline)
            hit = [node for node in added if re.search(mutation["expect"], node)]
            if not ids:
                print(
                    f"MUTANT-SURVIVED: {mutation['id']} -- the suite PASSED "
                    "against broken code. The assertions have a gap."
                )
                failed += 1
            elif not added:
                print(
                    f"MUTANT-SURVIVED: {mutation['id']} -- the suite failed, "
                    "but only with the baseline failures, so this mutation "
                    "was not detected."
                )
                failed += 1
            elif not hit:
                print(
                    f"MUTANT-MISDETECTED: {mutation['id']} -- failures were "
                    f"added, but none matching {mutation['expect']}."
                )
                print(f"    added: {', '.join(added)}")
                failed += 1
            else:
                print(
                    f"MUTANT-CAUGHT: {mutation['id']} -- newly tripped: {', '.join(hit)}"
                )
            print()

    total = len(MUTATIONS)
    print(f"=== Mutation check: {total - failed}/{total} mutations caught ===")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
