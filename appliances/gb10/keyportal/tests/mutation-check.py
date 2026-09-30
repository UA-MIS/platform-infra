#!/usr/bin/env python3
"""Prove the keyportal suite actually catches a broken app.py.

A CI job that passes against broken code is worse than no job, because it
manufactures confidence. This is the same idea as the two onboarding
suites' --mutation-check, deliberately kept much smaller: a table of exact
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
            "Authentication bypass: the download route trusts "
            "Cf-Access-Authenticated-User-Email instead of verifying the "
            "signed assertion, so anyone who can reach the port can name "
            "any student and be handed that student's key."
        ),
        "find": "    email = verify_access_jwt(request, CONFIG, JWKS_CLIENT)\n"
        "    key = get_cached_key(CONFIG.db_path, email)\n"
        "    if key is None:\n"
        "        key = issue_initial_key(CONFIG, email)\n"
        "    key, _team_id = _team_id_for_key_or_reissue(CONFIG, email, key)\n"
        "    body = _substitute_embedded_key(",
        "repl": '    email = request.headers.get("Cf-Access-Authenticated-User-Email", "")\n'
        "    key = get_cached_key(CONFIG.db_path, email)\n"
        "    if key is None:\n"
        "        key = issue_initial_key(CONFIG, email)\n"
        "    key, _team_id = _team_id_for_key_or_reissue(CONFIG, email, key)\n"
        "    body = _substitute_embedded_key(",
        "expect": r"without_jwt_assertion_returns_401",
    },
    {
        "id": "M2-log-the-key",
        "why": (
            "Credential leak: a friendly log line puts the raw key in "
            "stderr, and from there in `docker compose logs`. This portal "
            "already had one leak of this shape (F4, a raw key in a "
            "/key/info query parameter, fixed by hashing)."
        ),
        "find": "    body = _substitute_embedded_key(SETUP_SCRIPT_SOURCES[spec.slug], spec, key)",
        "repl": '    print(f"serving {spec.slug} to {email} ({key})", file=sys.stderr)\n'
        "    body = _substitute_embedded_key(SETUP_SCRIPT_SOURCES[spec.slug], spec, key)",
        "expect": r"never_logs_the_key",
    },
    {
        "id": "M3-let-cloudflare-cache-the-key",
        "why": (
            "Worst-case cross-student leak: the response body is a bearer "
            "credential and Cloudflare sits in front of this service, so a "
            "cached copy of one student's script served to another hands "
            "out a working key under someone else's identity."
        ),
        "find": '            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, private",',
        "repl": '            "Cache-Control": "public, max-age=3600",',
        "expect": r"is_never_cached",
    },
    {
        "id": "M4-powershell-quoting-in-the-shell-literal",
        "why": (
            "Silent wrong key: POSIX shell needs '\\'' and PowerShell needs "
            "'' for a literal quote. Using the PowerShell rule in a shell "
            "literal does not error -- it concatenates two adjacent "
            "literals and DELETES the quote, producing a valid-looking "
            "config.yaml, a wrong key, and an opaque 401."
        ),
        "find": """    return "'" + value.replace("'", "'\\\\''") + "'\"""",
        "repl": """    return "'" + value.replace("'", "''") + "'\"""",
        "expect": r"round_trips_through_real_bash|actually_configures_continue",
    },
    {
        "id": "M5-accept-control-characters-in-a-key",
        "why": (
            "Code injection into a file a student executes: the "
            "substitution is line-oriented, so a newline in a key adds a "
            "line of shell/PowerShell to the served script."
        ),
        "find": "    bad = _KEY_FORBIDDEN_CHARS_RE.search(key)",
        "repl": "    bad = None",
        "expect": r"refuses_a_key_that_would_break_the_line",
    },
    {
        "id": "M6-serve-inline-instead-of-attachment",
        "why": (
            "Renders a student's own key as a wall of text in a browser tab "
            "they may then leave open on a shared lab machine, instead of "
            "downloading a file."
        ),
        "find": '            "Content-Disposition": f\'attachment; filename="{spec.download_filename}"\',',
        "repl": '            "Content-Disposition": f\'inline; filename="{spec.download_filename}"\',',
        "expect": r"serves_the_signed_in_students_own_key",
    },
    {
        "id": "M7-skip-the-marker-validation",
        "why": (
            "Removes the startup contract: a renamed EMBEDDED_KEY in the "
            "onboarding script would then be served to every student as a "
            "script with no key in it and an interactive prompt they were "
            "told they would not see -- silently, for as long as nobody "
            "looks."
        ),
        "find": "        _validate_setup_script(spec, text)\n        sources[slug] = text",
        "repl": "        sources[slug] = text",
        # NOT marker_line_has_drifted: that test calls
        # _validate_setup_script() directly, so it stays green when the CALL
        # to it is deleted from load_setup_scripts() -- which is how this
        # mutation survived on its first run. The test that catches this one
        # has to exercise the loader itself.
        "expect": r"actually_validates_what_it_loads",
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

    Copies BOTH keyportal/ and onboarding/, preserving their relative
    positions, because app.py's _resolve_onboarding_dir() finds the setup
    scripts at ../onboarding in the repo layout and refuses to start
    without them. Staging keyportal/ alone was the first version's bug: the
    app raised at import, every test ERRORed, and the checker reported all
    eight mutations as survivors -- the baseline included, which read GREEN
    on a suite that had executed nothing.

    Never touches the working tree. An earlier hand-run of these same
    mutations edited app.py in place and restored it with `cp`, which is one
    crashed process away from committing a mutated app.py.
    """
    root = tmp / (mutation["id"] if mutation else "baseline")
    ignore = shutil.ignore_patterns("__pycache__", ".pytest_cache", "*.db")
    shutil.copytree(KEYPORTAL, root / KEYPORTAL.name, ignore=ignore)
    shutil.copytree(KEYPORTAL.parent / "onboarding", root / "onboarding", ignore=ignore)
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
