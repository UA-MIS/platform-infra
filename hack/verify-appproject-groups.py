#!/usr/bin/env python3
"""Verify every live ArgoCD AppProject role group actually grants someone access.

`make validate` guard [7/7] proves the group STRING is well-formed
(`UA-MIS:<slug>`). That is necessary and not sufficient. A correctly-formatted
group grants nothing unless BOTH of these also hold:

  (a) `<slug>` is a real GitHub team in the org, and
  (b) real people are MEMBERS of that team.

(b) is the one that surprises people: Dex's GitHub connector derives the
`groups` claim from TEAM MEMBERSHIP (`/user/teams`). A student added to the app
repo as a repo COLLABORATOR — which is how several tenants were onboarded — is
never in a team, so Dex emits no `UA-MIS:*` group for them and every
team-scoped ArgoCD role misses. They fall through to `policy.default`.

Both failure modes are SILENT: ArgoCD does not warn about a role that matches no
group. Only a check like this one makes them loud.

Found by this check during the SEC-021 audit (2026-08-26):
  - AppProject `alhands` bound `UA-MIS:alhands`, but the real GitHub team is
    `allhands` (double L). One character; role inert.
  - AppProject `crimson-copies` bound `UA-MIS:crimson-copies`, and no such team
    exists at all — its 36 students are repo collaborators.

Exit 0 = every group resolves to a team with members. Exit 1 = at least one
AppProject grants nobody anything.

Requires: kubectl (cluster read), gh (authenticated to the org).
"""
import json
import subprocess
import sys

ORG = "UA-MIS"
# Projects that deliberately have no team-scoped role.
SKIP_PROJECTS = {"default", "platform"}


def run(cmd):
    """Run cmd, returning (ok, stdout). Never raises on non-zero exit."""
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode == 0, p.stdout.strip()


def appprojects():
    ok, out = run(["kubectl", "get", "appprojects", "-n", "argocd", "-o", "json"])
    if not ok:
        sys.exit("ERROR: could not read AppProjects (is kubectl pointed at the cluster?)")
    for item in json.loads(out).get("items", []):
        name = item["metadata"]["name"]
        if name in SKIP_PROJECTS:
            continue
        for role in item.get("spec", {}).get("roles", []) or []:
            for group in role.get("groups", []) or []:
                yield name, role.get("name", "?"), group


def team_members(slug):
    """Return (exists, member_logins)."""
    ok, _ = run(["gh", "api", f"orgs/{ORG}/teams/{slug}"])
    if not ok:
        return False, []
    ok, out = run(["gh", "api", "--paginate", f"orgs/{ORG}/teams/{slug}/members",
                   "-q", ".[].login"])
    return True, [l for l in out.splitlines() if l] if ok else []


def main():
    failures = []
    warnings = []
    checked = 0

    for project, role, group in appprojects():
        checked += 1
        label = f"AppProject {project!r} role {role!r} group {group!r}"

        if not group.startswith(f"{ORG}:"):
            failures.append(
                f"{label}\n"
                f"    not in '{ORG}:<slug>' form — Dex never emits this, role is INERT."
            )
            continue

        slug = group.split(":", 1)[1]
        exists, members = team_members(slug)

        if not exists:
            failures.append(
                f"{label}\n"
                f"    GitHub team '{ORG}/{slug}' DOES NOT EXIST — role is INERT.\n"
                f"    Everyone in this project falls through to policy.default."
            )
        elif not members:
            warnings.append(
                f"{label}\n"
                f"    GitHub team '{ORG}/{slug}' exists but has NO MEMBERS — role grants\n"
                f"    nobody anything. If the students are on the app repo as\n"
                f"    COLLABORATORS, add them to the TEAM: collaborators get no group\n"
                f"    claim from Dex."
            )
        else:
            print(f"  OK  {label} -> {len(members)} member(s)")

    print(f"\nchecked {checked} AppProject role group(s)")

    for w in warnings:
        print(f"\nWARN: {w}")
    for f in failures:
        print(f"\nFAIL: {f}")

    if failures or warnings:
        print("\nverify-appproject-groups: FAIL — at least one AppProject grants nobody access.")
        return 1
    print("verify-appproject-groups: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
