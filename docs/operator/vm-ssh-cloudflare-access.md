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

## Start here: the WEB CONSOLE is the default door

**A student does not need an SSH key, a certificate, or any installed software.** They
open `https://<team>-console.uamishub.com`, sign in with GitHub, and get a terminal on
their VM. Their GitHub login is the only credential — which was the requirement all
along.

The VM serves that terminal itself (`ttyd`, installed and started by cloud-init), and
it is published as an **ordinary HTTP Service + Ingress** behind an **ordinary
self-hosted Cloudflare Access application**. That is the entire point of the design:

| | Web console | SSH |
| --- | --- | --- |
| Student installs | nothing | `cloudflared` |
| Credential | GitHub login | GitHub login + an SSH keypair |
| Needs a Cloudflare CA / short-lived certs | **no** | yes |
| Needs a per-tenant tunnel rule | **no** — rides `*.uamishub.com` | yes, and it must sit above the catch-all |
| Cloudflare feature maturity | ordinary self-hosted app | legacy, "not recommended for new deployments" |

SSH still works and is still supported — it is the advanced path for people who want a
real terminal. It is no longer the path a student is asked to walk on day one, and it
is no longer blocking: fifteen students generating SSH keypairs was the thing this
design exists to avoid.

> ### ⚠ The Access policy on the console host is the ONLY wall in front of a shell
>
> Anyone who gets past Access lands in a shell that can `sudo`. That is the same
> exposure the SSH path has always had — it is not new — but on the console there is
> no second factor behind it: no key, no certificate, nothing. So:
>
> - the policy **must** be **Allow**, scoped to the team's emails;
> - it must **never** be **Bypass** or **Service Auth**. A Bypass policy here is an
>   unauthenticated, sudo-capable shell on the public internet. (Cloudflare does not
>   support either decision on browser-rendered apps, but this host is an ordinary
>   HTTP app, so nothing stops you creating one by mistake.)
> - **do not publish the URL to students before the Access application exists.** The
>   Ingress is live as soon as ArgoCD syncs the tenant; Access is what makes it safe.

**What is proven, and what is not.** The guest side is verified by execution against
Ubuntu 24.04: apt over HTTPS-only egress, `ttyd 1.7.4` installed from `noble/universe`,
the shipped `ExecStart` serving HTTP 200, two concurrent clients receiving **two
independent shell processes**, and the session landing as the cloud user in its home
directory. The leg through Cloudflare Access needs an interactive human login and is
**not** verified — that is the click-list below.

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

### Symptom → layer, so you debug the right one

Every layer of this path fails by "SSH doesn't work". These are the tells that
separate them. Work down the table; each row is decisive for its layer.

| What you see | Layer that is broken | Go to |
| --- | --- | --- |
| Browser: **`Unable to connect to origin`** | tunnel route missing, or ordered *below* the `*.uamishub.com` catch-all (first match wins, so the SSH rule must be above it) | Step 5 / the tunnel plan |
| Browser: terminal renders, asks username, then **asks for a private key and password** | **no certificate** — the per-app CA is missing, or the guest trusts the *wrong* CA | the two-CA warning in Step 6 |
| Browser: username accepted, then **`Permission denied (publickey)`** | cert was minted but the guest rejected it — wrong CA in `cf_access_ca.pub`, or an expired cert | Step 6 |
| Browser: Access login loops or refuses the user | Access policy — most often an empty `ssh-access-emails` annotation, which creates an app that admits **nobody** | the Service annotation |
| TLS error *before* any Access page loads | hostname is not a single label under the apex (`ssh.<team>.uamishub.com` is two levels and is **not** covered by the one-level wildcard cert) | the hostname shape |
| Everything above looks right and nothing connects | **the guest has no IP** — read the next section before anything else | below |

Note the second and third rows are different failures that both follow a successful
GitHub login. "Asks for a key" means Cloudflare had no certificate to present.
"Permission denied" means it presented one and sshd refused it. Confusing the two
sends you to the wrong system.

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

### Repairing a VM that is ALREADY stranded

Neither fix is retroactive in the obvious way, and the measured behaviour is not what
you would guess. **This was tested by execution, not reasoned about** — the first
version of this section was wrong.

