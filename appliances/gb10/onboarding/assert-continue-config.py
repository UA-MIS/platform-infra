#!/usr/bin/env python3
"""
appliances/gb10/onboarding/assert-continue-config.py

Assert that a config.yaml written by one of the onboarding setup scripts
has the properties it is supposed to have.

This is the STRUCTURAL half of the onboarding test suites: it parses the
file with a real YAML parser and checks the values. The shell/PowerShell
harness around it owns the process-level assertions (exit codes, backups,
byte-identical no-ops, what reached stdout), because those are the things
a harness can see and a parser cannot.

Why a parser and not grep, for both halves:

  * A regex cannot tell `enable_thinking: false` (boolean false, which is
    what vLLM needs) from `enable_thinking: 'false'` (the string, which is
    truthy to most clients and would silently leave reasoning ON, so every
    small-maxTokens role truncates mid-thought). Parsing can, and this
    asserts the TYPE as well as the value.

  * Merging our block into a student's existing config is a line-and-
    indentation operation, so the failure mode is a file that still looks
    right line by line but no longer parses. That is invisible to grep and
    is exactly the defect found in both scripts on 2026-09-30.

Output is one `PASS:`/`FAIL:` line per assertion plus a machine-readable
`FAILID: <scenario>/<assertion>` for each failure, which the mutation
checkers use to confirm a deliberately-broken script trips a SPECIFIC
assertion rather than merely going red.

Exit codes:
  0  every assertion passed
  1  at least one assertion failed (including "not valid YAML")
  3  harness error (bad usage, unreadable file, PyYAML missing)
"""
import argparse
import sys

try:
    import yaml
except ImportError:
    sys.stderr.write("assert-continue-config.py: PyYAML is not installed (pip install pyyaml)\n")
    sys.exit(3)

ENDPOINT = "https://local-llm.uamishub.com/v1"
MODEL_ID = "qwen3.8-27b"

# The properties the config must have. Written out here rather than derived
# from the scripts, because a test that reads its expectations from the code
# under test asserts nothing.
EXPECTED = [
    {"name": "UA MIS Local (Chat)",  "roles": ["chat"],          "max_tokens": 4000},
    {"name": "UA MIS Local (Edit)",  "roles": ["edit", "apply"], "max_tokens": 400},
    {"name": "UA MIS Local (Agent)", "roles": ["agent"],         "max_tokens": 8000},
]


class Asserter(object):
    def __init__(self, scenario):
        self.scenario = scenario
        self.passes = 0
        self.failures = 0

    def ok(self, aid, desc):
        print("PASS: %s/%s -- %s" % (self.scenario, aid, desc))
        self.passes += 1

    def bad(self, aid, desc, detail=None):
        print("FAIL: %s/%s -- %s" % (self.scenario, aid, desc))
        if detail:
            for line in str(detail).splitlines():
                print("    " + line)
        print("FAILID: %s/%s" % (self.scenario, aid))
        self.failures += 1

    def eq(self, aid, desc, expected, actual):
        if expected == actual:
            self.ok(aid, desc)
        else:
            self.bad(aid, desc, "expected: %r\nactual:   %r" % (expected, actual))

    def true(self, aid, desc, cond, detail=None):
        if cond:
            self.ok(aid, desc)
        else:
            self.bad(aid, desc, detail)


