#!/usr/bin/env python3
"""db-tier reachability guard — `make validate` [13/13].

WHY THIS EXISTS
===============
ns `db-tier` runs a default-deny (`zz-default-deny`,
platform-services/db-tier/netpol.yaml). A namespace reaches the databases through
exactly one of two doors:

  A. an explicit by-name rule in that file
     (`namespaceSelector.matchLabels.kubernetes.io/metadata.name: <ns>`) — how
     `backstage`, `slides`, `monitoring`, `agile`, `db-admin` and
     `crossplane-system` get in; or
  B. the label-EXISTENCE rule `allow-ingress-tenant-namespaces`, whose selector is
     `platform.capstone/team: Exists` — how every tenant namespace gets in without
     a per-team edit.

Delete the `platform.capstone/team` label from a namespace that depends on door B
and its database connections stop. NOT loudly: Cilium enforces these policies for
real (SEC-011 deny-test), and a denied connection is a BLACKHOLE — the client sees
a connect TIMEOUT, never "connection refused". So the symptom is "the database got
slow", days after a one-line YAML edit that no reviewer flagged because the label
looks like metadata.

Measured on 2026-09-09, the day LabMx (uamishub.com) was adopted into GitOps: its
DATABASE_URL points at `capstone-mariadb-mariadb-cluster.db-tier.svc.cluster.local
:3306`, `labmx` appears in NO by-name rule, and `make validate` was proven blind —
deleting the label from platform-services/labmx/namespace.yaml still printed
`validate: PASS`. Guard [1/12]'s kubeconform pass only globs
`tenants/*/namespaces/*.yaml`, so nothing in the repo read that file at all.

WHAT IT CHECKS
==============
1. The db-tier side still exists. `allow-ingress-tenant-namespaces` must still
   select on `platform.capstone/team` / `Exists`. Deleting or renaming that rule
   silently cuts off EVERY tenant at once, which is a bigger blast radius than any
   single namespace edit — and it is one `git rm` away with nothing watching.

2. The consumer side is honest. Any Namespace manifest that OPTS IN by carrying

       platform.capstone/db-tier-client: "true"

   in its labels must be able to reach db-tier: either it carries a non-empty
   `platform.capstone/team` label (door B), or its name appears in a by-name rule
   in netpol.yaml (door A).

OPT-IN, DELIBERATELY. The guard cannot infer who talks to a database — the
connection string lives in Vault, not in git — so it does not try. A namespace
declares itself a client, and from then on the label pairing is enforced. That
keeps the false-positive surface at zero for the ~50 namespaces in this repo that
never touch db-tier, and it means the annotation itself documents the dependency
for the next reader.

FAIL-CLOSED ON UNREADABLE INPUT. "Found no declared clients" is reported as a
FAILURE, not a pass — the third failure mode this Makefile's preflight block calls
out: not "the input is clean" and not "the input is bad", but "I could not read the
input at all".
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NETPOL = REPO / "platform-services" / "db-tier" / "netpol.yaml"
SCAN_ROOTS = ["platform-services", "tenants"]

OPT_IN_LABEL = "platform.capstone/db-tier-client"
TEAM_LABEL = "platform.capstone/team"


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def read_netpol() -> str:
    if not NETPOL.exists():
        fail(
            f"cannot read {NETPOL.relative_to(REPO)} — this guard's whole subject is "
            "that file. A guard that cannot find its input has not passed."
        )
    return NETPOL.read_text(encoding="utf-8")


def check_label_existence_rule(text: str) -> None:
    """Assert `allow-ingress-tenant-namespaces` still keys on the team label."""
    if "allow-ingress-tenant-namespaces" not in text:
        fail(
            "NetworkPolicy `allow-ingress-tenant-namespaces` is GONE from "
            "platform-services/db-tier/netpol.yaml. That is the single rule admitting "
            "every tenant namespace to Postgres/MariaDB. Without it every tenant app "
            "loses its database at once, and the symptom is a connect TIMEOUT (Cilium "
            "blackholes the packet), not a refusal — so it reads as 'the DB is slow', "
            "cluster-wide."
        )
    # The rule body: a matchExpressions entry on the team label with operator Exists.
    # Written as a tolerant regex rather than a YAML parse so a comment reflow or a
    # re-indent cannot flip this to a false FAIL.
    pattern = re.compile(
        r"key:\s*" + re.escape(TEAM_LABEL) + r"\s*\n\s*operator:\s*Exists",
        re.MULTILINE,
    )
    if not pattern.search(text):
        fail(
            f"`allow-ingress-tenant-namespaces` no longer selects on "
            f"`{TEAM_LABEL}` with `operator: Exists`. Every namespace relying on "
            "door B (the label-existence admit) is cut off the moment this merges, "
            "silently. If the selector was deliberately changed, update this guard "
            "in the SAME commit."
        )
    print(f"  OK — db-tier still admits namespaces by `{TEAM_LABEL}: Exists`")


def by_name_admits(text: str) -> set:
    """Namespaces admitted to db-tier by an explicit by-name rule (door A)."""
    return set(re.findall(r"kubernetes\.io/metadata\.name:\s*([a-z0-9][a-z0-9-]*)", text))


def namespace_docs(path: Path):
    """Yield (name, labels) for every `kind: Namespace` document in a YAML file.

    Hand-parsed rather than PyYAML-parsed on purpose: `make validate` is
    dependency-free by design (python3 + kubeconform, nothing pip-installed), and
    several files in tenants/ carry literal `__TEAM__` placeholders that are valid
    YAML but meaningless here.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    if "kind: Namespace" not in text:
        return

    for doc in re.split(r"^---\s*$", text, flags=re.MULTILINE):
        if not re.search(r"^kind:\s*Namespace\s*$", doc, flags=re.MULTILINE):
            continue
        name_m = re.search(r"^  name:\s*([A-Za-z0-9_.-]+)\s*$", doc, flags=re.MULTILINE)
        if not name_m:
            continue
        labels = {}
        lab_m = re.search(r"^  labels:\s*$", doc, flags=re.MULTILINE)
        if lab_m:
            for line in doc[lab_m.end():].splitlines():
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                kv = re.match(r"^    ([A-Za-z0-9_.\-/]+):\s*(.*?)\s*$", line)
                if not kv:
                    break  # dedent or a nested block ends the labels map
                labels[kv.group(1)] = kv.group(2).strip('"\'')
        yield name_m.group(1), labels


