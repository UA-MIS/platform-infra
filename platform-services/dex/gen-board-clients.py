#!/usr/bin/env python3
"""Sync the Dex `agile-board` client's team redirect URIs with tenants/_boards/ (D-186).

Dex has no wildcard redirect URIs, so every provisioned board needs its exact
callback listed. That list is the ONE thing about a board that is not derivable
inside the board's own manifests -- so it is generated here from the same single
source of truth the ApplicationSet uses, rather than hand-maintained.

    python3 platform-services/dex/gen-board-clients.py            # rewrite in place
    python3 platform-services/dex/gen-board-clients.py --check    # exit 1 on drift

--check is wired into `make validate`, so a board file committed without the
matching Dex entry fails CI LOUDLY. The alternative -- discovering it when a
student clicks "Sign in" and gets an opaque OIDC error -- is the failure mode
this whole file is organised to prevent.

No third-party imports: this runs in `make validate` and in a bare CI container.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
BOARDS_DIR = REPO / "tenants" / "_boards"
CONFIGMAP = REPO / "platform-services" / "dex" / "configmap.yaml"

BEGIN = "          # ── BEGIN GENERATED team board redirect URIs (gen-board-clients.py) ──"
END = "          # ── END GENERATED team board redirect URIs ──"

DOMAIN = "capstone.uamishub.com"
SLUG_RE = re.compile(r"^[a-z]([-a-z0-9]*[a-z0-9])?$")

# Deliberately a regex and not a YAML parse: `make validate` already parses these
# claim-shaped files with sed elsewhere, and matching that style keeps the two
# guards from ever disagreeing about what a `team:` line is (the preflight.py
# lesson). It also means this script has zero dependencies.
TEAM_RE = re.compile(r'^team: *"?([a-z0-9][-a-z0-9]*)"?\s*$', re.MULTILINE)


def board_teams() -> list[str]:
    """Every live board's team slug, sorted, deduped."""
    if not BOARDS_DIR.is_dir():
        return []
    teams: list[str] = []
    for path in sorted(BOARDS_DIR.glob("*.yaml")):
        if path.name.startswith("_"):
            continue  # examples, not live boards (mirrors tenants/_claims/)
        text = path.read_text(encoding="utf-8")
        match = TEAM_RE.search(text)
        if not match:
            sys.exit(f"{path}: no top-level `team:` key — cannot derive a redirect URI.")
        team = match.group(1)
        if not SLUG_RE.match(team):
            sys.exit(f"{path}: team {team!r} is not a DNS-1123 label.")
        if team != path.stem:
            # The filename IS the uniqueness guarantee that stops a team getting
            # two boards. If it can drift from the `team:` inside, that guarantee
            # is worthless.
            sys.exit(
                f"{path}: filename {path.stem!r} != team {team!r}. "
                "The filename must equal the team slug — it is what makes "
                "one-board-per-team structural rather than a guard."
            )
        teams.append(team)
    if len(set(teams)) != len(teams):
        sys.exit("duplicate team slugs across tenants/_boards/ — impossible via filenames; check for symlinks.")
    return teams


def render(teams: list[str]) -> str:
    """The team-board redirect URIs, as list items inside the EXISTING client.

    This does NOT emit a client. The `agile-board` staticClient already exists
    (it serves the maintainers' board at agile.uamishub.com, PR #543); team
    boards are additional redirect URIs on that same client, not a second one.
    One client, N boards -- which is the whole argument for a shared client.
    """
    if not teams:
        return "          # (no team boards provisioned -- add a file to tenants/_boards/)"
    return "\n".join(
        f"          - https://{team}-agile.{DOMAIN}/api/auth/callback" for team in teams
    )


def splice(current: str, body: str) -> str:
    start = current.find(BEGIN)
    stop = current.find(END)
    if start == -1 or stop == -1 or stop < start:
        sys.exit(
            f"{CONFIGMAP}: generated-region markers missing or out of order. "
            "Restore the BEGIN/END comment pair before running this."
        )
    head = current[: start + len(BEGIN)]
    tail = current[stop:]
    return f"{head}\n{body}\n{tail}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if the ConfigMap is out of date instead of rewriting it",
    )
    args = parser.parse_args()

    teams = board_teams()
    current = CONFIGMAP.read_text(encoding="utf-8")
    updated = splice(current, render(teams))

    if args.check:
        if updated != current:
            sys.stderr.write(
                "DRIFT: the agile-board client's redirect URIs do not match tenants/_boards/.\n"
                f"  boards found: {', '.join(teams) or '(none)'}\n"
                "  fix: python3 platform-services/dex/gen-board-clients.py\n"
                "\nWhy this is blocking: a board whose callback is missing from Dex\n"
                "deploys, passes readiness and serves its landing page — and then\n"
                "fails at sign-in with an opaque OIDC error. It looks like a working\n"
                "board until a student tries to use it.\n"
            )
            return 1
        print(f"dex board clients: up to date ({len(teams)} board(s))")
        return 0

    if updated != current:
        CONFIGMAP.write_text(updated, encoding="utf-8")
        print(f"dex board clients: rewrote for {len(teams)} board(s): {', '.join(teams) or '(none)'}")
    else:
        print(f"dex board clients: already up to date ({len(teams)} board(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
