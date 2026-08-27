#!/usr/bin/env python3
"""Offline lint: the VM wizard's maxima must fit the VM tier's quota + LimitRange.

THE DEFECT THIS EXISTS FOR (2026-08-27, paper-papas). The scaffolder form and the
namespace bundle are two documents that each looked reasonable alone and
contradicted each other:

    wizard  : cpuCores max 8, memoryGi max 16
    quota   : requests.cpu 3, limits.cpu 4, requests/limits.memory 6Gi
    LimitRange max : cpu 4, memory 6Gi

The form therefore ACCEPTED 8 vCPU / 8Gi, wrote it into the tenant's chart, and
the namespace then refused to create the virt-launcher pod for it. Nothing warned
anybody: the wizard succeeded, the PR merged, ArgoCD synced, the disk imported,
and only at launcher-creation time did it fail — with no CrashLoop and no
scheduling event, because the pod was never created at all.

Two distinct rejections are possible, and BOTH are silent until that moment:

  * limits omitted entirely -> the LimitRange `default` becomes the container's
    limit (cpu 1, memory 512Mi) while KubeVirt still requests the full guest RAM:
        resources.requests: Invalid value: "8Gi":
        must be less than or equal to memory limit of 512Mi
  * limits present but over the ceiling:
        maximum memory usage per Container is 6Gi, but limit is 8Gi,
        maximum cpu usage per Container is 4, but limit is 8

So this lint asserts the invariant that makes both impossible: **the largest guest
the wizard can legally produce must fit the tier the blueprint hands it**, with
KubeVirt's own overhead included.

It is deliberately a bounds check and not a style check. It does not care what the
numbers ARE; it cares that the two files agree. Raise the wizard maximum and this
fails until the quota follows, and vice versa — which is the whole point.
"""
import pathlib
import re
import sys

REPO = pathlib.Path(
    sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent.parent
).resolve()

WIZARD = REPO / "platform-services/backstage/templates/vm-app/template.yaml"
BLUEPRINT = REPO / "tenants/_template-vm/vm/namespaces/vm-prod.yaml"

# KubeVirt adds its own overhead on top of the guest's request when it builds the
# launcher pod. MEASURED on the live reference VM (crimson-copies-stripped): an
# 8Gi guest produced an 8532Mi container, i.e. +340Mi; CPU overhead is ~5m. A
# transient CDI importer coexists during the disk import and must also fit.
KUBEVIRT_MEM_OVERHEAD_MI = 340
KUBEVIRT_CPU_OVERHEAD = 0.01
IMPORTER_CPU_REQUEST = 0.25
IMPORTER_CPU_LIMIT = 0.75
IMPORTER_MEM_MI = 600

MI_PER_GI = 1024


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def read(path):
    if not path.is_file():
        fail(f"guard input missing: {path.relative_to(REPO)}\n"
             "  A bounds guard cannot pass over a file it cannot find.")
    return path.read_text()


def wizard_max(text, field):
    """The `maximum:` under a named scaffolder input."""
    m = re.search(rf"^        {field}:\s*$", text, re.M)
    if not m:
        fail(f"could not find scaffolder input `{field}` in template.yaml — "
             "if it was renamed, update this guard rather than deleting it.")
    block = text[m.end(): m.end() + 900]
    mm = re.search(r"^\s+maximum:\s*(\d+)\s*$", block, re.M)
    if not mm:
        fail(f"scaffolder input `{field}` has no `maximum:` — an unbounded input "
             "cannot be checked against the tier, and will eventually exceed it.")
    return int(mm.group(1))


def quantity_to_mi(raw):
    raw = raw.strip().strip('"\'')
    if raw.endswith("Gi"):
        return int(float(raw[:-2]) * MI_PER_GI)
    if raw.endswith("Mi"):
        return int(float(raw[:-2]))
    fail(f"unsupported memory quantity {raw!r} — extend this guard rather than "
         "loosening it.")


def cpu_to_cores(raw):
    raw = raw.strip().strip('"\'')
    if raw.endswith("m"):
        return float(raw[:-1]) / 1000.0
    return float(raw)


