#!/usr/bin/env python3
"""
appliances/gb10/onboarding/yaml-to-json.py

Parse a YAML file with a REAL YAML parser and emit it as JSON on stdout.

This exists so test-setup-windows.ps1 can assert on the STRUCTURE of the
config.yaml that setup-windows.ps1 writes, rather than grepping it. Two
reasons that matters:

  1. A regex cannot tell "enable_thinking: false" (boolean false, which
     is what vLLM needs) from "enable_thinking: 'false'" (the string
     "false", which is truthy in most clients and would silently leave
     thinking ON). Parsing can: JSON preserves the distinction, so the
     caller can assert the type as well as the value.

  2. Merging our block into a student's existing config.yaml is a
     line-and-indentation operation. The failure mode is a file that
     still LOOKS right line by line but no longer parses as YAML --
     which is exactly what a grep-based test cannot see. Running the
     file through a parser makes "is this still valid YAML" the first
     assertion, for free.

Exit codes:
  0  parsed; JSON written to stdout
  2  the file is not valid YAML (message on stderr) -- this is a real
     test failure signal, not a harness error
  3  the file could not be read, or PyYAML is missing (harness error)
"""
import json
import sys

try:
    import yaml
except ImportError:
    sys.stderr.write("yaml-to-json.py: PyYAML is not installed (pip install pyyaml)\n")
    sys.exit(3)


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: yaml-to-json.py <file.yaml>\n")
        return 3
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError as exc:
        sys.stderr.write("yaml-to-json.py: cannot read %s: %s\n" % (path, exc))
        return 3
    try:
        # safe_load, not load: this parses a file we are testing, and a
        # test harness must never be a code-execution path.
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        sys.stderr.write("INVALID YAML: %s\n" % exc)
        return 2
    json.dump(doc, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
