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

    # VirtualMachine sanity: a dataVolumeTemplate (the imported disk) must be present.
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
