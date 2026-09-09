#!/usr/bin/env python3
"""
validate-vm.py — the VM layout's CI gate (ADR-032 §6 CI: NO Kaniko build).

A VM app has no container image to build/push — the disk is imported by CDI from a
base image. So instead of the reusable container build pipeline, the VM CI VALIDATES
the manifests the platform will deploy:

  1. cloud-init (.devops/chart/base/cloud-init.yaml) is a valid `#cloud-config`
     (correct magic header + parses as YAML) — a broken cloud-init bricks first boot.
  2. every k8s manifest under .devops/chart parses as YAML and has apiVersion + kind.
  3. the chart actually contains a VirtualMachine (kubevirt.io/v1) with a
     dataVolumeTemplate (the imported disk) and a Service + Ingress (the URL).
  4. promotion.yaml + vm-metadata.yaml parse and promotion.yaml is the single-env,
     no-build VM shape.
  5. the guest's network config SURVIVES A VM RESTART — the VirtualMachine declares
     `networkData` matching on interface NAME (never on macaddress, which changes
     every restart under KubeVirt masquerade), and cloud-init re-applies network
     config on every boot. Without these, a VM works on first boot and is stranded
     with no IP forever after the next restart, while still reporting Running,
     Ready, and with a live Service Endpoint. See validate_guest_network().

Exits non-zero on any failure (the CI gate). Pure-stdlib + PyYAML; runs in the
platform's container-mode runner with no Kaniko, no registry credential, no push.
"""
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]  # .devops/ci/ -> repo root
CHART = REPO / ".devops" / "chart"
CLOUD_INIT = CHART / "base" / "cloud-init.yaml"

errors: list[str] = []
seen_kinds: set[str] = set()


def err(msg: str) -> None:
    errors.append(msg)


def validate_cloud_init() -> None:
    if not CLOUD_INIT.is_file():
        err(f"missing cloud-init: {CLOUD_INIT.relative_to(REPO)}")
        return
    text = CLOUD_INIT.read_text(encoding="utf-8")
    first = text.lstrip().splitlines()[0].strip() if text.strip() else ""
    if first != "#cloud-config":
        err(
            f"{CLOUD_INIT.relative_to(REPO)}: first line must be exactly "
            f"'#cloud-config' (got {first!r}) — cloud-init ignores files without it."
        )
    try:
        loaded = yaml.safe_load(text)
    except yaml.YAMLError as e:
        err(f"{CLOUD_INIT.relative_to(REPO)}: invalid YAML: {e}")
        return
    if not isinstance(loaded, dict):
        err(f"{CLOUD_INIT.relative_to(REPO)}: #cloud-config must be a YAML mapping.")
        return
    validate_network_update_events(text)


def validate_manifest(path: Path) -> None:
    try:
        docs = list(yaml.safe_load_all(path.read_text(encoding="utf-8")))
    except yaml.YAMLError as e:
        err(f"{path.relative_to(REPO)}: invalid YAML: {e}")
        return
    for doc in docs:
        if doc is None:
            continue
        if not isinstance(doc, dict) or "apiVersion" not in doc or "kind" not in doc:
            # kustomization.yaml is a Kustomize config, not a k8s object: it has `kind`
            # too, so this still holds. A bare list/scalar manifest is an error.
            err(f"{path.relative_to(REPO)}: a document is missing apiVersion/kind.")
            continue
        seen_kinds.add(doc["kind"])


def validate_guest_network(vm_path: Path, doc: dict) -> None:
    """The guest's network config must survive a VM restart.

    THE FAILURE THIS PREVENTS. Delete `networkData` from the VirtualMachine and your
    VM works perfectly on its first boot, then loses ALL networking on the next
    restart, forever, with nothing reporting it: the VMI still says Running and
    Ready, the ssh Service still has an Endpoint, and the guest still boots to a
    login prompt with sshd listening. It just has no IP address and cannot send a
    single packet. Measured on the live paper-papas VM, 2026-08-31 -- three days of
    `RX: 0 bytes 0 packets` on the launcher's tap device.

    WHY. KubeVirt masquerade gives the guest the launcher POD's MAC address, and the
    CNI generates that MAC fresh for every pod -- so the guest's MAC changes on every
    restart. With no networkData, cloud-init falls back to a netplan pinned to
    `match: {macaddress: <first-boot MAC>}`, and it will not rewrite that file on a
    later boot because cloud-init only re-applies network config when the instance-id
    changes (`default_update_events = {NETWORK: {BOOT_NEW_INSTANCE}}`) and a restart
    keeps the same instance-id. The stale rule then matches no device at all.

    So: match on interface NAME, never on macaddress. And keep the
    `updates.network.when: [boot]` block in cloud-init.yaml, which makes a stale
    config repair itself on the next reboot.
    """
    rel = vm_path.relative_to(REPO)
    volumes = doc.get("spec", {}).get("template", {}).get("spec", {}).get("volumes") or []
    seeds = [v for v in volumes if isinstance(v, dict) and "cloudInitNoCloud" in v]
    if not seeds:
        err(f"{rel}: VirtualMachine has no cloudInitNoCloud volume.")
        return
    for vol in seeds:
        raw = vol["cloudInitNoCloud"].get("networkData")
        if not raw:
            err(
                f"{rel}: cloudInitNoCloud has no `networkData`. Without it the guest "
                "loses all networking on its next restart (MAC-pinned netplan). Do "
                "not remove that block."
            )
            continue
        try:
            net = yaml.safe_load(raw)
        except yaml.YAMLError as e:
            err(f"{rel}: networkData is not valid YAML: {e}")
            continue
        eths = (net or {}).get("ethernets") if isinstance(net, dict) else None
        if not eths:
            err(f"{rel}: networkData must be netplan v2 with an `ethernets:` section.")
            continue
        for name, eth in eths.items():
            match = (eth or {}).get("match") or {}
            if "macaddress" in match:
                err(
                    f"{rel}: networkData ethernet {name!r} matches on `macaddress`. "
                    "The guest's MAC changes on every VM restart -- match on `name`."
                )
            elif "name" not in match:
                err(
                    f"{rel}: networkData ethernet {name!r} has no `match.name`; match "
                    "on interface NAME so the config survives a MAC change."
                )
            if not (eth or {}).get("dhcp4"):
                err(f"{rel}: networkData ethernet {name!r} must set `dhcp4: true`.")