def main() -> None:
    text = read_netpol()
    check_label_existence_rule(text)
    named = by_name_admits(text)

    declared, problems = [], []
    for root in SCAN_ROOTS:
        base = REPO / root
        if not base.is_dir():
            fail(f"scan root missing: {root} — cannot have checked anything.")
        for path in sorted(base.rglob("*.yaml")):
            for name, labels in namespace_docs(path):
                if labels.get(OPT_IN_LABEL) != "true":
                    continue
                rel = path.relative_to(REPO)
                declared.append((name, rel))
                if labels.get(TEAM_LABEL):
                    continue  # door B
                if name in named:
                    continue  # door A
                problems.append(
                    f"    {rel} :: namespace `{name}` declares "
                    f"`{OPT_IN_LABEL}: \"true\"` but has NO `{TEAM_LABEL}` label and "
                    f"NO by-name ingress rule in platform-services/db-tier/netpol.yaml.\n"
                    f"      -> every DB connection from this namespace will be "
                    f"blackholed by Cilium and surface as a TIMEOUT, not a refusal.\n"
                    f"      -> fix: add `{TEAM_LABEL}: <team>` to the namespace labels, "
                    f"or add an explicit by-name rule for `{name}` to netpol.yaml."
                )

    if not declared:
        fail(
            f"no namespace in {'/'.join(SCAN_ROOTS)} carries "
            f"`{OPT_IN_LABEL}: \"true\"`. At least one is expected (LabMx). "
            "Finding nothing is not a pass — it means this guard checked no namespace "
            "at all, which is indistinguishable from everything being fine."
        )

    if problems:
        print(f"FAIL: {len(problems)} db-tier client namespace(s) cannot reach db-tier:")
        print("\n".join(problems))
        sys.exit(1)

    for name, rel in declared:
        door = "door B (team label)" if name not in named else "door A (by-name rule)"
        print(f"  + {name:<16} {door:<24} {rel}")
    print(f"  OK — {len(declared)} declared db-tier client namespace(s), all admitted")


if __name__ == "__main__":
    main()
