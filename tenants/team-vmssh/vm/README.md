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
| `appproject-vm.yaml` | the VM-tier tenancy fence — a SEPARATE AppProject `vmssh-vm` that whitelists `VirtualMachine`/`VirtualMachineInstance`/`DataVolume` (+ the cloud-init `Secret`) and targets only `vmssh-vm-*` namespaces. `clusterResourceWhitelist: []`. |
| `applicationset-vm.yaml` | the VM env ApplicationSet — a single-env (prod) `matrix(list × git-files promotion.yaml)` App that syncs the APP repo's `.devops/chart/overlays/prod` VM chart into `vmssh-vm-prod` under project `vmssh-vm`. **Without this the VM tier is a fence + namespace with nothing inside it** (the #376 onboarding bug). The VM analogue of `../_template/applicationset-envs.yaml`. |
| `namespaces/vm-prod.yaml` | `vmssh-vm-prod` Namespace at **PSA `baseline`** (not restricted) + VM-sized ResourceQuota + LimitRange + 4 NetworkPolicies (default-deny, Traefik ingress, DNS egress, importer image-pull) + VM-aware Role/RoleBinding. |

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
  kinds are whitelisted only in the `vmssh-vm` project (GitOps layer) and
  `virt-launcher` would be rejected by `restricted` PSA anyway (admission layer).
- A team **cannot** run arbitrary container Deployments in the relaxed VM namespace
  — `Deployment`/`ReplicaSet`/`HPA` are NOT in the VM project's whitelist.

## Default: ONE VM namespace (`vm-prod`)

A lifted whole-project VM is a single heavyweight artifact and usually needs one
live home, not a dev/staging/prod fan-out. `vm-prod` is that home. A team that
genuinely needs a second VM env copies `namespaces/vm-prod.yaml` to `vm-dev.yaml`
and `s/prod/dev/`; the AppProject destination is a `vmssh-vm-*` wildcard, so no
AppProject edit is required.

## Sizing (homelab reality)

VMs reserve their **full guest RAM for their whole lifetime** (no overcommit). On
the 3-node / 16GB-per-node (~30GB free) cluster, the quota is sized for **one
substantial ~2-4 GiB whole-project VM** per team (6Gi reserved incl. overhead). At
the expected ~2-of-10 VM-team rate that is ~12Gi — comfortable. A bigger guest or a
second VM needs an explicit quota bump + a platform capacity review.

## Tokens

Same as the parent template: `vmssh`, `vmssh`, `2026-summer`. Substitute
`vmssh` BEFORE `vmssh` (a `vmssh`-prefixed appName would otherwise be
half-replaced). The team group `vmssh-developers` is the same subject used by the
container tier.

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