def validate_network_update_events(text: str) -> None:
    """cloud-init must re-apply network config on every boot, not only on a new instance.

    Second, independent belt for the failure documented in validate_guest_network:
    with `updates.network.when: ['boot']` a stale MAC-pinned netplan repairs itself on
    the next reboot instead of stranding the VM forever.
    """
    try:
        loaded = yaml.safe_load(text)
    except yaml.YAMLError:
        return  # already reported by validate_cloud_init
    if not isinstance(loaded, dict):
        return
    when = ((loaded.get("updates") or {}).get("network") or {}).get("when")
    if not when or "boot" not in when:
        err(
            f"{CLOUD_INIT.relative_to(REPO)}: `updates.network.when` must include "
            "'boot'. Without it cloud-init writes the guest's network config only on "
            "the first boot of an instance-id, so a stale config is never repaired."
        )


def validate_yaml(path: Path) -> dict | None:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        err(f"{path.relative_to(REPO)}: invalid YAML: {e}")
        return None


def main() -> int:
    if not CHART.is_dir():
        err(f"missing chart dir: {CHART.relative_to(REPO)}")
        print_summary()
        return 1

    validate_cloud_init()

    # All chart YAML except cloud-init (handled above — it is #cloud-config, not a manifest).
    for path in sorted(CHART.rglob("*.yaml")):
        if path == CLOUD_INIT:
            continue
        validate_manifest(path)

    # The chart must actually emit the VM trio so a fresh scaffold is runnable + reachable.
    for required in ("VirtualMachine", "Service", "Ingress"):
        if required not in seen_kinds:
            err(f"chart is missing a {required} (found kinds: {sorted(seen_kinds)}).")

    # VirtualMachine sanity: a dataVolumeTemplate (the imported disk) must be present,
    # and the guest's network config must not be MAC-pinned (see validate_guest_network).
    vm_files = [
        p for p in CHART.rglob("*.yaml")
        if p != CLOUD_INIT and "kind: VirtualMachine" in p.read_text(encoding="utf-8")
    ]
    for vm in vm_files:
        for doc in yaml.safe_load_all(vm.read_text(encoding="utf-8")):
            if isinstance(doc, dict) and doc.get("kind") == "VirtualMachine":
                if not doc.get("spec", {}).get("dataVolumeTemplates"):
                    err(
                        f"{vm.relative_to(REPO)}: VirtualMachine has no "
                        f"dataVolumeTemplates (the imported disk)."
                    )
                validate_guest_network(vm, doc)

    # promotion.yaml — single-env, no-build VM shape.
    prom = validate_yaml(REPO / ".devops" / "promotion.yaml")
    if isinstance(prom, dict):
        if prom.get("layout") != "vm":
            err(".devops/promotion.yaml: expected `layout: vm`.")
        if "registry" in prom or "app" in prom:
            err(
                ".devops/promotion.yaml: VM layout must NOT declare registry/app "
                "(no image is built)."
            )
        envs = prom.get("environments") or {}
        if not isinstance(envs, dict) or not envs:
            err(".devops/promotion.yaml: no environments defined.")

    # vm-metadata.yaml — must parse.
    validate_yaml(REPO / ".devops" / "vm-metadata.yaml")

    print_summary()
    return 1 if errors else 0


def print_summary() -> None:
    if errors:
        print("VM manifest validation FAILED:")
        for e in errors:
            print(f"  - {e}")
    else:
        print("VM manifest validation passed (cloud-init + chart + promotion).")


if __name__ == "__main__":
    sys.exit(main())
