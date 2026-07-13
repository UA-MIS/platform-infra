# ADR-032 — "True VM as an app" via KubeVirt

- **Status:** Proposed (architecture gate — requires human approval). **Design + spike only — nothing installed or applied.**
- **Date:** 2026-06-28
- **Repo:** platform-infra
- **Deciders:** human (Clayton) + SRE/security; drafted by researcher
- **Companion:** `artifacts/design/kubevirt-vm-workloads-architecture.md` (full design,
  spike manifests, scaffold `layout: vm` sketch, Talos/KVM prereqs, sizing).
- **Relates to:** ADR-008 (`promotion.yaml` single source), ADR-031 (Crossplane onboarding),
  the `tenants/_template/` tenancy fence, the Cilium netpol enforcement work (SEC-011),
  Rook-Ceph (`ceph-block`), the Backstage scaffolder (`new-capstone-project`).

---

## Context

The platform's golden path assumes a **containerized** workload: a team writes a
`Dockerfile`, CI (Kaniko in ARC) builds an image, pushes to Harbor, and ArgoCD deploys a
`Deployment`. Some capstone teams cannot or will not containerize — a legacy Windows app, a
desktop-style stack, a professor-supplied VM appliance, a course that teaches OS/sysadmin,
or software that simply expects "a whole machine." Today those teams have no path onto the
IDP.

The user's ask: let a team **deploy a real virtual machine that runs as a workload inside
Kubernetes**, reachable at a URL like any other app — the "no Docker" developer experience.

**KubeVirt** is the standard way to do this: it adds a `VirtualMachine` CRD and runs each VM
as a QEMU/KVM process inside a normal pod (`virt-launcher`), scheduled, networked, and
stored by Kubernetes. **CDI** (Containerized Data Importer) imports a disk image (cloud
image, ISO, or container disk) into a PVC via a `DataVolume`. cloud-init handles first-boot
setup. This makes a VM a first-class, GitOps-managed, ingress-exposed "app."

The fit is **not** free. KubeVirt is a meaningful platform expansion with three hard
tensions against the current design (detailed in the companion doc):

1. **`virt-launcher` needs elevated privileges** (a `/dev/kvm` device, `SYS_NICE`/
   `NET_BIND_SERVICE` capabilities, a custom seccomp profile). Every tenant namespace today
   enforces **`pod-security.kubernetes.io/enforce: restricted`**
   (`tenants/_template/namespaces/*.yaml`), which forbids exactly that. VMs cannot run in a
   `restricted` namespace.
2. **The tenancy fence is a closed allow-list.** The AppProject has
   `clusterResourceWhitelist: []` and an enumerated `namespaceResourceWhitelist`
   (`tenants/_template/appproject.yaml`) that does not include `VirtualMachine` or
   `DataVolume`. Teams literally cannot create VM objects until the fence is widened.
3. **Hardware + storage.** Talos runs on 3 OptiPlex 7080 nodes whose installer schematic
   (`clusters/real-talos/talconfig.yaml`, factory `8957`) carries **no virtualization
   extension**, and the only Ceph storage class is **`ceph-block`** (RBD, RWO) — KubeVirt
   **live-migration needs RWX** shared storage, which the cluster does not have.

## Decision

**Adopt KubeVirt + CDI as an opt-in "VM workload" capability** — gated behind a one-time
SRE/security review and the prerequisites below — exposed to teams as a **third scaffolder
layout (`layout: vm`)** alongside `single` and `frontend-backend`.

This ADR records the *intent and the shape*; it does **not** authorize install. The headline
recommendation (see Consequences) is: **worth doing as a deliberate, security-gated v2
capability — not a quick add.**

Specific sub-decisions (all detailed + justified in the companion doc):

- **Runtime model.** A team's VM is a `VirtualMachine` (`kubevirt.io/v1`) with a
  `dataVolumeTemplates` entry that CDI populates from an imported disk (cloud image via
  `source.http`/`source.registry`, on `ceph-block` RBD, `volumeMode: Block`). `runStrategy`
  controls power state. cloud-init (`cloudInitNoCloud`) does first-boot setup. A `Service`
  selects the VMI by label and a Traefik `Ingress` gives it the standard
  `<app>.<env>.capstone.uamishub.com` URL. **No Kaniko build** — the "image" is an imported
  OS disk, not a container.