`networkData` is applied by cloud-init's local stage, which on a non-new instance-id
does not run at all, so adding it to a stranded VM changes nothing on the next boot.

`updates.network.when: ['boot']` *does* repair a stranded VM, **but it takes two
restarts**, because at the local stage cloud-init reads the user-data it CACHED under
`/var/lib/cloud/instance/` on the previous boot. The boot on which your new user-data
first arrives is therefore still driven by the old cached copy; only the boot after
that sees the `updates` key. Measured on a purpose-built reproduction, 2026-08-31:

| boot | change in effect | result |
| --- | --- | --- |
| 2 (before any fix) | — | `enp1s0 False`, tap RX **0 packets** |
| 3 | `updates` added to user-data | `enp1s0 False`, tap RX **0 packets** — still stranded |
| 4 | (no further change) | `enp1s0 True 10.0.2.2`, tap RX 39 packets, `SSH-2.0-OpenSSH_9.6p1` |

So the repair is:

```bash
# after the tenant-repo change has merged and ArgoCD has synced the new Secret
kubectl delete vmi -n <team>-vm-prod <app>     # runStrategy: Always recreates it
# wait for it to boot, confirm it is STILL stranded, then:
kubectl delete vmi -n <team>-vm-prod <app>     # this is the one that takes
```

**If the VM has no state worth keeping, rebuild instead** — delete the
`VirtualMachine` and let ArgoCD recreate it. That is a new instance-id, so cloud-init
runs everything from scratch: one step instead of two, both belts active immediately,
and `write_files`/`runcmd` re-run (which is also how a newly-issued Cloudflare Access
CA gets into the guest). Cost is a fresh CDI import, ~10-15 minutes.

---

## Per tenant: open the web console (the click-list)

Literal navigation, literal values. Do this once per team. It is the only Cloudflare
step the console needs — there is **no tunnel change and no DNS change**, because
`*.uamishub.com` already routes to Traefik and is already covered by the wildcard
certificate.

**Before you start**, confirm the tenant is actually serving the console. From a
machine with cluster access:

```bash
TEAM=paper-papas ; APP=paper-papas          # app name, usually the same
kubectl -n ${TEAM}-vm-prod get svc ${APP}-console ${APP}
kubectl -n ${TEAM}-vm-prod get ingress ${APP}-console
# and prove the guest is answering on the console port, from the ingress tier:
kubectl -n kube-system run consoleprobe --rm -it --restart=Never --image=curlimages/curl -- \
  -s -o /dev/null -w '%{http_code}\n' --max-time 5 \
  http://${APP}-console.${TEAM}-vm-prod.svc.cluster.local/
```

`200` means the guest's `ttyd` is up and Traefik can reach it. Anything else is a
guest-side problem — fix that before touching Cloudflare, or you will be debugging
Access in front of a VM that is not serving.

**Then, in the Cloudflare dashboard:**

1. Go to **Zero Trust** → **Access controls** → **Applications**.
2. Click **Add an application**.
3. Choose **Self-hosted**. (Not Infrastructure. Not SaaS. This is a plain HTTP app —
   that is the whole advantage of the console over SSH.)
4. **Application name:** `vm-console:<team>` — e.g. `vm-console:paper-papas`.
5. **Session Duration:** `24 hours`.
6. Under **Public hostname**, click **Add public hostname** and enter:
   - **Subdomain:** `<team>-console` — e.g. `paper-papas-console`
   - **Domain:** `uamishub.com` (select it from the dropdown)
   - **Path:** leave empty
   > ⚠ **Subdomain must be exactly one label.** `paper-papas-console` is correct.
   > `console.paper-papas` is **wrong** — that is two labels, the wildcard certificate
   > covers only one, and the browser fails the TLS handshake before the Access login
   > page can load. The error will look nothing like a configuration problem.
7. Click **Next** to reach policies.
8. **Add a policy:**
   - **Policy name:** `team-allow`
   - **Action:** **Allow** ← never Bypass, never Service Auth
   - **Configure rules** → **Include** → Selector **Emails** → **Value:** paste the
     team's university emails, one per entry.
   - Leave *Require* and *Exclude* empty.
9. Click **Next**, then **Next** again through the settings page — **change nothing
   there**. In particular do **not** enable browser rendering; this is an HTTP app and
   the terminal is rendered by the VM, not by Cloudflare.