def blueprint_values(text):
    """Pull the quota + LimitRange ceilings out of the namespace bundle."""
    out = {}
    for key in ("requests.cpu", "limits.cpu", "requests.memory", "limits.memory"):
        m = re.search(rf"^\s+{re.escape(key)}:\s*(\S+)\s*$", text, re.M)
        if not m:
            fail(f"quota key `{key}` not found in vm-prod.yaml")
        out[key] = m.group(1)

    # The LimitRange `max:` block — the per-CONTAINER ceiling, which is the one the
    # virt-launcher compute container is measured against.
    m = re.search(r"^      max:\s*$", text, re.M)
    if not m:
        fail("LimitRange `max:` block not found in vm-prod.yaml")
    block = text[m.end(): m.end() + 400]
    mc = re.search(r"^\s+cpu:\s*(\S+)\s*$", block, re.M)
    mm = re.search(r"^\s+memory:\s*(\S+)\s*$", block, re.M)
    if not (mc and mm):
        fail("LimitRange `max:` is missing cpu or memory")
    out["max.cpu"] = mc.group(1)
    out["max.memory"] = mm.group(1)
    return out


def main():
    wtext = read(WIZARD)
    btext = read(BLUEPRINT)

    max_cores = wizard_max(wtext, "cpuCores")
    max_mem_gi = wizard_max(wtext, "memoryGi")
    bp = blueprint_values(btext)

    # What the LARGEST legal wizard VM actually demands at the pod.
    need_cpu_req = max_cores + KUBEVIRT_CPU_OVERHEAD + IMPORTER_CPU_REQUEST
    need_cpu_lim = max_cores + KUBEVIRT_CPU_OVERHEAD + IMPORTER_CPU_LIMIT
    need_mem_mi = max_mem_gi * MI_PER_GI + KUBEVIRT_MEM_OVERHEAD_MI + IMPORTER_MEM_MI
    # per-container ceiling excludes the importer (a separate container/pod)
    need_container_cpu = max_cores + KUBEVIRT_CPU_OVERHEAD
    need_container_mem_mi = max_mem_gi * MI_PER_GI + KUBEVIRT_MEM_OVERHEAD_MI

    checks = [
        ("quota requests.cpu", cpu_to_cores(bp["requests.cpu"]), need_cpu_req, "cores"),
        ("quota limits.cpu", cpu_to_cores(bp["limits.cpu"]), need_cpu_lim, "cores"),
        ("quota requests.memory", quantity_to_mi(bp["requests.memory"]), need_mem_mi, "Mi"),
        ("quota limits.memory", quantity_to_mi(bp["limits.memory"]), need_mem_mi, "Mi"),
        ("LimitRange max.cpu", cpu_to_cores(bp["max.cpu"]), need_container_cpu, "cores"),
        ("LimitRange max.memory", quantity_to_mi(bp["max.memory"]), need_container_mem_mi, "Mi"),
    ]

    bad = [(n, have, need, u) for n, have, need, u in checks if have < need]
    if bad:
        print("FAIL: the VM wizard can produce a guest the VM tier will refuse to run.")
        print(f"  wizard maxima: cpuCores={max_cores}, memoryGi={max_mem_gi}")
        for n, have, need, u in bad:
            print(f"    {n}: {have} {u} — needs at least {need:.2f} {u}")
        print("  A student can select these values in the form, the PR will merge, the")
        print("  disk will import, and the virt-launcher pod will then be REJECTED —")
        print("  with no CrashLoop and no scheduling event, because it is never created.")
        print("  Fix by raising tenants/_template-vm/vm/namespaces/vm-prod.yaml, OR by")
        print("  lowering the wizard maximum in the vm-app template. They must agree.")
        sys.exit(1)

    # requests.memory == limits.memory is the no-RAM-overcommit invariant (ADR-032 §5).
    if quantity_to_mi(bp["requests.memory"]) != quantity_to_mi(bp["limits.memory"]):
        fail("quota requests.memory != limits.memory — that reintroduces RAM "
             "overcommit for a tier whose guests reserve their full RAM for life.")

    print(f"  OK — wizard maxima (cpuCores={max_cores}, memoryGi={max_mem_gi}) fit the "
          f"VM tier quota and LimitRange, with KubeVirt overhead included")


if __name__ == "__main__":
    main()