def short(name):
    return "".join(c for c in name if c.isalpha())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--key", required=True,
                    help="the exact API key the script was given; asserted to round-trip")
    ap.add_argument("--expect-count", type=int, default=None,
                    help="exact number of model entries expected in the file")
    ap.add_argument("--preserved-name", default=None,
                    help="name of a pre-existing entry that must have survived the merge")
    ap.add_argument("--preserved-key", default=None,
                    help="that entry's own apiKey, which must be untouched")
    ap.add_argument("--expect-top-key", action="append", default=[], metavar="KEY=VALUE",
                    help="an unrelated top-level key that must have survived (repeatable)")
    args = ap.parse_args()

    a = Asserter(args.scenario)

    try:
        with open(args.config, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError as exc:
        a.bad("exists", "config.yaml exists", exc)
        print("\n%d passed, %d failed." % (a.passes, a.failures))
        return 1

    # Assertion one, and the reason this is a parser: is it still YAML at all.
    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        a.bad("yaml", "config.yaml is valid YAML",
              "parser said:\n%s\n--- file as written ---\n%s" % (exc, raw))
        print("\n%d passed, %d failed." % (a.passes, a.failures))
        return 1
    a.ok("yaml", "config.yaml is valid YAML")

    if not isinstance(doc, dict):
        a.bad("mapping", "the document is a mapping", "got %s" % type(doc).__name__)
        print("\n%d passed, %d failed." % (a.passes, a.failures))
        return 1

    models = doc.get("models")
    if not isinstance(models, list):
        a.bad("models-list", "models: is a list", "got %r" % (models,))
        print("\n%d passed, %d failed." % (a.passes, a.failures))
        return 1

    by_name = {}
    for m in models:
        if isinstance(m, dict) and "name" in m:
            by_name[m["name"]] = m

    if args.expect_count is not None:
        a.eq("count", "the file has exactly %d model entries" % args.expect_count,
             args.expect_count, len(models))

    for exp in EXPECTED:
        s = short(exp["name"])
        m = by_name.get(exp["name"])
        if m is None:
            a.bad("entry-" + s, "'%s' entry present" % exp["name"],
                  "models found: %s" % ", ".join(sorted(by_name)))
            continue
        a.ok("entry-" + s, "'%s' entry present" % exp["name"])
        a.eq("provider-" + s, "%s provider is openai" % exp["name"], "openai", m.get("provider"))
        a.eq("model-" + s,    "%s model is %s" % (exp["name"], MODEL_ID), MODEL_ID, m.get("model"))
        a.eq("apibase-" + s,  "%s apiBase is the endpoint" % exp["name"], ENDPOINT, m.get("apiBase"))
        # Key fidelity, byte for byte. An unquoted YAML scalar is where a
        # key silently loses its tail at a " #" or a ": ".
        a.eq("apikey-" + s,   "%s apiKey round-trips exactly" % exp["name"], args.key, m.get("apiKey"))
        a.eq("roles-" + s,    "%s roles are %s" % (exp["name"], exp["roles"]), exp["roles"], m.get("roles"))
        a.eq("maxtok-" + s,   "%s maxTokens is %d" % (exp["name"], exp["max_tokens"]),
             exp["max_tokens"], (m.get("defaultCompletionOptions") or {}).get("maxTokens"))

        et = (((m.get("requestOptions") or {})
               .get("extraBodyProperties") or {})
              .get("chat_template_kwargs") or {})
        if "enable_thinking" not in et:
            a.bad("thinking-" + s, "%s has enable_thinking: false" % exp["name"],
                  "requestOptions.extraBodyProperties.chat_template_kwargs.enable_thinking is absent")
        else:
            v = et["enable_thinking"]
            if not isinstance(v, bool):
                a.bad("thinking-" + s, "%s has enable_thinking: false" % exp["name"],
                      "present but not a YAML boolean; got %s %r" % (type(v).__name__, v))
            elif v is not False:
                a.bad("thinking-" + s, "%s has enable_thinking: false" % exp["name"],
                      "boolean, but true")
            else:
                a.ok("thinking-" + s, "%s has enable_thinking: false (boolean)" % exp["name"])

    # No autocomplete role anywhere: this shared GPU box is deliberately not
    # answering every keystroke.
    ac = [m.get("name") for m in models
          if isinstance(m, dict) and "autocomplete" in (m.get("roles") or [])]
    a.true("no-autocomplete", "no entry declares the autocomplete role", not ac,
           "entries with autocomplete: %s" % ", ".join(str(x) for x in ac))

    if args.preserved_name is not None:
        m = by_name.get(args.preserved_name)
        if m is None:
            a.bad("preserved-entry",
                  "the student's existing '%s' entry survives" % args.preserved_name,
                  "models found: %s" % ", ".join(sorted(by_name)))
        else:
            a.ok("preserved-entry",
                 "the student's existing '%s' entry survives" % args.preserved_name)
            if args.preserved_key is not None:
                a.eq("preserved-key", "the existing entry's own apiKey is untouched",
                     args.preserved_key, m.get("apiKey"))

    for spec in args.expect_top_key:
        k, _, v = spec.partition("=")
        a.eq("topkey-" + k, "unrelated top-level key '%s' survives" % k, v, str(doc.get(k)))

    print("\n%d passed, %d failed." % (a.passes, a.failures))
    return 1 if a.failures else 0


if __name__ == "__main__":
    sys.exit(main())
