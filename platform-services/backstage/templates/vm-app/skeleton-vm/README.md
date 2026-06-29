# ${{ values.appName }}

${{ values.description }}

A **KubeVirt virtual-machine** app (ADR-032 `layout: vm`) on the UA-MIS capstone
platform — for teams that can't or won't containerize. No Dockerfile, no image build:
your whole project runs inside one self-contained VM, reachable at
`https://${{ values.appName }}.capstone.uamishub.com`.

## Edit this

- **`.devops/chart/base/cloud-init.yaml`** — your "no Dockerfile" build: install and start
  your runtime/database/services on first boot. (The starter serves a page on port
  `${{ values.port }}`.)
- **`.devops/vm-metadata.yaml`** — base disk image, vCPUs, memory, disk size, port.

Everything else under `.devops/` (the chart wiring, CI, the GitOps tier) is
platform-managed. See `.devops/README.md` and the in-repo TechDocs (Docs tab in The
Process) for the full model.

## Flow

PR → CI **validates** the VM manifests + cloud-init (no build). Merge to `main` → ArgoCD
deploys the VirtualMachine, CDI imports the disk, cloud-init runs your app.
