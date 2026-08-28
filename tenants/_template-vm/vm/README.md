# tenants/_template/vm — the OPT-IN VM workload tier (KubeVirt, ADR-032)

This subtree is the blueprint for a team that deploys a **real virtual machine** as
an app (KubeVirt `layout: vm`) — a whole legacy project lifted into one
self-contained VM because it can't/won't be containerized. It is **opt-in** and
deliberately separate from the container tenant tiers (`../namespaces/*.yaml`).

> **Status: blueprint only — nothing here is applied.** Like the rest of
> `tenants/_template/`, this dir is EXCLUDED from the `tenants` ApplicationSet
> (`applicationsets/tenants-appset.yaml`). It becomes live only when the scaffolder
> `render-tenant` action copies it into a real `tenants/team-<x>/` for a `layout:
> vm` team. KubeVirt + CDI themselves must be installed (platform ArgoCD apps) and
> the ADR-032 prerequisites cleared (KVM-on-Talos, the SEC-011 VM-tier deny-test)
> **before** any team is onboarded onto this tier.

## What's here

| File | Purpose |
| --- | --- |
| `appproject-vm.yaml` | the VM-tier tenancy fence — a SEPARATE AppProject `__TEAM__-vm` that whitelists `VirtualMachine`/`VirtualMachineInstance`/`DataVolume` (+ the cloud-init `Secret`) and targets only `__TEAM__-vm-*` namespaces. `clusterResourceWhitelist: []`. |
| `applicationset-vm.yaml` | the VM env ApplicationSet — a single-env (prod) `matrix(list × git-files promotion.yaml)` App that syncs the APP repo's `.devops/chart/overlays/prod` VM chart into `__TEAM__-vm-prod` under project `__TEAM__-vm`. **Without this the VM tier is a fence + namespace with nothing inside it** (the #376 onboarding bug). The VM analogue of `../_template/applicationset-envs.yaml`. |
| `namespaces/vm-prod.yaml` | `__TEAM__-vm-prod` Namespace at **PSA `baseline`** (not restricted) + VM-sized ResourceQuota + LimitRange + 6 NetworkPolicies (default-deny, Traefik ingress, cloudflared SSH ingress, DNS + intra-ns egress, importer image-pull, and **guest external :53/:443 egress**) + VM-aware Role/RoleBinding. |

The security rationale, blast-radius analysis, and the post-install deny-test plan
live in `artifacts/reviews/kubevirt-vm-tier-security-review.md`.

## Why a separate tier (the security gate)

VMs run via `virt-launcher`, which needs more than the `restricted` Pod Security
profile every container tenant namespace enforces. Rather than weaken `restricted`
for everyone, the VM tier is a dedicated namespace at PSA **`baseline`** — the
tightest profile that still runs `virt-launcher`, and a full step below the
`privileged` rook-ceph precedent (no hostPath, no host namespaces). The privilege
relaxation **and** the VM kinds are fenced together to this one tier:

- A team **cannot** create a VM in their `restricted` container namespaces — the VM
  kinds are whitelisted only in the `__TEAM__-vm` project (GitOps layer) and
  `virt-launcher` would be rejected by `restricted` PSA anyway (admission layer).
- A team **cannot** run arbitrary container Deployments in the relaxed VM namespace
  — `Deployment`/`ReplicaSet`/`HPA` are NOT in the VM project's whitelist.

## Default: ONE VM namespace (`vm-prod`)

A lifted whole-project VM is a single heavyweight artifact and usually needs one
live home, not a dev/staging/prod fan-out. `vm-prod` is that home. A team that
genuinely needs a second VM env copies `namespaces/vm-prod.yaml` to `vm-dev.yaml`
and `s/prod/dev/`; the AppProject destination is a `__TEAM__-vm-*` wildcard, so no
AppProject edit is required.

## Sizing (homelab reality)

VMs reserve their **full guest RAM for their whole lifetime** (no overcommit). On
the 3-node / 16GB-per-node (~30GB free) cluster, the quota is sized for **one
substantial ~2-4 GiB whole-project VM** per team (6Gi reserved incl. overhead). At
the expected ~2-of-10 VM-team rate that is ~12Gi — comfortable. A bigger guest or a
second VM needs an explicit quota bump + a platform capacity review.

## Tokens