10. Click **Save**.

**Verify, before you tell the team:**

```bash
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' \
  https://<team>-console.uamishub.com/
```

You want `302` redirecting to `https://<your-team-domain>.cloudflareaccess.com/cdn-cgi/access/login/...`.

- A `302` to the Access login is **correct** — Access is in front.
- A `200` means **Access is NOT protecting it** and the shell is open to the internet.
  Fix that before doing anything else.
- A `404` means Traefik has no route — the Ingress has not synced.
- A TLS error means the hostname is not one label under the apex. Re-read step 6.

Then open the URL in a browser, sign in with GitHub, and confirm you land at a shell
prompt. That last leg cannot be verified from a script; it needs a human login.

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
| **Account** | Access: Apps and Policies | **Edit** | create/update/delete the Access app, its policy, and its **per-app** short-lived-cert CA (`/access/apps/{app_id}/ca`) |
| **Account** | Access: SSH Auditing | **Edit** | **belt-and-braces — include it.** See the note below. |
| Zone | DNS | Edit | **omit it.** `*.uamishub.com` already resolves every `<team>-ssh` host, so the reconciler never touches DNS. Include it only if you later want per-host CNAMEs. |

> **Why `SSH Auditing` is on the list even though it is probably not needed.**
> Cloudflare has **two** SSH CA APIs and they are gated differently:
> `/accounts/{id}/access/gateway_ca` is account-global and documented as requiring
> `Access: SSH Auditing Write`; `/accounts/{id}/access/apps/{app_id}/ca` is the
> **per-application** CA this platform actually uses, and it is a subresource of
> Access applications. No Cloudflare doc states the permission name for the per-app
> endpoint verbatim, so this is the one thing on this page that is inference rather
> than a quoted fact. Adding the third permission now costs nothing; discovering it
> was required costs a full round trip through a human. Drop it later once a real
> run has proved it unnecessary.

- **Account Resources:** Include → this account only.
- **Zone Resources:** `uamishub.com` only (irrelevant if you omit the DNS permission,
  but scope it anyway).
- **TTL:** set an expiry and calendar the rotation.

**Create a NEW token for this.** Do not widen an existing one, and do not reuse the
GitHub App credential or the tunnel token — the tunnel token authenticates the
`cloudflared` daemon and cannot drive the API. It is not an admin token, but it can
rewrite the routing for every public platform hostname (the portal, Harbor, ArgoCD,
the boards, the slides all ride the same tunnel), so treat it as a high-value
credential.

**If an Access *service token* was ever pasted anywhere, it is the wrong credential
type for this and should be rotated.** Service tokens authenticate machines *through*
Access; they cannot drive the Cloudflare API.

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

> ### ⚠ THE ONE MISTAKE THAT COSTS A DAY: there are TWO Cloudflare SSH CAs
>
> They are visually identical — both a single line ending
> `open-ssh-ca@cloudflareaccess.org`. Installing the wrong one leaves every other
> layer correct and SSH still failing, and sshd logs only a bare `Failed publickey`
> with nothing pointing at the CA. **This has already happened once on this
> platform** and it is the reason this section exists.
>
> | | Use it? | Where it comes from | API |
> | --- | --- | --- | --- |
> | **Per-application CA** | ✅ **this one** | Zero Trust → Access controls → Service credentials → SSH → the row for **this VM's** app (`vm-ssh:<team>`) | `/accounts/{id}/access/apps/{app_id}/ca` |
> | Account-global CA | ❌ never | the **Access for Infrastructure** screen | `/accounts/{id}/access/gateway_ca` |
>
> Browser-rendered SSH presents a certificate signed by the **per-application** CA.
> The account-global CA exists for Gateway SSH command logging and Access for
> Infrastructure and never signs that certificate. It is also shared across the whole
> account, so trusting it on a guest would let a certificate minted for any other
> target authenticate there — it breaks the per-tenant containment the design relies
> on, as well as simply not working.

The reconciler logs one short-lived-cert CA public key per Access app, and it reads it
from the per-app endpoint, so what it logs is always the right one:

```bash
kubectl -n cloudflared logs job/cf-vm-access-dryrun | grep -A1 "CA public key"
```

