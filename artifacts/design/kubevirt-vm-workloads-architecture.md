# Design — "True VM as an app" via KubeVirt

**Companion to ADR-032.** Design + spike only. Nothing in this document is installed or
applied; the manifests are illustrative spikes for review.

**Scope of this research.** Asked: design a capability so teams that can't/won't containerize
can deploy a real VM that runs as a workload inside the Capstone IDP's Kubernetes cluster,
reached via a URL like any other app. Covered: (1) how a VM runs as an app; (2) fit with the
tenant model (PSA/netpol/quota/RBAC/AppProject); (3) GitOps wiring; (4) a `layout: vm`
scaffold option; (5) infra prereqs + risks (Talos/KVM, storage, cost); (6) spike manifests.
All KubeVirt/CDI facts are Context7-verified against `/kubevirt/user-guide` (2026-06-28);
all platform facts cite real files in this repo.

**Confidence:** High on the KubeVirt mechanics and the tenant-model conflicts (both verified
against sources/files). Medium on Talos/KVM specifics (needs a one-node spike — open Q1).
Medium on exact PSA level (`baseline` vs `privileged` — open Q2).

---

## 1. How a VM runs as an app (the "no Docker" experience)

KubeVirt adds a `VirtualMachine` CRD. The controller (`virt-controller`) turns a running
`VirtualMachine` into a `VirtualMachineInstance` (VMI), which `virt-handler` (a DaemonSet)
launches as a **QEMU/KVM process inside an ordinary pod** (`virt-launcher`). So a VM is
scheduled, networked, stored, and observed exactly like any other pod — but the workload
inside is a full guest OS, not a container.

The pieces, end to end:

1. **Disk** — CDI's `DataVolume` imports a disk image into a PVC. Source can be an HTTP cloud
   image (`source.http`), a container registry disk (`source.registry`, `docker://…`), or an
   uploaded image. The PVC lives on **`ceph-block`** (RBD); for VMs we use `volumeMode: Block`
   (raw block device, the efficient path for RBD-backed VMs). Access mode is **`ReadWriteOnce`**
   (RBD is RWO).
2. **VM** — a `VirtualMachine` with a `dataVolumeTemplates` entry (CDI creates+populates the
   PVC, and deletes it with the VM), a `domain` (vCPUs, memory, disks, NICs), `runStrategy`
   (power state), and volumes for the data disk + a cloud-init disk.
3. **First-boot setup** — `cloudInitNoCloud.userData` (a `#cloud-config`) sets the password,
   injects SSH keys, and runs the team's install commands (their runtime/app). This is the
   "no Dockerfile" equivalent of a build: the team describes setup in cloud-init instead.
4. **Networking** — `interfaces: [{ masquerade: {} }]` + `networks: [{ pod: {} }]` puts the VM
   on the **pod network** (NAT behind the launcher pod's IP). This works with the cluster's
   Cilium CNI and the existing NetworkPolicies with no Multus/bridge complexity. (Bridge/Multus
   is a documented alternative for L2 attachment but is out of scope.)
5. **URL** — a `Service` selects the VMI by label (`kubevirt.io/domain: <vm>`); a Traefik
   `Ingress` fronts it, giving the standard `<app>.<env>.capstone.uamishub.com` host. From the
   student's view it is "an app with a URL." (`virtctl expose` can generate the Service, but we
   declare it in GitOps instead.)

`runStrategy` (verified) governs power: `Always` (keep running, restart on failure),
`Halted` (defined but powered off), `Manual` (start/stop via `virtctl`), `RerunOnFailure`.

**Developer experience:** the student picks `vm` in the scaffolder, edits a cloud-init block
and (optionally) points at a base image, opens a PR. No Dockerfile, no image build. The
platform deploys the VM and gives it a URL.

## 2. Fit with the tenant model

The current per-tenant model (real files):

- **Namespaces** `tenants/_template/namespaces/{dev,staging,prod,preview}.yaml` —
  `pod-security.kubernetes.io/enforce: restricted` (v1.31), ResourceQuota
  (`requests.cpu: "2"`, `requests.memory: 2Gi`, `limits.cpu: "4"`, `limits.memory: 4Gi`,
  `pods: "10"`), LimitRange (per-container max `cpu: "1"`, `memory: 1Gi`), three
  NetworkPolicies (default-deny ingress+egress, allow Traefik ingress + intra-ns, allow DNS
  egress + intra-ns), and a namespaced `team-developer` Role.