Same as the parent template: `__TEAM__`, `__APPNAME__`, `__SEMESTER__`. Substitute
`__APPNAME__` BEFORE `__TEAM__` (a `__TEAM__`-prefixed appName would otherwise be
half-replaced). The team group `__TEAM__-developers` is the same subject used by the
container tier.

## Field notes — things that will bite you (from the crimson-copies-stripped bring-up)

Six failures cost a full afternoon on the second real VM tenant. None were exotic;
all of them present with a symptom that points somewhere other than the cause.

### VMs and DNS — the big one

**The tier's `allow-egress-dns-and-intra-ns` policy does not give a VM working
DNS.** It selects CoreDNS by namespace (pod identity), which only matches traffic
Cilium already translated from the kube-dns ClusterIP in its **socket** load
balancer. Guest traffic never passes through a host socket — it is forwarded out
through the masquerade interface — so socket-LB never runs, Cilium judges the flow
against the ClusterIP's **CIDR identity**, and the query is denied.

Adding a CIDR rule for `10.96.0.10` is *not* the fix. That only gets you to
`action allow`; the packet then goes `-> stack` still addressed to a ClusterIP that
nothing answers. **No NetworkPolicy can translate an address.**

Give the guest resolvers it can reach directly, in the VirtualMachine itself:

```yaml
spec:
  template:
    spec:
      dnsPolicy: None
      dnsConfig:
        nameservers: [1.1.1.1, 1.0.0.1, 8.8.8.8]
```

plus an egress rule for `:53` (see below). The tell-tale symptom is that **every
pod in the namespace resolves fine — including the CDI importer that populated the
VM's own disk — and the guest resolves nothing.**

### The VM gets no external egress by default

Policies 1–5 give the guest DNS-to-kube-system and intra-namespace egress only.
The single `0.0.0.0/0:443` rule is `podSelector`-scoped to the **CDI importer**,
not to the virt-launcher. That is the right default for a lifted legacy VM that
only needs to be *reached* — but a guest that **provisions itself** on first boot
(apt, git, a package registry) is blackholed with no error the platform surfaces,
and there is no working sshd to ask why.

If your VM self-provisions, add a sixth policy selecting the VM
(`podSelector: {matchLabels: {kubevirt.io/domain: <appName>}}`) allowing `:443`
and `:53` to `0.0.0.0/0`, carrying the same `except` list as policy 5 so nothing
in-cluster becomes reachable. Point apt at HTTPS mirrors and git at
`ssh.github.com:443` rather than widening to `:80`/`:22`.

### Pin `volumeMode: Filesystem` on the rootdisk

Left unset, CDI consults its `StorageProfile` for `ceph-block`, whose first RWO
entry is `Block`. The importer runs non-root (uid 107, all caps dropped, baseline
PSA) and cannot open the raw RBD device:

```
blockdev: cannot open /dev/cdi-block-volume: Permission denied
```

The importer CrashLoopBackOffs, the DataVolume sits in `ImportInProgress` forever,
and the VM reports `DataVolumeError`.

### Rebuilding a VM (re-running a failed cloud-init)

cloud-init runs **once per instance** and records that in `/var/lib/cloud` on the
disk. A guest whose provisioning failed cannot be fixed by restarting it — it
boots, sees the run already happened, and finishes in under a minute having done
nothing. **The disk has to be replaced.**

Do **not** delete the DataVolume or its PVC in place. `runStrategy: Always`
recreates the VMI immediately, the new virt-launcher re-references the PVC that is
still terminating under `kubernetes.io/pvc-protection`, and the two deadlock:
kubelet reports `PVC is being deleted` while the PVC waits on the pod that is
waiting on the PVC. It looks like `Scheduling` and it never resolves.

Instead **rename the `dataVolumeTemplate`** (`<app>-rootdisk` → `-v2`, `-v3`, …).
The replacement imports cleanly alongside the old one; once the VMI is restarted
onto it, delete the superseded DataVolume. This is why the tier's storage quota
carries rebuild headroom.

### Make first-boot provisioning observable and resilient

A guest has no reachable sshd (open Q7), so a first boot is only as debuggable as
you made it before you started it:

- echo step markers to `/dev/console` — `virtctl console` is the live view, and a
  failure whose reason is only in lost scrollback costs a whole rebuild cycle;