Prefer that over copying from the dashboard. If you must use the dashboard, the
control moved: it is now **Zero Trust → Access controls → Service credentials → SSH →
Add a certificate**, then pick the application from the dropdown. (Older runbooks sent
you to *Access → Service Auth*, which no longer exists.) **The dropdown only lists
eligible self-hosted Access applications — if the Access app for this team does not
exist yet, the control is unavailable and generating a certificate fails with
`400`.** Create the Access app first; the reconciler does this for you.

Paste each into that team's `.devops/chart/base/cloud-init.yaml` at
`/etc/ssh/cf_access_ca.pub` (it is a public key — safe to commit), then **delete the
VirtualMachine** so cloud-init re-runs. The ordering is unavoidable today: the CA does
not exist until the Access app does, and cloud-init's `write_files` runs only on a
first boot. Do it before students have state on the box.

**To fix a VM that is already running and already has student state**, you do not have
to rebuild it. `/etc/ssh/` inside the guest is not managed by ArgoCD — only the
cloud-init `Secret` is — so editing the file on the running guest sticks, and ArgoCD's
`selfHeal` will not revert it:

```bash
# over the GitHub-key path, which works today
sudo tee /etc/ssh/cf_access_ca.pub <<'EOF'
<the PER-APPLICATION CA public key>
EOF
sudo systemctl reload ssh     # `sshd` on some images
```

**This is a stop-gap, not the fix.** It is lost the moment the VM is rebuilt, so make
the same change in the tenant repo's `cloud-init.yaml` in the same sitting, or the
next rebuild silently reintroduces the outage.

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

Open `https://<team>-ssh.uamishub.com`. Cloudflare Access authenticates with GitHub,
then renders an SSH terminal in the page. **At the `Enter username` prompt type
`ubuntu`** (the cloud user on the Ubuntu 24.04 base image) and press enter — that is
the only thing a student ever types. Nothing else is asked for.

> **If it also asks for a private key and a password, stop — that is the "no
> certificate" signal, not a student error.** The browser terminal falls back to
> asking a human for credentials precisely when no short-lived certificate is
> available for the application. It means the per-app CA is missing, or the CA
> installed in the guest is the wrong one (see the two-CA warning in Step 6). No
> amount of retrying, and no password, will get past it. Do not work around it by
> enabling `PasswordAuthentication` — that bolts a shared secret onto the one place
> in this design that is supposed to have none.

A student's GitHub login is the only credential in this path. If you find yourself
about to hand a student a key or a password, the configuration is wrong.

---

## Paths not taken, and why — do not re-derive these

Cloudflare's own docs label the short-lived-certificate path above as **"not
recommended for new deployments"** and steer readers to **Access for Infrastructure**.
That steer is wrong *for this platform*, and the reason is not obvious, so it is
recorded here rather than rediscovered:

- **Access for Infrastructure has no browser mode.** It requires the Cloudflare One /
  WARP client installed on the user's device. Our binding constraint is that a student
  needs nothing but a browser and their GitHub login, so this path cannot satisfy the
  requirement at all — independently of anything else.
- **Its targets cannot be our pods anyway.** An infrastructure target must be an IP
  inside a WARP-routed **private network** route (Zero Trust → Networking → Routes). A
  Tunnel *public hostname* route is a different mechanism and does not qualify. This is
  why registering the pod IP `10.244.x.x` is rejected with **"no valid options for
  ipv4"**: the shared tunnel runs with `warp-routing.enabled=false`, so there is no
  private network for that address to belong to.
- **Enabling WARP routing to make it qualify would be a bad trade.** Publishing the
  pod CIDR as a private network route exposes *every pod in the cluster* — Vault,
  Harbor, the CNPG/MariaDB databases, Prometheus, Alertmanager, ArgoCD, every tenant
  app — to anything on the WARP side. Several of those have no authentication of their
  own and rely on being unreachable. Worse, the `cloudflared` namespace currently has
  **no NetworkPolicy at all**, so there is no in-cluster backstop that would contain
  it. If WARP routing is ever wanted for another reason, publish a narrow route and
  write a `cloudflared` egress policy *first*.

The legacy per-app certificate path, by contrast, needs no client, no WARP, and no new
network exposure — it reuses the tunnel that is already carrying every platform
hostname.

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
