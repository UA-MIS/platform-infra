#!/usr/bin/env python3
"""VM-tier slot guard: refuse to onboard more VM tenants than the cluster can run.

THE FAILURE THIS EXISTS TO PREVENT IS SILENT. The VM chart pins VMs to
control-plane nodes (required nodeAffinity) and spreads them one per node
(required podAntiAffinity, topologyKey kubernetes.io/hostname, namespaceSelector
{} so it spans tenants). With three control-plane nodes, the FOURTH VM tenant
cannot schedule -- and it does not say so:

    VirtualMachine   ss-example      Starting
    VirtualMachineInstance           Pending
    kubectl get pods -n ss-example-vm-prod   ->   No resources found

The launcher pod is never created, so there is no pod to describe, no
CrashLoopBackOff, and no event on anything an operator would think to look at.
ArgoCD reports the Application Synced the whole time. That is the worst shape a
capacity limit can have: it looks like a slow boot forever.

This guard turns that into a red CI check at the moment the onboarding PR is
opened -- which is when it is cheap.

Counts tenants, not VMs: one VM tenant == one tenants/<dir>/vm/appproject-vm.yaml.
Underscore-prefixed dirs (_template-vm, _claims, _vm-claims, _boards) are
blueprints and ledgers, not live tenants -- the same exclusion the tenants
ApplicationSet makes.

No third-party imports: this runs in `make validate`, in a bare CI container,
with no kubeconfig.
"""
from __future__ import annotations

import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[1]
TENANTS = REPO / "tenants"
CAPACITY = REPO / "hack" / "vm-tier-capacity.yaml"

SLOTS_RE = re.compile(r"^slots:\s*(\d+)\s*$", re.MULTILINE)


def fail(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def main() -> int:
    # ---- preflight: a guard that cannot read its subject must not pass -------
    # "Found nothing" and "nothing is wrong" are indistinguishable unless this is
    # asserted. Fail-open is the wrong direction for a capacity guard: it would
    # go quiet exactly when a path is renamed.
    if not CAPACITY.is_file():
        fail("FAIL: missing %s -- the declared VM-tier slot count.\n"
             "      This guard cannot pass over a subject it cannot find."
             % CAPACITY.relative_to(REPO))
    if not TENANTS.is_dir():
        fail("FAIL: missing tenants/ -- guard had nothing to count, which is not a pass.")

    m = SLOTS_RE.search(CAPACITY.read_text(encoding="utf-8"))
    if not m:
        fail("FAIL: no `slots: <n>` line in %s" % CAPACITY.relative_to(REPO))
    slots = int(m.group(1))
    if slots < 1:
        fail("FAIL: slots must be >= 1 in %s" % CAPACITY.relative_to(REPO))

    vm_tenants = sorted(
        p.parents[1].name
        for p in TENANTS.glob("*/vm/appproject-vm.yaml")
        if not p.parents[1].name.startswith("_")
    )

    print("  declared VM slots: %d   (hack/vm-tier-capacity.yaml)" % slots)
    print("  VM tenants in git: %d   (%s)"
          % (len(vm_tenants), ", ".join(vm_tenants) if vm_tenants else "none"))

    if len(vm_tenants) > slots:
        fail(
            "\nFAIL: no VM slot available -- %d VM tenants declared, %d slot(s).\n"
            "\n"
            "  The VM chart pins VMs to control-plane nodes and spreads them ONE PER\n"
            "  NODE with a REQUIRED podAntiAffinity, so tenant #%d cannot schedule.\n"
            "  It will NOT fail loudly: the VirtualMachine sits at `Starting`, the\n"
            "  VMI at `Pending`, no launcher pod is ever created, and ArgoCD keeps\n"
            "  reporting Synced. There is nothing to inspect.\n"
            "\n"
            "  Two real remedies -- pick one, do not delete this guard:\n"
            "    1. ADD A CONTROL-PLANE NODE, then bump `slots:` in\n"
            "       hack/vm-tier-capacity.yaml in the same PR.\n"
            "    2. RELAX THE ANTI-AFFINITY to preferredDuringSchedulingIgnored\n"
            "       DuringExecution (weight: 100) in the skeleton's\n"
            "       .devops/chart/base/virtualmachine.yaml, accepting that two VMs\n"
            "       may then share a node and contend for CPU. If you do this, this\n"
            "       guard no longer describes a hard wall and should be revisited\n"
            "       rather than merely bumped.\n"
            % (len(vm_tenants), slots, len(vm_tenants))
        )

    if len(vm_tenants) == slots:
        print("  OK -- VM tier is FULL: %d/%d slots used. The next VM tenant will not"
              % (len(vm_tenants), slots))
        print("       schedule; add a control-plane node or relax the anti-affinity first.")
    else:
        print("  OK -- %d/%d VM slots used, %d free."
              % (len(vm_tenants), slots, slots - len(vm_tenants)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
