# ${{ values.appName }}

${{ values.description }}

A **KubeVirt virtual-machine** app (ADR-032 `layout: vm`) on the UA-MIS capstone
platform — for teams that can't or won't containerize. No Dockerfile, no image build:
your whole project runs inside one self-contained VM, reachable at
`https://${{ values.appName }}.capstone.uamishub.com`.

## Get into your VM (SSH)

Your VM is a real machine you log into and work on. Nobody hands out keys and nobody
has to add you — you add yourself, and the VM picks you up within about five minutes.

### Step 1 — put an SSH key on your GitHub account (almost everyone has to do this)

**Do not skip this.** Most students have never uploaded an SSH key, and the VM imports
its logins *from GitHub*. If your GitHub account has no key, everything below will look
like it worked and you still will not be able to log in — there is no error message
that tells you why. Check <https://github.com/settings/keys> first.

```bash
ssh-keygen -t ed25519                 # press Enter at every prompt; skip if you already have one
cat ~/.ssh/id_ed25519.pub             # copy this whole line
```

Paste that line into <https://github.com/settings/keys> → **New SSH key**.

You can confirm GitHub has it — this must print your key, not nothing:

```bash
curl https://github.com/YOUR-GITHUB-USERNAME.keys
```

### Step 2 — install `cloudflared`

The VM is not on the public internet. `cloudflared` is the tunnel client that gets you
to it.

```bash
brew install cloudflared                                   # macOS
# Windows: download the .msi from https://github.com/cloudflare/cloudflared/releases
# Linux:   sudo apt install cloudflared   (or the .deb from the same releases page)
```

### Step 3 — teach SSH about the host (once)

```bash
cloudflared access ssh-config --hostname ${{ values.team }}-ssh.uamishub.com >> ~/.ssh/config
```

### Step 4 — log in

```bash
ssh ubuntu@${{ values.team }}-ssh.uamishub.com
```

A browser window opens the first time so you can sign in with your university account.
You log in as the user `ubuntu` — that is the machine's account, shared by the team;
your own identity is what gets you *to* the host.

### If it says `Permission denied (publickey)`

That is the expected message when your key is not on the VM **yet**. In order:

1. Did step 1 actually land? `curl https://github.com/YOUR-USERNAME.keys` must print a key.
2. Did you only just add it? The VM re-reads GitHub **every 5 minutes**. Wait, retry.
3. Still stuck after ~10 minutes? Your GitHub username may not be on the team roster in
   `.devops/chart/base/cloud-init.yaml`. Add it, open a PR — that file is the list of
   who may log in.

The refresh is a timer inside the VM, so this works even though nobody is logged in and
even though the VM was built before you uploaded anything.

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