- **AppProject** `tenants/_template/appproject.yaml` — `clusterResourceWhitelist: []` and an
  enumerated `namespaceResourceWhitelist` (ConfigMap, Service, ServiceAccount, Deployment,
  ReplicaSet, HPA, Ingress, SealedSecret, ExternalSecret, SecretStore). **No VM kinds.**

### 2a. The PSA conflict (the central issue)

`virt-launcher` requires a `/dev/kvm` device, Linux capabilities (`SYS_NICE`,
`NET_BIND_SERVICE`, and others), and a custom seccomp profile. The **`restricted`** PSA
profile forbids all of that (it mandates `runAsNonRoot`, `drop: ["ALL"]` capabilities,
`seccompProfile: RuntimeDefault`, no privilege escalation). **A VM cannot run in a
`restricted` namespace.** This is the hard blocker.

**Resolution — a dedicated VM namespace tier, not relaxing the existing ones.** Introduce a
separate VM namespace per env (e.g. `<team>-vm-<env>`, or the env namespace gated by a
`platform.capstone/vm: allowed` label) with PSA **`baseline`** — the least-privilege profile
that still permits `virt-launcher` under KubeVirt's non-root configuration. Keep `privileged`
as the fallback only if `baseline` proves insufficient (open Q2 — security to verify against
our KubeVirt CR config). Everything else about the namespace stays the same as the container
tiers (default-deny netpol, quota, LimitRange, RBAC).

**Precedent in-repo:** `platform-services/rook-ceph/namespace.yaml` already runs
`pod-security.kubernetes.io/enforce: privileged` for a privileged platform component — so a
relaxed-PSA namespace is an established, reviewed pattern here, not a new exception in kind.

**Why not relax the existing namespaces:** that would drop *every* tenant namespace (including
the container-only majority) below `restricted`, weakening the tenancy guarantee for all teams
to serve the few who need VMs. Privilege must be opt-in and contained.

### 2b. NetworkPolicy implications

With masquerade networking the VM's traffic egresses from the `virt-launcher` pod, so the
**existing default-deny + allow-Traefik-ingress + allow-DNS-egress** policies apply unchanged
and are enforced by Cilium (proven by SEC-011). Additions the VM tier needs:

- **KubeVirt control-plane reach:** `virt-handler`/`virt-launcher` talk to the KubeVirt system
  components. The default-deny egress must allow the VM namespace to reach the `kubevirt`
  system namespace (and CDI's importer pods to reach the image source — typically `:443`
  egress, matching the existing runner `:443`-only egress posture, see
  [[capstone-runner-netpol-443-only]]).
- **Re-run the deny-test (SEC-011) for the VM tier** before go-live — a VM is a new traffic
  shape; confirm cross-team isolation still holds with masquerade.

### 2c. AppProject fence

- `clusterResourceWhitelist` **stays `[]`** — `VirtualMachine`, `VirtualMachineInstance`, and
  `DataVolume` are all **namespaced**, so no cluster-scope grant is required (the strong
  tenancy boundary is preserved).
- Add to the VM tier's `namespaceResourceWhitelist`:
  - `group: kubevirt.io, kind: VirtualMachine`
  - `group: cdi.kubevirt.io, kind: DataVolume`
  - (VMIs are created by the controller from the VM, not by the user — not strictly required in
    the whitelist. `VirtualMachineInstanceMigration` is deferred with live-migration.)
- The `team-developer` Role gains read/limited-write on `kubevirt.io/virtualmachines` (+
  `virtualmachineinstances`, `pods/log`) so students can inspect/start/stop their VM; **no**
  rights to the KubeVirt system components.

### 2d. Quota

VMs cannot share the container LimitRange (`max cpu: "1", memory: 1Gi` — too small for a
guest OS). The VM tier needs a separate, larger ResourceQuota/LimitRange (open Q4), and
because a VM reserves its full RAM for its lifetime, the quota should be **strict and small**
(e.g. 1–2 VMs per team on this 3-node homelab). See §5 cost.

## 3. GitOps wiring

Two layers, both reusing existing patterns:

