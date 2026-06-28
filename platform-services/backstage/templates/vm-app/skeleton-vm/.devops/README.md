# `.devops/` — the VM layout contract (platform-managed)

This is the `layout: vm` golden path (ADR-032): your app runs as a **KubeVirt
VirtualMachine**, not a container. There is **no Dockerfile and no image build** — CDI
imports a base OS disk and cloud-init adapts it into your app on first boot.

## Files

| Path | What it is | You edit? |
| --- | --- | --- |
| `chart/base/virtualmachine.yaml` | The `VirtualMachine` + its `dataVolumeTemplate` (the imported disk on `ceph-block`). | the `source:` (your base image) |
| `chart/base/cloud-init.yaml` | `#cloud-config` — installs/starts your app on first boot. **The main file you edit.** | YES |
| `chart/base/service.yaml` / `ingress.yaml` | Expose the VM at `<app>.capstone.uamishub.com`. | no |
| `chart/base/kustomization.yaml` | Wires the chart + packages cloud-init into the VM's Secret. | no |
| `chart/overlays/prod/` | The single environment (`<team>-vm-prod` namespace). | no |
| `vm-metadata.yaml` | The sizing knobs (base image, vCPU/RAM/disk, port). | YES |
| `promotion.yaml` | Single-env, no-build trigger map (read by the platform's VM ApplicationSet). | no |
| `ci/validate-vm.py` | The CI validator (cloud-init + manifests). | no |

## CI — no Kaniko build (ADR-032 §6)

A VM has no container image to build. `.github/workflows/build-and-push.yaml` therefore
does **not** call the reusable container pipeline
(`UA-MIS/platform-infra/.github/workflows/tenant-build.yaml`) — it runs
`ci/validate-vm.py` as a **validation-only** gate (valid `#cloud-config`, parseable
manifests, the VM/Service/Ingress trio, the no-build `promotion.yaml` shape). "Deploy"
is ArgoCD syncing the merged manifests; there is no image-tag bump.

## How a VM becomes "an app with a URL"

1. **Disk** — `dataVolumeTemplates` (CDI) imports your base image into a PVC on
   `ceph-block` (RBD, `volumeMode: Block`). The PVC lives + dies with the VM.
2. **First-boot setup** — `cloudInitNoCloud.secretRef` -> the Secret kustomize builds
   from `cloud-init.yaml` (key `userdata`). This replaces the Dockerfile.
3. **Networking** — `masquerade` puts the VM on the pod network (NAT behind the
   launcher pod), so the cluster's Cilium CNI + the tenant NetworkPolicies apply
   unchanged.
4. **URL** — a `Service` selects the VMI by `kubevirt.io/domain`; a Traefik `Ingress`
   fronts it at the standard host.

## Changing things

- **Your app**: edit `cloud-init.yaml`, then recreate the VM (cloud-init runs only on
  first boot).
- **Base image**: edit the `source:` in `virtualmachine.yaml` (a `docker://` containerDisk
  or, switching the block, an `http(s):` cloud-image URL) and `base-image` in
  `vm-metadata.yaml`. For a PRIVATE containerDisk in your team's Harbor project, add a
  `secretRef` (a pull robot is minted at onboarding).
- **Sizing**: edit `vm-metadata.yaml` and the matching fields in `virtualmachine.yaml`
  (`spec.template.spec.domain.cpu.cores`, `...resources.requests.memory`, and the
  dataVolume `storage`). VMs do not overcommit — keep it modest; the VM-tier quota caps it.

## Prerequisites (platform side)

KubeVirt + CDI must be installed and KVM confirmed on the nodes (ADR-032 open Q1), and
your team's onboarding PR (which stands up the `<team>-vm-prod` tier) must be merged,
before the VM runs.