- **Tenancy: a dedicated VM namespace tier, not relaxing the existing ones.** Introduce a
  **`<team>-vm-<env>`** namespace (or an equivalently labelled VM tier) with PSA **`baseline`**
  (the least-privilege profile that still lets `virt-launcher` run; `privileged` only if
  `baseline` proves insufficient under our KubeVirt config). The existing dev/staging/prod
  namespaces stay **`restricted`** and unchanged — container workloads do not inherit VM
  privileges. This mirrors the existing `rook-ceph` precedent
  (`platform-services/rook-ceph/namespace.yaml` is `privileged`). The VM namespace keeps the
  same default-deny NetworkPolicy posture, ResourceQuota, LimitRange, and RBAC pattern as the
  container tiers, adapted for VM kinds.

- **Tenancy fence widening (scoped).** Add `kubevirt.io/VirtualMachine` and
  `cdi.kubevirt.io/DataVolume` to the VM tier's `namespaceResourceWhitelist`.
  `clusterResourceWhitelist` **stays `[]`** — all VM kinds are namespaced, so no cluster-scope
  grant is needed. Live-migration triggering (`VirtualMachineInstanceMigration`) is deferred
  (see prereqs).

- **GitOps wiring.** The VM manifests live in the team repo's `.devops/` overlay exactly like
  a container app, so the **existing env ApplicationSet** (`tenants/_template/applicationset-envs.yaml`,
  matrix of env × `promotion.yaml`) deploys them with no new controller. KubeVirt + CDI
  themselves are installed as **platform** ArgoCD apps (new `applicationsets/kubevirt-*` /
  `cdi-*`), like Rook-Ceph.

- **Scaffolder.** Add `vm` to the `layout` enum in
  `platform-services/backstage/templates/new-capstone-project/template.yaml` and a new
  `skeleton-vm/` that emits a `VirtualMachine` + `DataVolume` + `Service`/`Ingress` + cloud-init
  starter and a VM-aware `promotion.yaml` (no Kaniko stage; the CI workflow either no-ops the
  build or, optionally, bakes a disk image — deferred to v2.1).

- **Prerequisites are blocking and human-gated (see companion §Infra prereqs).** Before any
  team gets a VM: (1) confirm Intel VT-x is enabled in BIOS on all 3 nodes and `/dev/kvm` is
  present; (2) confirm whether Talos needs a machine-config/extension change for KVM and
  re-cut the installer schematic if so (a reboot of all 3 nodes); (3) install
  `virt-operator` + `cdi-operator` (pin the GA versions resolved at install); (4) re-run the
  Cilium deny-test (SEC-011) for the VM tier; (5) add a CephFS filesystem + RWX storage class
  **only if** live-migration is wanted. Software emulation (no KVM) is a functional-but-slow
  fallback for the spike only.

## Options considered

**Option 1 — KubeVirt VM-as-app, opt-in `layout: vm`, dedicated VM namespace tier (CHOSEN).**
- *Chosen:* it is the de-facto standard, reuses the existing GitOps/ApplicationSet/Ingress
  planes, and isolates the privilege blast radius to an explicit VM tier rather than weakening
  the container tenancy guarantee. Honest about the prereqs.

**Option 2 — Relax the existing tenant namespaces to allow VMs in-place.**
- *Rejected:* would drop every tenant namespace from `restricted` to `baseline`/`privileged`,
  weakening the tenancy guarantee for **all** teams (including the 99% who only run
  containers) to serve the few who need VMs. Privilege should be opt-in and contained.

**Option 3 — Run VMs outside Kubernetes (Proxmox/libvirt on a side host) and only proxy.**
- *Rejected:* defeats the "VM as a Kubernetes app" goal — no GitOps, no tenancy fence, no
  unified RBAC/quota/netpol, a second control plane to own. Good fallback only if KVM on
  Talos proves infeasible.

**Option 4 — Kata Containers / gVisor (sandboxed containers, not full VMs).**
- *Rejected for this ask:* gives VM-grade isolation but still requires the workload to be a
  *container image*. It does not solve "I have a VM/appliance and won't containerize," which
  is the actual request. Worth noting as a different tool for a different problem.

## Consequences

**Positive**
- Unlocks a whole class of teams (legacy/desktop/OS-course/appliance) that the container-only
  golden path excludes.
- VMs become first-class IDP citizens: GitOps-deployed, ingress-exposed, under the same
  AppProject/quota/netpol/RBAC model — one mental model for students.