- **Platform layer (install KubeVirt + CDI):** add ArgoCD apps —
  `applicationsets/kubevirt-operator-app.yaml`, `kubevirt-cr-app.yaml`,
  `cdi-operator-app.yaml`, `cdi-cr-app.yaml` — modeled on the existing
  `applicationsets/rook-ceph-operator-app.yaml` / `rook-ceph-cluster-app.yaml`. Pin the
  resolved GA versions (don't track `latest`). This is the heavy, human-gated install.
- **Tenant layer (a team's VM):** the VM/DataVolume/Service/Ingress manifests live in the
  **team repo's `.devops/chart` overlay**, exactly like a container app's Deployment. The
  **existing env ApplicationSet** (`tenants/_template/applicationset-envs.yaml` — matrix of
  `{dev,staging,prod}` × the app repo's `.devops/promotion.yaml`) renders and syncs them with
  **no new controller**. The VM's `promotion.yaml` points its overlays at the VM namespace
  tier.

**Disk sourcing in GitOps:** the disk is *not* a git artifact. The `DataVolume` references an
external image (a curated platform base image in Harbor as a containerDisk, or an external
cloud-image URL). The git manifests carry the *reference + cloud-init*, not the bytes. Image
provenance is open Q5 (recommend curated platform base images in Harbor over arbitrary URLs).

## 4. Scaffolder `layout: vm` option

Today `platform-services/backstage/templates/new-capstone-project/template.yaml` exposes a
`layout` enum: `single` (one `app/`, one Deployment) and `frontend-backend` (two components),
each with its own skeleton (`skeleton/`, `skeleton-multi/`) selected by an `if:` guard on the
`fetch:template` step; all downstream steps (publish/register/harbor-onboard/render-tenant/
tenant-pr) are shared.

**Add a third option:**

- Extend the `layout` enum with `vm` (+ enumName "Virtual machine (no Docker)"), and add a
  guarded `fetch-skeleton-vm` step pointing at a new `skeleton-vm/`.
- **`skeleton-vm/` emits** (instead of `app/` + Dockerfile + container chart):
  - `vm/cloud-init.yaml` — a `#cloud-config` starter the student edits (the install commands
    that set up their runtime/app), surfaced as the primary editable file.
  - `.devops/chart/base/` — `virtualmachine.yaml`, `datavolume`-via-`dataVolumeTemplates`,
    `service.yaml`, `ingress.yaml` (+ overlays per env), parameterized by `appName`/`team`/
    `port`/`semester` like the existing skeletons.
  - `.devops/promotion.yaml` — VM-aware: the per-env `overlay`/`gate` schema is unchanged, but
    there is **no Kaniko build** (see §CI below).
  - `.devops/vm-metadata.yaml` — the small set of student-tunable fields (base image, vCPUs,
    memory GiB, disk GiB, port), analogous to the existing `app-metadata.yaml`.
  - `README` / TechDocs explaining the cloud-init-instead-of-Dockerfile model.
- **`render-tenant` change:** the rendered tenant tree gains the VM namespace tier
  (`<team>-vm-<env>` with `baseline` PSA + VM-sized quota) and the AppProject whitelist
  additions. This is a change to `tenants/_template/` + the `capstone:render-tenant` action
  (`platform-services/backstage/app/plugins/scaffolder-backend-module-capstone/src/actions/renderTenant.ts`).

### CI difference (no Kaniko)

The container path's CI builds an image with Kaniko in ARC and bumps the overlay tag. The VM
path has **no image to build** — the disk is an *imported OS image*, not a container. So the
VM skeleton's `.github/workflows/` either:

- **(v1, recommended)** no-ops the build (validation/lint only; the `DataVolume` references a
  fixed base image, and "deploy" = ArgoCD syncing the VM manifest on merge/tag per the same
  `promotion.yaml` triggers); or
- **(v2.1, optional)** *bakes* a disk image — boot a base VM, apply changes, snapshot to a
  containerDisk pushed to Harbor — a heavier pipeline deferred until there's demand.

This must be sequenced against the reusable-CI work (`#125`,
[[capstone-reusable-ci-and-script-centralization]]) — the reusable `tenant-build.yaml` needs a
VM-aware branch or a no-op caller.

## 5. Infra prereqs + risks

### Talos / KVM (open Q1 — BLOCKER)

- **Nodes:** 3× OptiPlex 7080 (10th-gen Intel), converged/untainted, Cilium CNI, Ceph
  replica-3 — `clusters/real-talos/talconfig.yaml`. Installer = factory schematic **`8957`**
  (tailscale + iscsi-tools + util-linux-tools + intel-ucode) — **no virtualization extension**.
- **What KubeVirt needs:** `/dev/kvm` on each node (hardware-accelerated KVM). On bare-metal
  Intel with VT-x enabled, the kernel `kvm`/`kvm_intel` modules expose `/dev/kvm`, and KubeVirt's
  `virt-handler` advertises it as `devices.kubevirt.io/kvm`.
- **Unknowns to verify on one node first:** (a) VT-x enabled in BIOS on all 3 boxes;
  (b) `/dev/kvm` actually present under Talos (`talosctl`/a probe pod); (c) whether Talos needs
  a machine-config change (kernel modules) or a factory-schematic re-cut to enable KVM — and if
  so, the cost is a re-cut **+ a rolling reboot of all 3 nodes** (the same node-1-first care as
  the Cilium bring-up).
- **Fallback:** KubeVirt **software emulation** (no `/dev/kvm`) runs VMs without VT-x but is
  **much slower** — acceptable only to prove the spike, not for real workloads.
- *Recommendation:* a devops spike on a single node to confirm `/dev/kvm` before committing.

### Storage / live-migration (open Q3)

- Only storage class is **`ceph-block`** (RBD, RWO) — `applicationsets/rook-ceph-cluster-app.yaml`.
- **Live-migration requires RWX** shared storage (the disk must be mountable on source + target
  simultaneously). RBD is RWO, so **live-migration is not possible today.** Consequence: a node
  drain/reboot (maintenance, upgrades) **stops the VM** and it cold-restarts elsewhere — VM
  tenants feel node maintenance.
- *To enable migration:* add a Rook **`CephFilesystem`** + a CephFS RWX StorageClass and put VM
  disks there. Extra Ceph footprint + a deliberate decision — recommend deferring to a v2.1
  unless graceful node maintenance for VMs is required.

### Resource cost (high)

- A VM **reserves its full guest RAM/CPU for its entire lifetime** — no overcommit, no
  scale-to-zero like an idle container. Even a small Linux VM is ~1–2 GiB RAM + a vCPU,
  permanently, plus `virt-launcher` overhead.
- On a 3-node homelab already running ArgoCD, Harbor, Ceph, Cilium, Vault, monitoring, ARC,
  and tenant containers, **a handful of VMs can dominate the cluster.** Strict VM-tier quotas
  (1–2 small VMs per team) and a cap on how many teams may use `layout: vm` are essential.

### Security risks

- The VM tier is `baseline`/`privileged` PSA with `/dev/kvm` access — a larger surface than the
  `restricted` container tiers. Requires security review + the SEC-011 deny-test re-run before
  go-live.
- Disk image provenance (open Q5): arbitrary external images are a supply-chain risk; prefer
  curated platform base images in Harbor.

## 6. SPIKE manifests (illustrative — do not apply)

### 6a. Sample VM + DataVolume + Service + Ingress

```yaml
# SPIKE — a Fedora cloud-image VM as an "app" in a (would-be) VM-tier namespace.
# Illustrative only; not for apply. PSA of the namespace must be baseline/privileged.
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: sample-vm
  namespace: team-sample-vm-dev          # dedicated VM tier (baseline PSA), NOT the restricted container ns
  labels:
    platform.capstone/team: sample
    platform.capstone/env: dev
spec:
  runStrategy: Always                      # Always | Halted | Manual | RerunOnFailure
  dataVolumeTemplates:
    - metadata:
        name: sample-vm-rootdisk
      spec:
        storage:
          accessModes: ["ReadWriteOnce"]   # ceph-block (RBD) is RWO
          volumeMode: Block                # raw block — efficient for RBD-backed VMs
          storageClassName: ceph-block
          resources:
            requests:
              storage: 10Gi
        source:
          http:                            # CDI imports the disk image into the PVC
            url: https://download.fedoraproject.org/.../Fedora-Cloud-Base.x86_64.qcow2
          # alt: registry: { url: "docker://harbor.capstone.uamishub.com/platform/base-images/fedora:41" }
  template:
    metadata:
      labels:
        kubevirt.io/domain: sample-vm      # the Service selects on this
    spec:
      domain:
        cpu:
          cores: 2
        resources:
          requests:
            memory: 2Gi                    # reserved for the VM's whole lifetime
        devices:
          disks:
            - name: rootdisk
              disk: { bus: virtio }
            - name: cloudinit
              disk: { bus: virtio }
          interfaces:
            - name: default
              masquerade: {}               # pod-network NAT — works with Cilium + existing netpol
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          dataVolume:
            name: sample-vm-rootdisk
        - name: cloudinit
          cloudInitNoCloud:
            userData: |                    # first-boot setup = the "no Dockerfile" install step
              #cloud-config
              password: changeme
              chpasswd: { expire: False }
              ssh_pwauth: True
              packages:
                - nginx
              runcmd:
                - [ systemctl, enable, --now, nginx ]   # the team's runtime/app
---
apiVersion: v1
kind: Service
metadata:
  name: sample-vm
  namespace: team-sample-vm-dev
spec:
  selector:
    kubevirt.io/domain: sample-vm          # selects the VMI's launcher pod
  ports:
    - name: http
      port: 80
      targetPort: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sample-vm
  namespace: team-sample-vm-dev
spec:
  rules:
    - host: sample-vm.dev.capstone.uamishub.com   # the standard "app URL"
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: sample-vm
                port: { number: 80 }
```

### 6b. AppProject whitelist delta (VM tier)

```yaml
# additions to namespaceResourceWhitelist for the VM tier (clusterResourceWhitelist stays [])
- group: kubevirt.io
  kind: VirtualMachine
- group: cdi.kubevirt.io
  kind: DataVolume
```

### 6c. VM namespace PSA delta

```yaml
# the VM-tier namespace differs from tenants/_template/namespaces/*.yaml ONLY here:
metadata:
  labels:
    pod-security.kubernetes.io/enforce: baseline   # (restricted forbids virt-launcher); privileged only if baseline insufficient
    pod-security.kubernetes.io/enforce-version: v1.31
# + a VM-sized ResourceQuota/LimitRange (NOT the container max cpu:1/mem:1Gi)
```

### 6d. Scaffold `layout: vm` sketch (template.yaml delta)

```yaml
# in parameters.layout.enum / enumNames — add a third option:
enum: [ single, frontend-backend, vm ]
enumNames:
  - 'Single component (one app — default)'
  - 'Frontend + backend (two components, one repo)'
  - 'Virtual machine (no Docker — a real VM as an app)'

# new guarded fetch step, mirroring fetch-skeleton / fetch-skeleton-multi:
- id: fetch-skeleton-vm
  name: Render project skeleton (virtual machine)
  if: ${{ parameters.layout === "vm" }}
  action: fetch:template
  input:
    url: ./skeleton-vm
    values: { appName: ..., team: ..., semester: ..., port: ..., ... }
    copyWithoutTemplating: [ '.github/**', '**/.github/**', '.devops/ci/**', '**/.devops/ci/**' ]
# downstream publish / register / harbor-onboard / render-tenant / tenant-pr are SHARED
# (render-tenant additionally emits the <team>-vm-<env> tier; harbor-onboard is a no-op
#  for the no-build VM path, or provisions a base-image pull project).
```

---

## Headline recommendation

**Worth doing — as a deliberate, security-gated v2 capability, not a quick add.** KubeVirt is
the right, standard tool, and it slots cleanly into the existing GitOps/ApplicationSet/Ingress
planes and the opt-in scaffolder-layout pattern. The "VM as an app with a URL" experience is
achievable and genuinely unlocks teams the container-only golden path excludes.

**The cost is real and front-loaded:** (1) a verified KVM-on-Talos prerequisite (one-node
spike + possibly a schematic re-cut and 3-node reboot — this is the gating unknown); (2) a new
`baseline`/`privileged` VM namespace tier that must be security-reviewed and deny-tested,
contained so the container tenancy guarantee is untouched; (3) widening the AppProject fence to
two namespaced VM kinds (no cluster-scope grant needed); (4) strict quotas because VMs are
heavy and this is a 3-node homelab; (5) no live-migration until a CephFS RWX class is added —
node maintenance cold-restarts VMs; (6) a no-Kaniko CI branch sequenced against the
reusable-CI work.

**Suggested path:** (a) devops KVM spike on one node to clear open Q1; if clear, (b) install
KubeVirt + CDI as pinned platform ArgoCD apps in a non-tenant test namespace and run the 6a
spike; (c) security review of the VM-tier PSA + netpol + the deny-test; (d) only then build the
`skeleton-vm/` + `render-tenant` + AppProject changes and ship `layout: vm`. Decide live-
migration (CephFS RWX) and the VM-baking CI as explicit v2.1 follow-ups.

**Decision points that need a human:** approve the capability + the prereq spend (ADR-032
architecture gate); the PSA level for the VM tier; whether to add CephFS RWX now; the VM-tier
quota; and the disk-image provenance policy.
