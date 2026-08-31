# VM tenant SSH — how a student gets a shell

**Audience:** the platform operator (the only person holding Cloudflare account
access). Everything here that an agent *can* do is already done in git; what is left
is listed under [Go-live](#go-live-one-time) and is one-time, not per-tenant.

**Status, stated plainly:** the per-tenant Cloudflare steps are **automated** by the
`cf-vm-access` reconciler (`platform-services/cf-vm-access/`, ADR-038). That
reconciler is **switched off** (`DRY_RUN=1`) and stays off until an operator creates
one scoped API token. Until then every VM tenant needs the dashboard steps in
[Appendix — the manual fallback](#appendix--the-manual-fallback) by hand.

> **This document replaced an earlier version that was wrong in a way that would have
> cost you an afternoon.** The old version told you to create
> `ssh.<appName>.capstone.uamishub.com`. That host is three labels under the apex, the
> zone's certificate is a **one-level** wildcard (`DNS:uamishub.com, DNS:*.uamishub.com`),
> and the TLS handshake for it fails outright — so the Access login page never even
> loads. The shipped shape is `<team>-ssh.uamishub.com`, a single label under the
> apex. If you find the old shape anywhere, it is stale.

---

## The whole path, end to end

```
student's browser / ssh client
   │
   │  https://<team>-ssh.uamishub.com          ← single label under the apex (TLS!)
   ▼
Cloudflare Access application                  ← WHO may connect (email allowlist)
   │  mints a SHORT-LIVED SSH CERTIFICATE signed by this app's own CA
   ▼
Cloudflare Tunnel public-hostname route (type SSH)
   │  ssh://<app>-ssh.<team>-vm-prod.svc.cluster.local:22
   ▼
cloudflared pod (in-cluster) ──► NetworkPolicy allow-ingress-cloudflared-ssh
   ▼
<app>-ssh ClusterIP Service :22  ──► virt-launcher pod ──► KubeVirt masquerade NAT
   ▼
the guest's sshd
   ├─ trusts the Access app's CA (/etc/ssh/cf_access_ca.pub)   ← cert path
   └─ also reads /etc/ssh/authorized_keys.d/<user>             ← GitHub-key path
```

Six things must all be true. The three in-cluster ones ship in git and are guarded by
CI. The three Cloudflare ones are what the reconciler exists to automate.

---

## Read this before you debug anything

**A VM whose guest has no IP address looks exactly like a broken tunnel.** It is not.
This is the failure that consumed three days on 2026-08-28..31, and it will be the
first thing you hit again if you skip it.

Kubernetes reports a VM in this state as completely healthy: the VMI says `Running`
and `Ready`, the `<app>-ssh` Service holds a live Endpoint, and the guest boots to a
login prompt with sshd listening. None of that involves the guest's network. The
Endpoint exists because the *launcher pod* has an IP, not because the guest does.

**Check the tap counters first — one command, and it is decisive:**

```bash
POD=$(kubectl get pod -n <team>-vm-prod -l kubevirt.io/domain=<app> \
        -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n <team>-vm-prod "$POD" -c compute -- ip -s link show tap0
```

`RX: 0 bytes 0 packets` means **the guest has never transmitted a single frame**.
Nothing on the Cloudflare side, and no NetworkPolicy, can produce that number — the
tap device is inside the launcher pod, upstream of every policy. Stop looking at the
tunnel and read
[the guest-network section](#the-guest-network-failure-mac-pinned-netplan) below.

Two more probes worth knowing, both run from where the tunnel actually connects from:

```bash
# the guest's serial console log — the full boot, retained by KubeVirt
kubectl logs -n <team>-vm-prod "$POD" -c guest-console-log | tail -60

# a screenshot of the guest's VGA console (yes, really — returns a PNG)
kubectl get --raw \
  "/apis/subresources.kubevirt.io/v1/namespaces/<team>-vm-prod/virtualmachineinstances/<app>/vnc/screenshot" \
  > /tmp/guest.png
```

The console log is the single highest-value artifact when a VM misbehaves, and almost
nobody knows it exists. `virtctl console` shows you only what the guest prints *after*
you attach; this container has the whole boot.

### Probing from the `cloudflared` namespace

`ns/cloudflared` enforces **PodSecurity `restricted`**. A `kubectl run busybox` there
is rejected at admission and prints nothing useful — **a probe that cannot run looks
exactly like a service that is down.** Use a compliant pod spec (`runAsNonRoot`,
`runAsUser`, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`,
`capabilities.drop: [ALL]`) and an image already pullable there (`python:3.12-slim`,
which the reconciler CronJob uses).

Read the *kind* of failure, not just the fact of it:

| From `ns/cloudflared` to the VM's `:22` | Means |
| --- | --- |
| `SSH-2.0-OpenSSH_...` banner | the whole in-cluster path is good; any remaining problem is Cloudflare-side |
| `No route to host` (EHOSTUNREACH) | the NetworkPolicy **allowed** you through and the guest is not answering ARP — the guest has no IP |
| `timed out` | a NetworkPolicy dropped the packet |
| `Connection refused` | the guest is reachable but nothing is listening on 22 — a real sshd problem |

That distinction is the whole diagnosis. On 2026-08-31 `:22` gave `No route to host`
while `:80` from the same pod timed out — proving in one shot that the `:22` policy
was correct and the guest was the problem.

---

## The guest-network failure: MAC-pinned netplan

**Symptom.** VM works on its first boot. After any restart — a VM reboot, a node
drain, an eviction, an `updateStrategy: OnDelete` respin — the guest comes up with no
IP address and stays that way forever. Zero packets on `tap0`. HTTP through Traefik
returns 502 and SSH returns `No route to host`, both for the same underlying reason.

**Cause — three facts that are each harmless alone:**

1. **KubeVirt masquerade gives the guest the launcher *pod's* MAC address.** Verified
   by comparing the guest's MAC to `ip link show eth0` inside the launcher pod, on
   three separate VMs. The CNI generates that MAC per pod, so **the guest's MAC
   changes every time the launcher pod is recreated.**
2. **Without `networkData`, the NoCloud seed has no network config.** KubeVirt writes
   only `meta-data` and `user-data` into the seed ISO (verified by reading the
   generated `noCloud.iso`). cloud-init therefore falls back to
   `generate_fallback_config()`, which writes a netplan file pinned to
   `match: {macaddress: <the MAC at first boot>}`.
3. **cloud-init does not re-apply network config on a restart.** Its
   `default_update_events` is `{NETWORK: {BOOT_NEW_INSTANCE}}` and the instance-id is
   the VM's stable firmware UUID, so a restart is not a new instance. cloud-init logs
   `No network config applied. Neither a new instance nor datasource network update
   allowed` and leaves the stale file alone.

Put together: the netplan rule from first boot names a MAC that no longer exists, so
the interface is never brought up. This is invisible on an ephemeral `containerDisk`
(every boot is a first boot); it only bites VMs on a persistent rootdisk PVC, which is
every real tenant.

**Fix — already in the scaffold, two independent belts:**

- `.devops/chart/base/virtualmachine.yaml` declares `networkData` matching on
  interface **name** (`match: {name: "e*"}`), which does not change when the MAC does;
- `.devops/chart/base/cloud-init.yaml` sets `updates: {network: {when: ['boot']}}`, so
  cloud-init re-derives the config on every boot and a stale file self-heals.

Both are enforced by CI — `make validate` step 11 in this repo
(`hack/lint-vm-network-config.py`) and `.devops/ci/validate-vm.py` in every tenant
repo. Both guards are tested to **refuse**, not merely to pass.

**Repairing an EXISTING stranded VM.** The `networkData` block only takes effect on a
first boot, so adding it does not fix a VM that is already stranded — but the
`updates.network.when: ['boot']` line *does*, because cloud-init reads user-data on
every boot. Merge the tenant-repo change, then restart the VM:

```bash
kubectl delete vmi -n <team>-vm-prod <app>     # runStrategy: Always recreates it
```

If the VM has no state worth keeping, deleting the `VirtualMachine` and letting
ArgoCD recreate it (a fresh CDI import, ~10-20 min) is the cleaner option and also
re-runs cloud-init from scratch.

---

## Go-live (one time)

After this, **provisioning a VM tenant produces a working SSH endpoint with no
dashboard clicks.** These steps are one-time for the platform, not per-tenant.

### Step 1 — create the Cloudflare API token

Only a human can do this; it is deliberately withheld from automation.

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Create Custom
Token**.

| Type | Resource | Level | Why |
| --- | --- | --- | --- |
| **Account** | Cloudflare Tunnel | **Edit** | GET + PUT the tunnel configuration (the public-hostname route) |
| **Account** | Access: Apps and Policies | **Edit** | create/update/delete the Access app, its policy, and its short-lived-cert CA |
| Zone | DNS | Edit | **omit it.** `*.uamishub.com` already resolves every `<team>-ssh` host, so the reconciler never touches DNS. Include it only if you later want per-host CNAMEs. |

- **Account Resources:** Include → this account only.
- **Zone Resources:** `uamishub.com` only (irrelevant if you omit the DNS permission,
  but scope it anyway).
- **TTL:** set an expiry and calendar the rotation.

**Create a NEW token for this.** Do not widen an existing one, and do not reuse the
GitHub App credential or the tunnel token — the tunnel token authenticates the
`cloudflared` daemon and cannot drive the API. The minimum viable token is the two
**Account** permissions. It is not an admin token, but it can rewrite the routing for
every public platform hostname (the portal, Harbor, ArgoCD, the boards, the slides all
ride the same tunnel), so treat it as a high-value credential.

### Step 2 — seal it

This cluster uses **SealedSecrets** for platform credentials (ESO+Vault is for
*tenant app* secrets; the reconciler reads a plain `Secret`, so SealedSecrets is the
right mechanism here).

```bash
kubectl create secret generic cloudflare-api-token \
  --from-literal=token='<THE TOKEN>' \
  --namespace cloudflared --dry-run=client -o yaml \
| kubeseal --format yaml --controller-namespace sealed-secrets \
> platform-services/cf-vm-access/sealedsecret-cf-api-token.yaml
```

Then add `sealedsecret-cf-api-token.yaml` to the `resources:` list in
`platform-services/cf-vm-access/kustomization.yaml`. It is deliberately not shipped as
a placeholder — an illegal-base64 placeholder puts the ArgoCD app Degraded.

### Step 3 — the account and tunnel IDs

**Already done.** `platform-services/cf-vm-access/configmap-ids.yaml` now carries the
real `CF_ACCOUNT_ID` and `CF_TUNNEL_ID`. They are not secrets — both were recovered
from the identifiers already encoded in the existing tunnel token:

```bash
kubectl -n cloudflared get secret cloudflared-tunnel-token \
  -o jsonpath='{.data.token}' | base64 -d | base64 -d
# -> {"a":"<CF_ACCOUNT_ID>","t":"<CF_TUNNEL_ID>","s":"<the actual secret>"}
```

Only `s` is sensitive and it is not in git.

### Step 4 — run one dry run and READ it

```bash
kubectl -n cloudflared create job --from=cronjob/cf-vm-access-reconciler cf-vm-access-dryrun
kubectl -n cloudflared logs job/cf-vm-access-dryrun
```

Check the printed "exact ingress list that WOULD be PUT" against the live tunnel
config:

- every rule the tunnel has today appears unchanged, in the same relative order;
- the last entry is the hostname-less catch-all;
- the only additions are `<team>-ssh.uamishub.com → ssh://…:22`, one per team;
- there are no unexpected `DEL` lines.

If the log says `REFUSE`, **stop** — a guard tripped and prints why. The tunnel-config
API is a whole-list PUT carrying every public platform hostname; a bad write takes the
whole platform down at once, which is why the reconciler has five layers of guard and
why this step is not optional.

### Step 5 — flip the switch

Set `DRY_RUN` to `"0"` in `platform-services/cf-vm-access/cronjob.yaml`, commit, let
ArgoCD sync, re-run the job. **This is the operator's call, not an agent's.**

### Step 6 — bake each Access app's CA into its guest

The reconciler logs one short-lived-cert CA public key per Access app:

```bash
kubectl -n cloudflared logs job/cf-vm-access-dryrun | grep -A1 "CA public key"
```

Paste each into that team's `.devops/chart/base/cloud-init.yaml` at
`/etc/ssh/cf_access_ca.pub` (it is a public key — safe to commit), then **delete the
VirtualMachine** so cloud-init re-runs. The ordering is unavoidable today: the CA does
not exist until the Access app does, and cloud-init's `write_files` runs only on a
first boot. Do it before students have state on the box.

> **This is the last remaining per-tenant manual step, and it is a real gap.** It
> means "provision a tenant" still ends in "and then rebuild the VM once". Options for
> closing it are noted under [Known gaps](#known-gaps); none is done.

Until the CA is pasted, cert auth is simply inactive and the **GitHub-key path still
works** — the guest imports each team member's public keys from
`https://github.com/<user>.keys` on a 5-minute timer (ADR-032a/#603). A student who
adds a key to GitHub can SSH in within ~5 minutes with no instructor involvement,
using `cloudflared access ssh` once the Access app exists.

---

## Connect — give both to the team

**A — native `ssh` client** (needs the free `cloudflared` binary, installed once):

```bash
brew install cloudflared          # one-time, per laptop

ssh -o ProxyCommand='cloudflared access ssh --hostname <team>-ssh.uamishub.com' \
    ubuntu@<team>-ssh.uamishub.com
```

`<cloud-user>` is `ubuntu` on the default Ubuntu 24.04 base image.

**B — browser, zero install:**

Open `https://<team>-ssh.uamishub.com`. Cloudflare Access authenticates, then renders
an SSH terminal in the page.

---

## Known gaps

- **Step 6 is still manual, per tenant.** Closing it needs either the reconciler to
  write the CA back into git (it has no write credential and should not get one), or
  a way for the guest to fetch its Access app's CA at boot. Neither is designed yet;
  do not invent an endpoint for this without verifying it exists.
- **The end-to-end browser leg has never been verified by anyone.** It requires an
  interactive Cloudflare Access login, which no agent can perform. Everything up to
  the Access boundary is proven; the last hop is not.
- **The `*.capstone.uamishub.com` HTTP hosts are a two-level name** and rely on a
  paid Advanced Certificate (D-044/ADR-028), unlike the `<team>-ssh` hosts which sit
  under the free one-level wildcard. Do not "tidy" the SSH hostname to match the app
  hostname's shape.

---

## Appendix — the manual fallback

Only if the reconciler is still `DRY_RUN=1`. Per tenant, after the onboarding PR
merges:

1. **Tunnel route.** Zero Trust → Networks → Tunnels → the platform tunnel → Public
   Hostname → Add:
   - Subdomain `<team>-ssh`, Domain `uamishub.com`, Path blank
     — **one label under the apex; anything deeper fails TLS.**
   - Service Type **SSH**, URL `<app>-ssh.<team>-vm-prod.svc.cluster.local:22`
2. **Access application.** Zero Trust → Access → Applications → Add → Self-hosted:
   - Application domain `<team>-ssh.uamishub.com`
   - Policy **Allow** → Include → the team's UA-MIS emails (the same list the
     `platform.capstone/ssh-access-emails` annotation on the ssh Service carries).
   - **An empty include list produces an app that admits nobody**, and from a
     student's laptop that is indistinguishable from a missing route. Check this
     annotation before you touch the tunnel.
   - Under the app's settings, enable **short-lived certificate** access for SSH and
     copy the CA public key it generates — that is the value for step 6 above.
3. **Verify the CNAME** `<team>-ssh.uamishub.com → <tunnel-id>.cfargotunnel.com` was
   auto-created.
4. **Smoke-test.** Before blaming Cloudflare, run the `tap0` check at the top of this
   document.
