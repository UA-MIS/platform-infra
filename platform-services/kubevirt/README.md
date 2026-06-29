# KubeVirt + CDI install (ADR-032 — "true VM as an app")

This directory + `../cdi/` install **KubeVirt** (run a real VM as a Kubernetes
workload) and **CDI** (import a disk image into a PVC). It is the **platform
install only** — the operators + their CRs. The tenant-facing pieces (the
`<team>-vm-<env>` namespace tier, the AppProject fence widening, the `layout: vm`
scaffold) are **separate, later work** per ADR-032 and are **not** in this change.

> ⚠ **NOT yet approved-to-apply.** ADR-032 is a security-gated capability
> (`Status: Proposed`, architecture gate). These manifests are wired into GitOps
> but **installing them is the human's keyboard, after the security gate** — see
> "Apply order" below. The `/dev/kvm` prerequisite (open Q1) is being confirmed by
> the kvm-spike in parallel; the KubeVirt CR sets `useEmulation: true` so the
> install works even if `/dev/kvm` is absent.

## Pinned versions (Context7-confirmed 2026-06-28)

| Component | Version | Source of truth | Manifest |
| --- | --- | --- | --- |
| KubeVirt (`virt-operator` + `KubeVirt` CR) | **v1.8.4** | `storage.googleapis.com/.../kubevirt/stable.txt` | `kubevirt-operator.yaml` + `kubevirt-cr.yaml` |
| CDI (`cdi-operator` + `CDI` CR) | **v1.65.0** | GitHub `releases/latest` (kubevirt/containerized-data-importer) | `cdi-operator.yaml` + `cdi-cr.yaml` |

Both are pinned **exactly** (no `latest`) in the operator `kustomization.yaml`
files. Bump deliberately, keeping CDI roughly in step with the KubeVirt minor
(CDI v1.65.x pairs with KubeVirt v1.8.x).

## Layout

```
platform-services/kubevirt/
  operator/kustomization.yaml   # remote: kubevirt-operator.yaml @ v1.8.4 (ns + CRD + virt-operator)
  cr/kustomization.yaml         # local CR
  cr/kubevirt-cr.yaml           # KubeVirt CR — useEmulation:true, featureGates:[]
platform-services/cdi/
  operator/kustomization.yaml   # remote: cdi-operator.yaml @ v1.65.0 (ns + CRD + cdi-operator)
  cr/kustomization.yaml         # local CR
  cr/cdi-cr.yaml                # CDI CR (cluster-scoped) — upstream v1.65.0 defaults

applicationsets/kubevirt-operator-app.yaml   # platform-kubevirt-operator (sync-wave 0)
applicationsets/kubevirt-cr-app.yaml         # platform-kubevirt-cr       (sync-wave 1)
applicationsets/cdi-operator-app.yaml        # platform-cdi-operator      (sync-wave 0)
applicationsets/cdi-cr-app.yaml              # platform-cdi-cr            (sync-wave 1)
```

## Install method (and why no `make bootstrap-reapply`)

Same pattern as **cert-manager** and **sealed-secrets** in this repo: the upstream
release manifest is referenced as a **pinned remote kustomize resource**, not a
Helm chart (KubeVirt/CDI publish no official chart). Because that URL is fetched by
**kustomize at render time** — it is **not** an ArgoCD `source` — it does **NOT**
need a `bootstrap/platform-appproject.yaml` `sourceRepos` entry and does **NOT**
require `make bootstrap-reapply`. (Confirmed: `cert-manager.yaml` and
`sealed-secrets/controller.yaml` are both absent from `sourceRepos` and sync fine.
Only Helm-**source** Applications need the allowlist.) The ArgoCD `source` for all
four apps is the already-allowed `platform-infra` git repo.

The `platform-services-appset` **excludes** `platform-services/kubevirt` and
`platform-services/cdi` (the parent dirs hold only this README + the
`operator/`+`cr/` subdirs, no root kustomization). The four dedicated Applications
own the `operator/` + `cr/` subdirs via the rook-ceph-style operator/CR two-app
split.

## Apply order (human keyboard, post-security-gate)

ArgoCD's app-level sync-waves handle ordering automatically once the apps are
registered (operator wave 0 → CR wave 1, per component). The deliberate human
sequence:

1. **Confirm the KVM prerequisite (open Q1).** Check VT-x in BIOS + `/dev/kvm` on
   the 3 Talos nodes (kvm-spike). If absent, `useEmulation: true` keeps the install
   functional (software emulation — slow, spike/fallback only).
2. **Merge this PR.** No `make bootstrap-reapply` needed (see above).
3. **Operators first (wave 0):** `platform-kubevirt-operator` + `platform-cdi-operator`
   install the operators + the `kubevirts.kubevirt.io` / `cdis.cdi.kubevirt.io`
   CRDs and the `kubevirt` / `cdi` namespaces.
