# Security Review — KubeVirt VM Workload Tier (ADR-032)

- **Reviewer:** security
- **Date:** 2026-06-28
- **Scope:** the VM-tier tenancy blueprint added in this PR —
  `tenants/_template/vm/namespaces/vm-prod.yaml` (Namespace @ PSA `baseline`,
  ResourceQuota, LimitRange, 4 NetworkPolicies, Role/RoleBinding) and
  `tenants/_template/vm/appproject-vm.yaml` (the VM-tier AppProject fence).
- **What this gates:** merging KubeVirt as a v1 capability. The VM tier is a real
  security-boundary change — it introduces the platform's first **non-`restricted`**
  tenant-facing namespace. This review is the gate before that boundary is widened.
- **Sources:** ADR-032 + `kubevirt-vm-workloads-architecture.md`; KubeVirt user-guide
  via Context7 (verified 2026-06-28); in-repo precedents (`rook-ceph/namespace.yaml`,
  `hardening/netpol-runners/runner-netpol.yaml`, `tenants/_template/`); Cilium policy
  semantics from the SEC-011 deny-test (project memory).
- **Note on the findings register:** `artifacts/context/findings-register.md` does not
  exist in this branch. Findings below use local IDs `KVT-n` and cross-reference the
  established `SEC-011`/`SEC-014`/`SEC-019` line of work; fold these into the register
  when it is created.

> **Headline:** APPROVE the blueprint **for merge as a not-yet-installed capability.**
> The design is sound and the privilege relaxation is correctly *contained* —
> `baseline` PSA, no `privileged`, no hostPath, no host namespaces, VM kinds fenced to
> a dedicated AppProject + namespace. **Go-live is BLOCKED** on (1) the ADR-032
> KVM-on-Talos prerequisite and (2) running the VM-tier deny-test in §6 against a live
> install. Do not onboard a team onto this tier until both clear.

---

## 1. The trust boundary that changes

Every tenant namespace today enforces `pod-security.kubernetes.io/enforce: restricted`
— the strongest Pod Security profile. The container tenancy guarantee leans on it: even
if a workload's own `securityContext` is wrong, the namespace rejects privilege at
admission. The VM tier **lowers that wall to `baseline`** for one purpose: KubeVirt's
`virt-launcher` pod cannot run under `restricted`.

The new trust boundary is therefore: *untrusted/student-controlled guest code runs
inside a QEMU/KVM process, inside a `virt-launcher` pod, inside a `baseline`-PSA
namespace, on a shared node.* Everything below assesses what that buys an attacker who
fully controls a VM guest, and proves the blast radius is bounded.

---

## 2. The `virt-launcher` privilege surface (what KubeVirt actually needs)

Verified against the KubeVirt user-guide (Context7, 2026-06-28):

