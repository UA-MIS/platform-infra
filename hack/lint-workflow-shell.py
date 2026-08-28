#!/usr/bin/env python3
"""Every shell body embedded in a workflow must actually PARSE as shell.

WHY THIS EXISTS — a real team was blocked by a single apostrophe.

`UA-MIS/curb-web` was scaffolded and both its first builds failed:

    install: 1: Syntax error: Unterminated quoted string
    job=checks (backend, ...) FAILURE          <- every Python component
    build-and-push / bump-dev / bump-staging: skipped

The cause was one line in the contract's build-and-push.yaml:

    args: >-
      -c 'set -eu;
      ...
      echo "::warning::... AND 'pip install .' failed above. ..."'

The whole `-c` argument is wrapped in SINGLE QUOTES. The apostrophes around
`'pip install .'` close that quoting early, dash sees an unterminated string, and the
step dies before running a single check. A message improvement took out the gate it
was describing.

WHY NOTHING CAUGHT IT. Every guard we had was green: `make validate`, the sync-check,
a 7/7 mutation matrix, a third independent implementation agreeing. None of them
executed the tenant pipeline against a Python component. The gate was not blind to the
defect — NOTHING RAN THE CODE PATH. This file is the cheap fix for that whole class:
it does not need a cluster, a runner, or a tenant. It only needs to try to parse.

THE SUBTLE PART, and the reason a naive version of this check would have passed.
The obvious implementation unwraps the body with a regex like

    re.match(r"-c\\s+'(.*)'", args, re.S)          # WRONG

`.*` is greedy, so it spans from the FIRST quote to the LAST one and swallows the
embedded apostrophes into the body — where they are balanced, and parse fine. That
regex silently repairs the exact defect it is supposed to find. (I know because I had
written one; it is why my own local harness reported these files clean.)

So this does NOT unwrap. It asks the shell's own tokenizer, `shlex.split`, to split
the `args` string the way a runner would. Unbalanced quoting raises ValueError there —
which IS the bug — and only then is the resulting script handed to `sh -n`.

THREE FAILURES, THREE MESSAGES:
  - the argument list itself will not tokenize  -> the quoting bug
  - it tokenizes but the script is not valid sh -> a syntax bug inside the body
  - the file will not read or YAML-parse at all -> the guard's own coverage is gone

That third one is not a courtesy. A shell-parse guard that shrugs at a file it cannot
open keeps counting it as covered, so the summary says "clean" about a file nobody
looked at. Unreadable is a FAILURE here, and the per-file summary below prints what
each file actually contributed so that "clean" can be audited rather than trusted.
"""
from __future__ import annotations

import pathlib
import re
import shlex
import subprocess
import sys

try:
    import yaml
except ImportError:
    print("FAIL: PyYAML is required for this guard (pip install pyyaml).")
    sys.exit(1)

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

# Workflow files whose embedded shell must parse. Named, not discovered: a discovered
# list cannot tell "this file is legitimately gone" from "this file moved and the guard
# stopped looking", and the second must fail.
#
# WHY THE SKELETONS ARE HERE (the widening). The original list was the contract twins
# plus the promotion path — the files curb-web's break came from. But five more workflow
# files carry a docker-action `args:` block in the identical `-c '...'` shape, and four
# of them are SKELETONS: `fetch:template` copies them into a freshly scaffolded student
# repo. That is the same blast radius as the original defect, discovered the same slow
# way — by the student, in their own repo, days later, with nobody watching. A guard that
# covers the contract but not the skeletons covers the copy and not the original.
#
# These skeleton copies are shipped VERBATIM, not rendered: every one of the four
# templates lists `.github/**` under `copyWithoutTemplating`, so nunjucks never touches
# them and what this guard tokenizes is byte-for-byte what the runner executes. (If that
# ever changes, this guard starts checking a different string than the one that runs —
# so the exclusion is load-bearing, not incidental.)
REQUIRED = [
    # The contract twins every tenant's CI is built from, plus the promotion path.
    "platform-services/backstage/templates/_fragments/_contract/.github/workflows/build-and-push.yaml",
    "platform-services/backstage/templates/_fragments/_contract/.github/workflows/promote-to-prod.yaml",
    ".github/workflows/tenant-build.yaml",
    # Scaffolder skeletons — copied verbatim into each new student repo.
    "platform-services/backstage/templates/new-capstone-project/skeleton-multi/.github/workflows/build-and-push.yaml",
    "platform-services/backstage/templates/new-capstone-project-zerotouch/skeleton-multi/.github/workflows/build-and-push.yaml",
    "platform-services/backstage/templates/react-express/skeleton/.github/workflows/build-and-push.yaml",
    "platform-services/backstage/templates/vm-app/skeleton-vm/.github/workflows/build-and-push.yaml",
    # The portal's own image build.
    ".github/workflows/backstage-process-build-push.yaml",
]

EXPR = re.compile(r"\$\{\{[^}]*\}\}")


def placeholder(text: str) -> str:
    """`${{ matrix.context }}` is substituted before any shell sees it. Replace with an
    inert token so the parse is about OUR quoting, not GitHub's."""
    return EXPR.sub("X", text)