- Privilege is contained to an explicit, separately-reviewed VM tier; the container tenancy
  guarantee is untouched.

**Negative / costs**
- **A large new platform dependency to own:** KubeVirt + CDI (operators, CRDs, `virt-handler`
  DaemonSet, the `virtctl` client) — real learning and maintenance surface, comparable to
  taking on Rook-Ceph.
- **Security surface grows:** a `baseline`/`privileged` namespace + `/dev/kvm` access. Must be
  security-reviewed and deny-tested before go-live.
- **Resource cost is high:** a VM reserves its full RAM/CPU for the guest OS for its whole
  lifetime (no overcommit like idle containers). A handful of VMs can dominate a 3-node
  homelab; quotas must be strict.
- **No live-migration without new storage:** `ceph-block` is RWO. A node drain/reboot stops
  the VM (cold restart) unless a CephFS RWX class is added — node maintenance is disruptive to
  VM tenants.
- **Talos/KVM is an unverified prerequisite** (see open questions) — the capability is blocked
  until KVM on the OptiPlex nodes is confirmed.
- **CI diverges:** the VM path has no Kaniko build, so the reusable-CI contract (`#125`) needs
  a VM-aware branch or a no-op.

## Open questions (must resolve before/within build)

1. **KVM on Talos (BLOCKER).** Confirm: VT-x enabled in BIOS on all 3 nodes; `/dev/kvm`
   present; whether the factory schematic (`8957`) or Talos machine-config needs a change for
   KubeVirt (and if so, the re-cut + 3-node reboot cost). Until confirmed, only software
   emulation works (slow; spike-only). *Recommend a devops spike on one node.*
2. **PSA level — `baseline` vs `privileged`.** Verify the minimum PSA our KubeVirt config
   (non-root `virt-launcher`) actually requires for the VM tier. Security to adjudicate.
3. **Live-migration / RWX.** Decide whether to add a CephFS filesystem + RWX storage class now
   (enables migration + graceful node maintenance) or accept cold-restart-on-drain for v1.
4. **Quota model for VMs.** VMs need much larger, separately-tuned ResourceQuota/LimitRange
   than the container default (`requests.cpu: "2"`, `memory: 2Gi`). Define the VM-tier quota.
5. **Disk image provenance.** Where do team disk images come from — curated platform base
   images in Harbor (containerDisks) vs arbitrary external URLs? Supply-chain + size review.
6. **CI for VMs.** No-op the build, or offer optional disk-image baking? Sequence against the
   reusable-CI work (#125).
7. **`virtctl` / console access.** How do students get serial/VNC console + SSH under the RBAC
   model (no cluster-admin)? Backstage integration vs `virtctl`. **→ RESOLVED / refined in
   ADR-032a** (`adr-032a-vm-tenant-access-ux.md`): key-based SSH from a standard client is the
   daily path (console/VNC is break-glass), with the public SSH transport an operator decision;
   ADR-032a also defines the clone-and-run (pet-VM) model, the pet-vs-immutable disk stance, and
   the VM teardown ledger.

## Component-version summary (Context7 `/kubevirt/user-guide`, verified 2026-06-28)

| Component | Role | Install | Notes |
| --- | --- | --- | --- |
| **virt-operator + KubeVirt CR** | VM runtime (`VirtualMachine`/`VirtualMachineInstance` CRDs, `virt-handler` DaemonSet) | `kubevirt-operator.yaml` + `kubevirt-cr.yaml` from the GitHub `releases/latest` redirect | **Pin the resolved GA version** (do not track `latest`). Runs as an ArgoCD platform app. |
| **cdi-operator + CDI CR** | Disk import (`DataVolume`) | `cdi-operator.yaml` + `cdi-cr.yaml` from `releases/latest` | Pin likewise. Imports cloud images/ISOs/containerDisks to PVCs. |
| **`virtctl`** | Client (console, VNC, `expose`, start/stop) | CLI plugin | Needed for console/VNC; RBAC-scoped access TBD (open Q7). |
| **KVM on Talos** | Hardware acceleration (`/dev/kvm`) | BIOS VT-x + (TBD) Talos config | **Unverified — open Q1.** Software emulation is the slow fallback. |
| **CephFS RWX class** | Live-migration storage | New Rook `CephFilesystem` + StorageClass | **Not present today** (only `ceph-block` RBD/RWO). Optional — open Q3. |
