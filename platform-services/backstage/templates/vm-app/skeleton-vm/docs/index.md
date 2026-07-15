# ${{ values.appName }}

${{ values.description }}

A **virtual machine** app (KubeVirt, ADR-032) scaffolded by **The Process** — for teams
that can't or won't containerize. Your whole project (runtime, database, services) runs
inside one self-contained VM, reachable at a normal URL like any other app.

## The "no Dockerfile" model

There is no `Dockerfile` and no container image build. Instead:

1. A **base disk image** is imported by CDI onto cluster storage (`ceph-block`).
2. **cloud-init** (`.devops/chart/base/cloud-init.yaml`) runs ONCE on first boot to set
   up your app — this is your build step, expressed as setup commands.
3. A **Service + Ingress** expose the VM at `https://${{ values.appName }}.capstone.uamishub.com`.

## Quick start

1. Clone this repo and edit **`.devops/chart/base/cloud-init.yaml`** — install your
   runtime, your database, your services. The starter brings up a small web server on
   port `${{ values.port }}` so a fresh VM serves a page; replace it with your app.
2. (optional) Point the VM at **your own base disk image** and tune sizing in
   `.devops/vm-metadata.yaml` (and the DataVolume `source:` in
   `.devops/chart/base/virtualmachine.yaml`).
3. Open a pull request — CI **validates** your manifests + cloud-init (no image build).
4. Merge to `main` — ArgoCD deploys your VirtualMachine; CDI imports the disk and
   cloud-init runs your app on first boot.

> cloud-init only runs on **first boot**. After changing it, recreate the VM to re-run.

## What you edit vs. what the platform owns

| You edit | Platform-managed |
| --- | --- |
| `.devops/chart/base/cloud-init.yaml` (your app setup) | the GitOps tier (`<team>-vm-prod` namespace, quota, RBAC) |
| `.devops/vm-metadata.yaml` (base image, vCPU/RAM/disk, port) | the Service/Ingress wiring + labels |
| the DataVolume `source:` (your base image) | CI, ArgoCD sync, the KubeVirt/CDI runtime |

## Single environment

A VM app is **one** environment (the whole project lifted into one machine) — not a
dev/staging/prod pipeline. It deploys into `${{ values.team }}-vm-prod` and serves at
`https://${{ values.appName }}.capstone.uamishub.com`.

## Sizing + cost

A VM **reserves its full vCPU/RAM for its whole lifetime** (no overcommit like an idle
container). Keep `cpu-cores` / `memory-gi` modest — the VM-tier quota caps them, and this
is a shared homelab cluster.

## SSH access (pet dev-VM)

Your VM is a real machine: `ssh` in with a **standard client**, `git clone` your app
repo, and run your stack directly on the box. cloud-init already installed the public
key you provided at scaffold time and disabled password login.

Public SSH rides the platform's existing Cloudflare Tunnel (no VPN, no LoadBalancer,
$0) at `ssh.${{ values.appName }}.capstone.uamishub.com`, gated by a Cloudflare
Access login (your UA-MIS email). Two ways to connect:

**A — native `ssh` client** (one-time: install the free `cloudflared` binary):

```bash
ssh -o ProxyCommand='cloudflared access ssh --hostname ssh.${{ values.appName }}.capstone.uamishub.com' \
    <cloud-user>@ssh.${{ values.appName }}.capstone.uamishub.com
```

(`<cloud-user>` is distro-specific — `fedora`/`ubuntu`/`debian` depending on your base
image.) Add a `Host` block to `~/.ssh/config` to shorten this to a plain `ssh
${{ values.appName }}`.

**B — browser, zero install:** open `https://ssh.${{ values.appName }}.capstone.uamishub.com`
in a browser, sign in via Cloudflare Access, and use the rendered terminal.

> This route is enabled by an operator/dashboard step **after** your onboarding PR
> merges — see the PR checklist and `docs/operator/vm-ssh-cloudflare-access.md` in
> `platform-infra`. Until then your VM is reachable at its HTTP URL but not over SSH.

## Prerequisite

The platform's **KubeVirt capability** must be live (ADR-032) and your team's
**onboarding PR** merged before the VM actually runs. Until then, CI validates your
manifests but the VM does not deploy.