def check_script(script: str, shell: str, where: str, problems: list[str]) -> None:
    p = subprocess.run([shell, "-n"], input=script, text=True, capture_output=True)
    if p.returncode != 0:
        problems.append(
            f"{where}\n      the body tokenized, but `{shell} -n` rejects it:\n"
            f"      {p.stderr.strip()}"
        )


def main() -> int:
    problems: list[str] = []
    missing = [r for r in REQUIRED if not (ROOT / r).is_file()]
    if missing:
        print("FAIL: guard input missing — a shell-parse check that cannot find its")
        print("      subject must not report that the subject is clean:")
        for m in missing:
            print(f"       - {m}")
        return 1

    n_args = n_run = 0
    per_file: list[tuple[str, int, int]] = []
    for rel in REQUIRED:
        path = ROOT / rel
        f_args = f_run = 0

        # A file this guard cannot READ or PARSE must be a FAILURE, never a skip.
        # An unreadable file that is quietly passed over is the worst outcome available
        # here: the summary still counts it as covered, so the guard reports coverage it
        # does not have — which is the curb-web failure mode wearing the guard's uniform.
        try:
            doc = yaml.safe_load(placeholder(path.read_text()))
        except (OSError, yaml.YAMLError) as e:
            problems.append(
                f"{rel}\n      COULD NOT BE READ/PARSED, so its shell was never checked: "
                f"{type(e).__name__}: {str(e).splitlines()[0]}\n"
                f"      This is a failure, not a skip — an unparseable subject is not a "
                f"clean subject."
            )
            per_file.append((rel, -1, -1))
            continue
        if not isinstance(doc, dict):
            problems.append(
                f"{rel}\n      parsed, but not into a mapping (got "
                f"{type(doc).__name__}) — it is not a workflow file any more."
            )
            per_file.append((rel, -1, -1))
            continue

        for job_name, job in (doc.get("jobs") or {}).items():
            for i, step in enumerate(job.get("steps") or []):
                if not isinstance(step, dict):
                    continue
                name = str(step.get("name") or f"step[{i}]")[:52]
                where = f"{rel}\n      job '{job_name}', step '{name}'"

                # --- docker:// container-action steps: `args:` -----------------------
                args = (step.get("with") or {}).get("args")
                if isinstance(args, str) and args.strip():
                    n_args += 1
                    f_args += 1
                    try:
                        argv = shlex.split(args)
                    except ValueError as e:
                        problems.append(
                            f"{where}\n      the `args:` string DOES NOT TOKENIZE: {e}\n"
                            f"      Almost always an apostrophe inside the single-quoted -c "
                            f"argument — it closes the quote early and the runner's shell dies "
                            f"with \"Syntax error: Unterminated quoted string\" before running "
                            f"anything. Use a different word, or \"double quotes\", never a bare '."
                        )
                        continue
                    if "-c" in argv:
                        script = argv[argv.index("-c") + 1] if argv.index("-c") + 1 < len(argv) else ""
                        # entrypoint is /bin/sh in every one of these steps, and /bin/sh in
                        # those images is dash or ash — NOT bash. Parse with dash.
                        check_script(script, "dash", where, problems)

                # --- plain `run:` blocks --------------------------------------------
                if isinstance(step.get("run"), str) and step["run"].strip():
                    n_run += 1
                    f_run += 1
                    shell = str(step.get("shell") or "bash")
                    check_script(step["run"], "bash" if "bash" in shell else "dash", where, problems)

        per_file.append((rel, f_args, f_run))

    # PER-FILE, NAMED. The summary used to be a single total across the whole list, and
    # a total cannot be audited: "8 files, 19 args blocks" reads identically whether all
    # eight were parsed or three were parsed and five were silently skipped. Print what
    # each file actually contributed, so the claim of coverage is checkable line by line.
    print(f"  {len(REQUIRED)} workflow file(s), per file:")
    for rel, fa, fr in per_file:
        if fa < 0:
            print(f"      {'UNREADABLE':>7}          {rel}")
        else:
            print(f"      {fa:>3} args, {fr:>3} run   {rel}")
    print(f"  total: {n_args} docker-action `args:` block(s) + {n_run} `run:` block(s)")

    # A file in REQUIRED that yields NOTHING is not a clean file, it is a file this guard
    # is no longer reading — renamed jobs, a restructured `with:`, a `run:` moved into a
    # composite action. Whatever the cause, coverage silently dropped to zero for it while
    # the total stayed comfortably non-zero. Fail per file, not just in aggregate.
    empty = [rel for rel, fa, fr in per_file if fa == 0 and fr == 0]
    if empty:
        print("::error::these REQUIRED workflow files yielded ZERO shell bodies — the guard")
        print("         is not reading what it thinks it is. Refusing to pass:")
        for rel in empty:
            print(f"          - {rel}")
        return 1
    if n_args == 0:
        print("::error::found ZERO `args:` blocks — the workflows changed shape and this")
        print("         guard is no longer reading what it thinks it is. Refusing to pass.")
        return 1
    if problems:
        print(f"FAIL: {len(problems)} embedded shell body(ies) will not parse:")
        for p in problems:
            print(f"    - {p}")
        print("      These fail at RUNTIME, on the tenant's runner, after the workflow has")
        print("      already started — which is why a green `make validate` says nothing")
        print("      about them.")
        return 1
    print("  OK — every embedded shell body tokenizes and parses")
    return 0


if __name__ == "__main__":
    sys.exit(main())
