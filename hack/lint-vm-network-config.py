#!/usr/bin/env python3
"""
lint-vm-network-config.py — keep the VM scaffold's guest networking MAC-independent.

WHY THIS GUARD EXISTS
=====================
A KubeVirt VM tenant scaffolded without an explicit `networkData` loses ALL guest
networking on its SECOND boot, permanently, and nothing in Kubernetes reports it.
Measured on the live `paper-papas` VM on 2026-08-31: guest booted to a login
prompt, sshd listening, VMI `Running`/`Ready`, ssh Service holding a live Endpoint
— and the launcher's tap device at `RX: 0 bytes 0 packets` after three days. The
guest had never transmitted a frame, because it had no IP.

Three facts combine:

  1. KubeVirt **masquerade gives the guest the launcher POD's MAC**. The CNI
     generates that MAC per pod, so it CHANGES on every VM restart / eviction /
     node drain.
  2. With no `networkData`, KubeVirt's NoCloud seed carries only `meta-data` and
     `user-data`, so cloud-init falls back to `generate_fallback_config()`, which
     writes netplan pinned to `match: {macaddress: <the MAC at first boot>}`.
  3. cloud-init's `default_update_events` is `{NETWORK: {BOOT_NEW_INSTANCE}}`, and
     the instance-id is the VM's stable firmware UUID, so a restart is not a new
     instance: cloud-init logs "No network config applied" and leaves the stale,
     MAC-pinned file in place.

First boot works. The first restart strands the VM. The symptom is
indistinguishable from a broken tunnel, a bad NetworkPolicy, or a dead sshd, which
is where the debugging time actually went.

WHAT THIS GUARD CHECKS
======================
Two independent belts, either of which alone prevents the failure. Both are
required here so that removing one still fails CI loudly rather than quietly
halving the protection:

  A. the skeleton VirtualMachine's `cloudInitNoCloud` declares `networkData`, and
     that networkData matches on interface NAME (not `macaddress`);
  B. the skeleton cloud-init declares `updates.network.when` including `boot`, so
     a stale config self-heals on the next reboot.

Check B is a TEXT check, deliberately: the skeleton cloud-init.yaml is a Backstage
(nunjucks) template containing `{%- for ... %}` blocks and is NOT parseable YAML
until it is rendered. The tenant-side gate
(.devops/ci/validate-vm.py, which runs on the RENDERED file in every tenant repo)
performs the parsed equivalent.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
BASE = REPO / "platform-services/backstage/templates/vm-app/skeleton-vm/.devops/chart/base"
VM = BASE / "virtualmachine.yaml"
CLOUD_INIT = BASE / "cloud-init.yaml"

errors: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def check_network_data() -> None:
    if not VM.is_file():
        err(f"missing {VM.relative_to(REPO)}")
        return
    try:
        doc = yaml.safe_load(VM.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        err(f"{VM.relative_to(REPO)}: invalid YAML: {e}")
        return

    volumes = (
        (doc or {}).get("spec", {}).get("template", {}).get("spec", {}).get("volumes")
        or []
    )
    seeds = [v for v in volumes if isinstance(v, dict) and "cloudInitNoCloud" in v]
    if not seeds:
        err(f"{VM.relative_to(REPO)}: no cloudInitNoCloud volume found.")
        return

    for vol in seeds:
        seed = vol["cloudInitNoCloud"]
        raw = seed.get("networkData")
        if not raw:
            err(
                f"{VM.relative_to(REPO)}: cloudInitNoCloud has no `networkData`. "
                "Without it cloud-init writes a MAC-pinned netplan on first boot and "
                "the guest loses all networking on the next restart, silently. "
                "See the comment in that file."
            )
            continue
        try:
            net = yaml.safe_load(raw)
        except yaml.YAMLError as e:
            err(f"{VM.relative_to(REPO)}: networkData is not valid YAML: {e}")
            continue
        if not isinstance(net, dict) or "ethernets" not in net:
            err(
                f"{VM.relative_to(REPO)}: networkData must be netplan v2 with an "
                "`ethernets:` section."
            )
            continue
        for name, eth in (net.get("ethernets") or {}).items():
            match = (eth or {}).get("match") or {}
            if "macaddress" in match:
                err(
                    f"{VM.relative_to(REPO)}: networkData ethernet {name!r} matches on "
                    "`macaddress`. The guest's MAC is the launcher POD's MAC and it "
                    "changes on every restart — match on `name` instead."
                )
            elif "name" not in match:
                err(
                    f"{VM.relative_to(REPO)}: networkData ethernet {name!r} has no "
                    "`match.name`. Match on interface NAME so the config survives a "
                    "MAC change."
                )
            if not (eth or {}).get("dhcp4"):
                err(
                    f"{VM.relative_to(REPO)}: networkData ethernet {name!r} must set "
                    "`dhcp4: true` — the launcher runs the DHCP server for the guest."
                )


def check_update_events() -> None:
    if not CLOUD_INIT.is_file():
        err(f"missing {CLOUD_INIT.relative_to(REPO)}")
        return
    text = CLOUD_INIT.read_text(encoding="utf-8")
    # Text check: this file is a nunjucks template and is not parseable YAML until
    # rendered (see the module docstring).
    block = re.search(
        r"^updates:\s*$\n^\s+network:\s*$\n^\s+when:\s*(.+)$",
        text,
        re.MULTILINE,
    )
    if not block:
        err(
            f"{CLOUD_INIT.relative_to(REPO)}: missing the `updates: network: when:` "
            "block. Without it cloud-init applies network config only on a NEW "
            "instance-id, so a stale MAC-pinned netplan is never repaired."
        )
        return
    if "boot" not in block.group(1):
        err(
            f"{CLOUD_INIT.relative_to(REPO)}: `updates.network.when` is "
            f"{block.group(1).strip()!r}; it must include `boot`."
        )


def main() -> int:
    check_network_data()
    check_update_events()
    if errors:
        print("VM guest-network guard FAILED:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(
        "VM guest-network guard passed "
        "(skeleton networkData is name-matched; network config re-applies every boot)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