| Requirement | How KubeVirt satisfies it | Privilege implication |
| --- | --- | --- |
| `/dev/kvm` access (HW accel) | **Device plugin** — node advertises `devices.kubevirt.io/kvm`; the pod requests it as a resource | **Not** a privileged container; **not** a hostPath mount. This is the key reason `baseline` (not `privileged`) suffices. |
| Run QEMU non-root | `virt-launcher` runs as **qemu uid/gid 107**, non-root | Satisfies the spirit of `runAsNonRoot`; the gap to `restricted` is the *enforced* `runAsNonRoot:true` + seccomp + cap-drop fields, not actual root. |
| Linux capabilities | adds `NET_BIND_SERVICE` (masquerade/DHCP); historically `SYS_NICE`; **`SYS_PTRACE` dropped in v0.59** | `NET_BIND_SERVICE` is allowed even under `restricted`. `SYS_NICE` (dedicated-CPU/realtime only — not used by our shared-CPU masquerade config) is the one cap outside the `baseline` allow-set; our config does not request it. |
| seccomp | `RuntimeDefault` (or a custom localhost profile for live-migration's userfaultfd, which we do not enable) | `baseline` does not require a seccomp profile; `restricted` does. |
| SELinux | VMIs run under type `container_t` since v0.58 | No custom/`spc_t` SELinux — stays within `baseline`. |
| Networking | `masquerade` + pod network — guest NATed behind the launcher pod IP | Ordinary Service/Ingress/NetworkPolicy apply unchanged (no Multus/bridge, no hostNetwork). |
| Storage | DataVolume → PVC on `ceph-block` (RBD, `volumeMode: Block`) | No hostPath; standard CSI PVC. |

**Conclusion:** for our intended config (shared CPU, masquerade networking, no
live-migration, no PersistentReservation), `virt-launcher` needs only what `baseline`
permits. It does **not** need `privileged`, hostPath, host namespaces, or host ports.

---

## 3. PSA decision — `baseline`, and the blast radius vs `restricted`

**Decision (resolves ADR-032 open Q2): `enforce: baseline`.** Not `restricted`, not
`privileged`. `warn`/`audit` are set to `restricted` so the controllers surface exactly
how far the live `virt-launcher` pods are from `restricted` — the data for a future
tighten (see KVT-2).

**Why not `restricted`:** Modern KubeVirt (≥ v0.59) *can* run standard VMs in a
`restricted` namespace, but that is **fragile and config-dependent** — it holds only
while the KubeVirt CR stays in the fully non-root shape and no commonly-needed feature
(dedicated-CPU `SYS_NICE`, passt binding's `unprivileged_port_start`, hugepages, certain
device plugins) is enabled. A tenant-facing tier should not silently break the day a
team needs such a feature. `baseline` is the deliberate, stable floor.

**Why not `privileged` (the important containment win):** unlike `rook-ceph`
(`platform-services/rook-ceph/namespace.yaml`, genuinely `privileged` — it owns raw
block devices via hostPath + privileged OSD pods), the VM tier needs **none** of that.
`/dev/kvm` comes through a device plugin, not privilege. So the VM tier is a **full step
below** the existing privileged precedent.

**What `baseline` still FORBIDS** (i.e., the blast radius is bounded — an attacker in a
VM-tier namespace still cannot, at admission time, create a pod that):

| `baseline` still blocks | Consequence for an attacker |
| --- | --- |
| `privileged: true` containers | no trivially-root-on-host container |
| host namespaces (`hostNetwork`/`hostPID`/`hostIPC`) | cannot see node network/processes/IPC of other pods |
| `hostPath` volumes | cannot mount the node filesystem |
| host ports (except a narrow set) | cannot bind node ports to intercept traffic |
| adding caps beyond the baseline set (e.g. `SYS_ADMIN`, `NET_ADMIN`, `SYS_NICE`) | cannot grab dangerous kernel capabilities |
| `/proc` mount type `Unmasked`, custom `procMount` | masked `/proc` stays masked |
| host-process / Windows-host (`hostProcess`) | n/a |

**What `baseline` relaxes vs `restricted`** (the entire delta — the precise extra
attack surface this tier accepts):

| `restricted` enforces | `baseline` does NOT | Risk accepted |
| --- | --- | --- |
| `runAsNonRoot: true` | a pod *may* run as root | a malicious **container** in this ns could run as uid 0 (inside the container's user namespace, still unprivileged on the host). `virt-launcher` itself runs non-root. Mitigated by: only VM kinds are whitelisted here (no arbitrary Deployments — see §4). |
| `allowPrivilegeEscalation: false` | may be true | setuid escalation *within* the container only; not a host escape under `baseline`'s other blocks. |
| `capabilities: drop ["ALL"]`, add only `NET_BIND_SERVICE` | may keep the default runtime cap set | the default container cap set (CHOWN, DAC_OVERRIDE, SETUID, …) — standard, not host-dangerous; `SYS_ADMIN`/`NET_ADMIN` still blocked. |
| `seccompProfile: RuntimeDefault\|Localhost` | profile may be unset | a container could run unconfined-seccomp → larger syscall surface to the host kernel. **This is the single most material relaxation** and the main reason go-live requires the deny-test + keeping the tier tiny. |

Net: the realistic extra surface is "a container in the VM namespace may be root /
unconfined-seccomp inside its own sandbox." There is **no new host-escape primitive** at
`baseline` (privileged/hostPath/host-ns/dangerous-caps all still blocked). The residual
kernel-syscall surface (no enforced seccomp) is the reason this tier must stay small and
deny-tested, and is captured as KVT-2 (tighten to `restricted` post-verification).

---

## 4. What an attacker who fully owns a VM guest can / cannot reach

Assume worst case: a student (or compromised guest) has root inside the VM and shell on
the `virt-launcher` pod's network identity.

**CANNOT reach (enforced controls):**
- **Other tenants' pods/namespaces** — `default-deny-all` egress + no cross-namespace
  allow rule; Cilium enforces this by pod identity (proven by SEC-011). The
  `0.0.0.0/0` excepts in the importer policy also exclude the pod CIDR (10.244/16).
- **The Kubernetes API server (ClusterIP path)** — no egress rule permits 10.96.0.1:443.
  The VM/guest gets DNS + intra-ns only. (The importer policy's `:443` external rule
  excepts the service CIDR.)
- **The host node filesystem / other host resources** — `baseline` blocks hostPath +
  host namespaces; `/dev/kvm` is the only host device, via the device plugin.
- **Arbitrary external network from the guest** — the `virt-launcher`/guest pod gets
  **no** external egress; only the CDI importer pod (by label) gets `:443` to fetch the
  disk image. A guest cannot exfiltrate/C2 outbound by default.
- **Cluster-scoped objects** — AppProject `clusterResourceWhitelist: []`. No CRDs,
  ClusterRoles, PVs, Namespaces.
- **Container workloads in this ns** — `Deployment`/`ReplicaSet`/`HPA` are not in the VM
  project whitelist, so the relaxed-PSA namespace cannot be repurposed as a home for
  arbitrary privileged-ish containers (defense-in-depth on top of PSA).
- **VMs in the restricted tiers** — VM kinds are whitelisted only in the `__TEAM__-vm`
  project; a team cannot create a VM in `__TEAM__-dev/staging/prod` (GitOps fence) and
  `restricted` PSA would reject `virt-launcher` there anyway (admission fence).

**CAN reach (intended / residual):**
- **Cluster DNS** (CoreDNS, kube-system :53) — required; same as every tier.
- **Intra-namespace pods** — the VM's own helpers (a self-contained whole-project VM
  should have few/none).
- **Traefik → the VM's own Service** — inbound for the URL.
- **The apiserver via a node IP (:6443)** — *if reached*, stays **RBAC-gated**: this is
  the SEC-011 residual (`apiserver-cnp.yaml`) — a Cilium `ipBlock` except cannot subtract
  the apiserver identity. **Mitigation:** the VM/importer pods do not mount a usable SA
  token by default, and the namespaced `team-developer-vm` Role grants nothing cluster-
  scoped. Tracked as KVT-3 (verify token automounting is off on the VM/importer SAs).
- **Own node's host** — pod→own-node-host is not policy-enforced without Cilium Host
  Firewall (SEC-019). Pre-existing residual, not specific to VMs; re-confirmed by the
  deny-test. The `baseline` PSA blocks the host-escape primitives that would make this
  useful.

---

## 5. STRIDE on the VM-tier trust boundary

| Threat | Vector | Control | Residual |
| --- | --- | --- | --- |
| **Spoofing** | guest forges another tenant's identity to Traefik/API | masquerade NATs guest behind the launcher pod identity; no API egress | low |
| **Tampering** | guest mounts host fs / edits node | `baseline` blocks hostPath + host-ns | low |
| **Repudiation** | actions untraceable | objects carry `platform.capstone/{team,semester,env,tier}` labels; `audit:restricted` logs PSA violations | low |
| **Information disclosure** | read other tenants' data / secrets | default-deny cross-tenant; no raw Secret in whitelist (SealedSecret/ESO only); no API egress | low |
| **Denial of service** | exhaust node RAM (VMs pin full RAM) | strict ResourceQuota (requests==limits, `count/virtualmachines: 1`, 6Gi cap) + LimitRange | **medium** — see KVT-1 (homelab has no overcommit headroom; a few VM teams can dominate the cluster) |
| **Elevation of privilege** | escape VM→pod→host | `/dev/kvm` via device plugin (not privileged); `baseline` blocks privileged/hostPath/host-ns/dangerous-caps; QEMU/KVM breakout is the only path and requires a hypervisor 0-day | **medium-low** — unconfined-seccomp relaxation (KVT-2) widens the guest→host-kernel syscall surface; the reason for the small-tier + deny-test gate |

---

## 6. SEC-011 VM-tier deny-test plan (run post-install, before any team go-live)

Mirrors the SEC-011 Cilium deny-test. Prereqs: KubeVirt + CDI installed; one throwaway
`team-vmtest-vm-prod` namespace rendered from this blueprint; a second throwaway
`team-other-*` tenant for cross-tenant probes; the netpols actually **enforced** (Cilium,
not flannel — Talos default flannel makes all netpol inert; confirm Cilium is the active
CNI first, per the Cilium-swap memory). Run each; **all must match Expected**.

| # | Test | How | Expected |
| --- | --- | --- | --- |
| **T1 — VM admits at baseline** | create the sample VM (ADR-032 §6a) in `team-vmtest-vm-prod` | `kubectl apply` the VM; `kubectl get vmi -n team-vmtest-vm-prod` | VMI `Running`; `virt-launcher` pod **admitted** (no PSA rejection). Check `kubectl get events` for PSA `audit/warn` lines → records the restricted-gap for KVT-2. |
| **T2 — privileged pod still blocked** | attempt a `privileged: true` (and a `hostPath`) pod in the VM ns | `kubectl apply` a privileged pod | **REJECTED** by `baseline` PSA admission. Proves the wall is only lowered to baseline, not removed. |
| **T3 — no container Deployment via VM project** | sync a `Deployment` through the `__TEAM__-vm` AppProject | declare a Deployment in the VM overlay | ArgoCD **blocks** (kind not in `namespaceResourceWhitelist`). |
| **T4 — no VM in restricted tier** | declare a `VirtualMachine` in `team-vmtest-dev` via the container project | sync it | ArgoCD **blocks** (kind not whitelisted) AND/OR `restricted` PSA rejects `virt-launcher`. |
| **T5 — cross-tenant egress denied** | from the VM serial console (`virtctl console`), curl another tenant's pod IP / Service ClusterIP | `curl --max-time 5 <team-other pod IP>` | **timeout/refused** (default-deny + Cilium pod-identity). |
| **T6 — apiserver ClusterIP denied** | from the VM, curl `https://10.96.0.1:443` | `curl -k --max-time 5 https://10.96.0.1` | **timeout** (no API egress rule). |
| **T7 — guest external egress denied** | from the VM, curl an internet host on :443 | `curl --max-time 5 https://example.com` | **timeout** (only the importer pod label gets `:443`, not the guest/launcher). |
| **T8 — importer egress ALLOWED** | trigger a fresh DataVolume import (http + registry sources) | watch the importer pod + DataVolume `Succeeded` | import **succeeds**. **Also: `kubectl get pod -n <ns> --show-labels`** — confirm the importer label matches `app: containerized-data-importer`; if our CDI version differs, the policy failed closed → fix `matchLabels`. |
| **T9 — VM URL works (ingress)** | hit `https://<app>.prod.capstone.uamishub.com` | external curl/browser | **200** from the guest service (Traefik→launcher). |
| **T10 — cross-tenant ingress denied** | from a `team-other` pod, curl the VM's Service | `curl --max-time 5 <vm svc>.team-vmtest-vm-prod` | **timeout** (default-deny ingress; only kube-system/intra-ns allowed). |
| **T11 — kubelet probes work** | confirm the VMI stays Ready under default-deny | `kubectl describe vmi` / launcher pod readiness | **Ready** (host→local-pod permitted; SEC-019). |
| **T12 — SA token not usable** | from the VM/importer, try the apiserver via a node IP with any mounted token | `curl -k https://<nodeIP>:6443/api --header "Authorization: Bearer $(cat /var/run/.../token 2>/dev/null)"` | **401/403** or no token present (KVT-3). Confirms the SEC-011 apiserver-via-node-IP residual stays RBAC-gated for VMs. |
| **T13 — quota cap enforced** | attempt a 2nd VM / oversize guest in the VM ns | apply a 2nd VirtualMachine | **rejected** by `count/virtualmachines.kubevirt.io: "1"` / memory quota. |

A run is a PASS only if T1, T8, T9, T11 ALLOW and T2–T7, T10, T12, T13 DENY.

---

## 7. Findings

| ID | Severity | Finding | Remediation |
| --- | --- | --- | --- |
| **KVT-1** | **Medium** | **No-overcommit RAM exhaustion / DoS.** VMs pin full guest RAM for life on a 3-node/~30GB-free homelab. Several VM teams can starve the cluster (the platform itself runs ArgoCD/Harbor/Ceph/Vault/monitoring/ARC). | Implemented: strict per-ns quota (`requests==limits` 6Gi, `count/virtualmachines: 1`, storage 60Gi) + LimitRange. **Additional control needed:** cap the *number* of `layout: vm` teams platform-side (recommend ≤ 2–3) — a per-cohort policy, not enforceable by a per-namespace quota. Track as a platform guardrail. |
| **KVT-2** | **Low** | **`baseline` leaves seccomp unenforced** (the material relaxation vs `restricted`), widening the guest→host-kernel syscall surface. | Keep the tier small + deny-tested (this review). After install, read the `warn/audit: restricted` output from real `virt-launcher` pods (T1); if they are restricted-compliant under our pinned CR, **tighten `enforce` to `restricted`**. Re-review before any move to `privileged`. |
| **KVT-3** | **Low** | **SA-token reachability to apiserver-via-node-IP** is a known SEC-011/SEC-019 residual that an ipBlock except cannot close. | Verify `automountServiceAccountToken: false` on the VM + CDI importer ServiceAccounts (T12); the `team-developer-vm` Role grants nothing cluster-scoped, so even a reached apiserver yields no privilege. Inherits the SEC-011 RBAC-gated posture. |
| **KVT-4** | **Low** | **CDI importer egress depends on the pod label** `app: containerized-data-importer`. If the pinned CDI version uses a different label, the importer cannot pull. | Fails **closed** (safe). Confirm the live importer label in T8 and adjust `matchLabels` if needed. Document the pinned CDI version + its importer label. |
| **KVT-5** | **Info** | **Disk-image provenance (ADR-032 open Q5).** The importer `:443` egress is `0.0.0.0/0`-wide; arbitrary external `source.http` URLs are a supply-chain risk. | Prefer **curated platform base images in Harbor** (`source.registry`, in-cluster path). Once curated, tighten the importer external `:443` to specific FQDNs/CIDRs (Cilium FQDN policy) or drop external egress entirely. |
| **KVT-6** | **Info** | **CI/validation integration.** The repo `make validate` RBAC-name guard passes `team-developer-vm` only because the line contains the substring `team-developer`; the argocd-rbac project guard (`[4/4]`) globs `tenants/*/appproject.yaml` and will not discover a rendered `appproject-vm.yaml`. | Non-blocking today (VM project roles are inline, not in `argocd-rbac-cm.yaml`). When `render-tenant` emits the VM tier into `tenants/team-*/`, extend the guards to recognize `appproject-vm.yaml` + the `team-developer-vm` name explicitly. |

No Critical or High findings. The privilege relaxation is correctly contained.

---

## 8. OWASP / control checklist (what was assessed)

- **Broken access control:** AppProject `clusterResourceWhitelist: []`, scoped
  `namespaceResourceWhitelist` (VM kinds only, no Deployment), namespaced Role (no
  cluster RBAC, no raw Secret), destinations fenced to `__TEAM__-vm-*`. PASS.
- **Security misconfiguration:** PSA `baseline` (justified, not `privileged`), warn/audit
  canary at restricted, no hostPath/host-ns/privileged. PASS (with KVT-2 tighten path).
- **Sensitive data exposure:** raw `Secret` excluded (SealedSecret/ESO only); no API
  egress; default-deny cross-tenant. PASS.
- **Vulnerable components / supply chain:** disk-image provenance flagged (KVT-5); pin
  KubeVirt/CDI GA versions (ADR-032). Assessed; install-time follow-up.
- **Insufficient logging:** PSA `audit:restricted` + standard cluster audit; labels for
  attribution. Adequate.
- **SSRF/injection/XSS/auth:** not applicable to this infra-manifest change (no app
  code, no request handling introduced here).

## 9. Verdict

**APPROVE for merge** as a blueprint (not installed; `_template` is excluded from the
tenants ApplicationSet). **Go-live remains BLOCKED** until: ADR-032 KVM-on-Talos
prereq cleared; KubeVirt+CDI installed at pinned GA; and the §6 deny-test passes on a
live Cilium-enforced cluster. PSA level for the tier: **`baseline`** (enforce), with a
defined path to tighten toward `restricted` (KVT-2).
