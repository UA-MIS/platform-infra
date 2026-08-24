#!/usr/bin/env python3
"""Catch Go-template syntax errors in the Composition's inline template.

WHY THIS EXISTS: `kubectl apply --dry-run=server` validates the Composition
OBJECT against its CRD schema and passes happily -- to the API server the
`template:` field is just an opaque string. The Go template inside it is not
parsed until Crossplane's function-go-templating runs, which is AFTER merge, in
the cluster, against every tenant.

That gap bit us: a `{{- /* ... */}}` comment placed between `list` and its first
`(dict ...)` operand is INSIDE an action, and Go templates cannot nest an action
inside an action. The Composition applied cleanly, then every tenant render
failed with:

    pipeline step "render-tenant" returned a fatal result:
    cannot parse the provided templates:
    template: manifests:49: unexpected "{" in operand

This checks the one thing the API server cannot: that actions are balanced and
never nested.

NOTE the backtick subtlety. This Composition deliberately emits a SECOND template
for ArgoCD to evaluate later, escaped as {{ `{{- ... }}` }}. Those inner braces
sit inside a Go raw-string literal and are perfectly legal, so the scanner must
treat backtick- and quote-delimited spans as opaque. A naive brace counter
reports dozens of false positives here.

    python3 validate-composition-template.py composition.yaml
"""
import sys
import yaml


def find_templates(node, out):
    """Collect every long inline `template:` string in the document."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "template" and isinstance(value, str) and "{{" in value:
                out.append(value)
            else:
                find_templates(value, out)
    elif isinstance(node, list):
        for item in node:
            find_templates(item, out)
    return out


def check(template):
    """Return a list of (line, column, message) problems."""
    problems = []
    i, line, col = 0, 1, 1
    in_action = False
    action_start = None
    quote = None  # active string delimiter inside an action

    while i < len(template):
        ch = template[i]
        nxt = template[i + 1] if i + 1 < len(template) else ""

        if ch == "\n":
            line, col = line + 1, 1
            i += 1
            continue

        if in_action and quote:
            # Inside a string literal: nothing is special except the closer.
            # Go raw strings (backticks) have no escapes; interpreted strings do.
            if quote == '"' and ch == "\\":
                i, col = i + 2, col + 2
                continue
            if ch == quote:
                quote = None
            i, col = i + 1, col + 1
            continue

        if in_action and ch in ('"', "`"):
            quote = ch
            i, col = i + 1, col + 1
            continue

        if ch == "{" and nxt == "{":
            # Check nesting FIRST. A comment opened while an action is still open
            # is precisely the bug this script exists to catch -- skipping the
            # comment before testing `in_action` would step right over it.
            if in_action:
                problems.append((line, col,
                                 f"nested action: '{{{{' opened while the action from "
                                 f"line {action_start} is still open. Go templates "
                                 f"cannot nest an action inside an action -- move the "
                                 f"comment or expression outside."))
            # Comment action: {{/* ... */}} or {{- /* ... */}}. Go's lexer treats
            # everything between /* and */ as opaque, so prose inside a comment may
            # legitimately contain '{{ $team }}' -- this Composition does exactly
            # that in several places. Skip the whole comment or we report it as a
            # nested action.
            probe = i + 2
            while probe < len(template) and template[probe] in "- \t":
                probe += 1
            if template.startswith("/*", probe):
                end = template.find("*/", probe)
                if end == -1:
                    problems.append((line, col, "unterminated template comment"))
                    break
                close = template.find("}}", end)
                if close == -1:
                    problems.append((line, col, "template comment never closes with '}}'"))
                    break
                skipped = template[i:close + 2]
                line += skipped.count("\n")
                col = len(skipped) - (skipped.rfind("\n") + 1) if "\n" in skipped else col + len(skipped)
                i = close + 2
                continue

            in_action = True
            action_start = line
            i, col = i + 2, col + 2
            continue

        if ch == "}" and nxt == "}":
            if not in_action:
                problems.append((line, col, "stray '}}' with no open action"))
            in_action = False
            i, col = i + 2, col + 2
            continue

        i, col = i + 1, col + 1

    if in_action:
        problems.append((action_start, 0, "unterminated action -- no closing '}}'"))
    return problems


def main():
    if len(sys.argv) < 2:
        print("usage: validate-composition-template.py <composition.yaml>", file=sys.stderr)
        return 2
    failed = False
    for path in sys.argv[1:]:
        with open(path) as handle:
            doc = yaml.safe_load(handle)
        templates = find_templates(doc, [])
        if not templates:
            print(f"{path}: no inline templates found", file=sys.stderr)
            continue
        for index, template in enumerate(templates):
            problems = check(template)
            label = f"{path} (template #{index + 1}, {len(template.splitlines())} lines)"
            if problems:
                failed = True
                print(f"FAIL {label}")
                for ln, cl, msg in problems:
                    print(f"  line {ln}, col {cl}: {msg}")
            else:
                print(f"ok   {label}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