- bring the web server and a status endpoint up **early**, not at the end — an
  endpoint that exists to observe a slow boot is useless if it only appears once
  the slow part is over;
- wait for DNS to actually resolve before the first network step, and retry
  `apt-get update` rather than aborting. Under emulation `runcmd` genuinely can
  beat the resolver, and a single transient mirror failure under `set -e` kills
  the entire run.

### Timing under `useEmulation: true`

For calibration, a 4-service pnpm monorepo (two Next.js apps) on an 8 vCPU / 8Gi
emulated guest: `pnpm install` ~1 min, full `pnpm build` ~20 min, whole
boot-to-serving ~34 min. Slow but entirely workable — roughly 3–5× native, not the
20× sometimes assumed.

## Follow-up wiring (tracked in ADR-032)

- **Scaffolder `layout: vm`** — DONE: the `vm-app` Backstage template's
  `capstone:render-tenant` step points its `templateUrl` at **this** blueprint
  (`tenants/_template-vm`, not `tenants/_template`), so a VM tenant renders ONLY the
  VM tier — no container envs/preview appset to render-fail on a `layout: vm`
  promotion.yaml (the other half of the #376 bug).
- **VM env ApplicationSet** — DONE: `applicationset-vm.yaml` (above).
- **Team SSH access + clone-and-run + pet-vs-immutable disk** — see
  `artifacts/design/decisions/adr-032a-vm-tenant-access-ux.md` (this PR's companion
  design; cloud-init `ssh_authorized_keys` + per-tenant SSH Service are implemented
  in `skeleton-vm/`; the public SSH transport is an operator decision).
- **Platform install** of `virt-operator` + `cdi-operator` as pinned ArgoCD apps.
- **Live-migration** (CephFS RWX) — deferred; node drain cold-restarts VMs.

## Where VM placement is controlled (it is NOT in this directory)

A recurring wrong turn: this blueprint holds only the VM tier's **tenancy**
scaffolding — AppProject, namespace + quota/LimitRange/NetworkPolicy, and the VM
env ApplicationSet. There is **no VirtualMachine here** to constrain, so node
placement cannot be set from this directory.

The `affinity` block that pins VMs lives in the **VM manifest**, in two places
that must stay in sync:

| What | Where |
|---|---|
| Blueprint for **new** VM tenants | `platform-services/backstage/templates/vm-app/skeleton-vm/.devops/chart/base/virtualmachine.yaml` |
| A **live** tenant | that team's own app repo, `.devops/chart/base/virtualmachine.yaml` |

Editing the skeleton changes what teams two and three are *born* with; it does
**not** retro-fit a team already onboarded, because the scaffolder copies the
skeleton once at onboarding. An existing tenant needs a PR against its own repo.

The current contract (see the comments in those files for the full reasoning):

- **`nodeAffinity`, required**, on `node-role.kubernetes.io/control-plane`. VMs
  are permanent and immovable — RWO RBD, full cpu/memory reserved for life — so
  they belong on the control-plane nodes, leaving the workers for the ephemeral
  build runners that can schedule anywhere. No toleration is needed: the
  control-plane taint is `capstone.io/control-plane=true:PreferNoSchedule`, which
  is soft.
- **`podAntiAffinity`, required**, on `kubevirt.io=virt-launcher` over
  `kubernetes.io/hostname`, **with `namespaceSelector: {}`** — one VM per node.
  The namespaceSelector is load-bearing: VM tenants each live in their own
  `<team>-vm-prod` namespace, and podAntiAffinity otherwise matches only the
  pod's own namespace, which would spread nothing while still reading as correct.

**Capacity cliff:** `required` anti-affinity across three control-plane nodes
means the **fourth** VM tenant will not schedule, and that failure is quiet (the
VirtualMachine sits at `Starting`, the VMI at `Pending`, with no pod to inspect).
Before onboarding a fourth VM team, add a control-plane node or relax the rule to
`preferredDuringSchedulingIgnoredDuringExecution` (weight 100).

**Changing placement on a running VM requires deleting the VMI.** A VMI's spec is
immutable, so a merged manifest change does not move a running guest; deleting the
VMI lets the VM controller recreate it from the new spec. That is a convergence
*to* git, which is why it is legitimate where a live `kubectl patch` against a
GitOps-managed object is not — ArgoCD `selfHeal` reverts those within a minute.