4. **CRs next (wave 1):** `platform-kubevirt-cr` + `platform-cdi-cr` deploy the
   runtimes. Wait for readiness:
   - `kubectl -n kubevirt wait kv kubevirt --for condition=Available`
   - `kubectl wait cdi cdi --for condition=Available`
5. **Then** the security review + SEC-011 deny-test re-run for the VM tier, and only
   after that the tenant-layer work (VM namespace tier, AppProject widening,
   `layout: vm` scaffold) — all out of scope here.

## Feature-gate decisions

- **KubeVirt `featureGates: []`** — empty on purpose. Every ADR-032 capability
  (DataVolume/`dataVolumeTemplates`, `masquerade` pod-network, `cloudInitNoCloud`,
  `runStrategy`) is **GA / default** in v1.8.4 and needs no gate. Adding unused
  gates only widens the surface. Add one later only with a justification (e.g.
  `VSOCK`, or `VolumesUpdateStrategy` for live-migration in a v2.x).
- **KubeVirt `useEmulation: true`** — the `/dev/kvm`-absent fallback (open Q1).
  KubeVirt still prefers hardware KVM when `/dev/kvm` is present and only falls back
  to emulation when it is not.
- **CDI `featureGates: [HonorWaitForFirstConsumer, WebhookPvcRendering]`** — the
  upstream v1.65.0 default CR config (respect WaitForFirstConsumer storage binding;
  GA PVC-rendering webhook).

## KVM dependency (open Q1 — the blocker)

KubeVirt wants `/dev/kvm` on each node for hardware-accelerated VMs. The 3 OptiPlex
7080 nodes' Talos schematic (factory `8957`) carries **no virtualization
extension** and VT-x/`/dev/kvm` presence is **unverified**. With
`useEmulation: true` the capability installs + proves out regardless; for real
workloads, KVM must be confirmed (BIOS VT-x + possibly a Talos machine-config /
schematic re-cut + a 3-node rolling reboot). See ADR-032 §5 and the kvm-spike.

## VM-tier security deny-test (`deny-test.sh`)

`deny-test.sh` automates the **SEC-011-style VM-tier deny-test**
(`artifacts/reviews/kubevirt-vm-tier-security-review.md` §6, checks **T1–T13**).
It is the **security gate that must PASS before any team is onboarded onto the VM
tier**. It renders the real `tenants/_template/vm/*` blueprint for a throwaway
team (`TEAM=denytest`) into a scratch namespace, runs every allow/deny assertion
(one colored PASS/FAIL line per check, tagged with its T-number), prints a
summary, and **exits non-zero if any check fails**. It is idempotent and
self-cleaning (a `trap` tears down all scratch resources on exit, including on
failure).

```bash
# run AFTER KubeVirt + CDI are installed/Available and Cilium is the active CNI:
bash platform-services/kubevirt/deny-test.sh
```

It does **cluster writes** (creates/deletes scratch namespaces, an AppProject, a
minimal cirros VM, a DataVolume, and probe pods) — so it is the **human's
keyboard**, run with context `admin@capstone` (override `KUBE_CONTEXT=`). Other
overridable env vars: `TEAM`, `SEMESTER`, `STORAGE_CLASS`, `NET_TIMEOUT`,
`VM_TIMEOUT`, `DV_TIMEOUT`, and the `IMG_*` / `DV_SOURCE_URL` image pins.

| T | Assertion | Expect |
| --- | --- | --- |
| T1 | `virt-launcher` admits under **baseline** PSA | ALLOW |
| T2 | privileged + hostPath pods | DENY (PSA) |
| T3 | container `Deployment` via the VM AppProject | DENY (fence) |
| T4 | VM-shaped pod in a **restricted** namespace | DENY (PSA) |
| T5 | cross-tenant egress | DENY |
| T6 | apiserver ClusterIP egress | DENY |
| T7 | guest external egress | DENY |
| T8 | CDI importer egress (DataVolume import) | ALLOW |
| T9 | Traefik-path ingress to the VM Service | ALLOW |
| T10 | cross-tenant ingress | DENY |
| T11 | kubelet probe under default-deny | ALLOW |
| T12 | SA-token → apiserver via node IP | RBAC-gated (401/403/blocked) |
| T13 | 2nd VM vs `count/virtualmachines=1` quota | DENY |

> ⚠ **Cilium must be the active CNI.** On Talos default flannel, NetworkPolicies
> are inert and the deny tests (T5/T6/T7/T10) would falsely pass-through — the
> script warns if the `cilium` daemonset is absent. T5/T6/T7 are run from a curl
> probe pod in the VM namespace, which is governed by the **identical**
> `podSelector:{}` NetworkPolicies that constrain the `virt-launcher`/guest
> egress (the guest NATs out via the launcher under masquerade).
