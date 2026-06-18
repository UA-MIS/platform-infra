# Phase-4 hardware bring-up runbook (Talos on Dell OptiPlex)

Real Phase-4 execution (D-035, §3.4). The human does the physical hands-on; this
runbook gives the exact configs + commands. Target: a healthy 3-node converged
Talos cluster (control-plane + workloads + etcd quorum + Rook-Ceph), then the
k3d→hardware migration (sequenced later).

> **Hardware:** 3× Dell OptiPlex 7080 (Intel Comet Lake) = converged k8s nodes;
> 1× OptiPlex 9020M = the DB tier (Debian, later). Each 7080 has a 512GB NVMe for
> Rook-Ceph (replica-3 across the 3 nodes = 3 failure domains).
>
> **Pinned versions:** Talos **v1.13.4** (current stable, 2026-06-09). Pin
> everything; bump deliberately.

---

## ✅ DELIVERABLE 1 — burn the image + run the network probe (DO THIS FIRST)

### Step 0 — mint the Tailscale auth key (the node overlay credential)

**Overlay = Tailscale-everywhere (RESOLVED by the architect).** All boxes join the
tailnet; node-to-node traffic rides Tailscale (direct WireGuard when the network
allows it, automatically falling back to DERP/TCP-443 relays when direct UDP is
blocked — which a locked-down managed network may do). KubeSpan is a documented
alternative only (see "Alt: KubeSpan" at the end); it cannot relay, so it's not the
primary. The `siderolabs/tailscale` extension is in the image (Step 1) and the nodes
authenticate to the tailnet with the auth key you mint here.

**Mint a reusable, tagged auth key** (this becomes `TS_AUTHKEY` in the node config —
a BOOTSTRAP SECRET, never committed to git in plaintext):
1. (one-time ACL tag) In the Tailscale admin console → **Access controls**, ensure a
   tag owner exists for the node tag, e.g. add to the ACL `tagOwners`:
   ```json
   "tagOwners": { "tag:talos-node": ["autogroup:admin"] }
   ```
   (Save. This lets keys/devices use `tag:talos-node`.)
2. Admin console → **Settings → Keys** (https://login.tailscale.com/admin/settings/keys)
   → **Generate auth key**:
   - **Reusable**: ON (all 3 nodes + later boxes use the same key).
   - **Ephemeral**: OFF (nodes are long-lived; ephemeral would reap them when offline).
   - **Tags**: `tag:talos-node` (so nodes are ACL-scoped, not tied to a user; required
     for tagged, non-expiring device identity).
   - Expiry: pick the longest allowed; note it for rotation. Generate → copy the
     `tskey-auth-...` value.
3. Hand that value to the config as `TS_AUTHKEY` via the talhelper sops secret
   (Deliverable 2) — NOT in git plaintext. Record only that it's minted:
   `[ ] tailscale auth key minted (reusable, tag:talos-node)  (by: ____, expires: ____)`

> **OPTIONAL diagnostic (not a branch decision):** `tailscale netcheck` from a host
> on the boxes' segment tells you whether intra-LAN Tailscale will be **direct**
> (`UDP: true`, low-latency direct path) or **relayed** (`UDP: false` / DERP-only).
> Relayed still works (that's why we chose Tailscale) — this is just perf insight
> for later tuning, NOT a KubeSpan-vs-Tailscale fork.

---

### Step 1 — generate the custom Talos image (Image Factory schematic)

These boxes need system extensions baked in: **iscsi-tools** + **util-linux-tools**
(Rook-Ceph RBD + disk tooling), **intel-ucode** (Comet Lake CPU microcode), and
**tailscale** — which is REQUIRED: it IS the node overlay (Tailscale-everywhere),
configured at install via `ExtensionServiceConfig` with the Step-0 auth key. The
7080's NIC is Intel i219-LM, driven by the in-kernel `e1000e` — **no NIC extension
needed** (verify in Step 3 if a NIC doesn't appear).

**1a. Create the schematic** (returns a schematic ID; do this from any machine with
`curl`):
```bash
cat > /tmp/talos-schematic.yaml <<'EOF'
customization:
  systemExtensions:
    officialExtensions:
      - siderolabs/iscsi-tools
      - siderolabs/util-linux-tools
      - siderolabs/intel-ucode
      - siderolabs/tailscale
EOF

curl -sX POST --data-binary @/tmp/talos-schematic.yaml \
  https://factory.talos.dev/schematics
# -> {"id":"<SCHEMATIC_ID>"}   (a 64-char hex string; record it)
```
> The same extension set yields the SAME schematic ID every time (it's a content
> hash), so re-running is safe/idempotent.

**1b. Download the metal ISO** (Image Factory builds it on first pull, then caches):
```bash
SCHEMATIC_ID=<paste the id from 1a>
curl -L -o talos-v1.13.4-metal-amd64.iso \
  "https://factory.talos.dev/image/${SCHEMATIC_ID}/v1.13.4/metal-amd64.iso"
```
> This ISO `SCHEMATIC_ID` should equal **8957336bb929170959e3afc61b9088e41cb072988407edd699b9b3deb4a26972**
> (the hash of the 4 extensions above). The INSTALLED system gets the SAME extensions
> automatically: talconfig.yaml declares them as a `schematic` block, so `talhelper
> genconfig` computes the matching installer image itself — NO env/`${SCHEMATIC_ID}`
> substitution (that fallback to the EMPTY schematic 376567… is what left box-3
> without tailscale). So boot ISO + installed system both = the 8957 extension set.

### Step 2 — burn the ISO to USB

Identify the USB device CAREFULLY (wrong target = data loss on the wrong disk):
```bash
lsblk          # find the USB, e.g. /dev/sdX (NOT your system disk!)
sudo dd if=talos-v1.13.4-metal-amd64.iso of=/dev/sdX bs=4M status=progress oflag=sync
sync
```
> GUI alternative (safer target selection): **balenaEtcher** or **Raspberry Pi
> Imager → Use custom image**. Either is fine; `dd` is fastest if you're sure of `/dev/sdX`.

You now have a bootable Talos USB with the right extensions. **STOP here for
Deliverable 1** — booting + applying machine configs is Deliverable 2 (the 3-node
install runbook below), produced next.

---

## DELIVERABLE 2 — stand up the 3-node converged cluster

Configs: `clusters/real-talos/` (`talconfig.yaml` + `patches/` + `values.env`).
3 converged 7080s — each control-plane (etcd quorum=3) AND untainted (runs
workloads). No LAN VIP — apiserver on the overlay IP. Tools the human needs:
`talosctl` + `talhelper` (+ `sops`/`age` for secrets) + `kubectl`, all pinned.

### Prereqs (one-time, on your workstation)
```bash
# talosctl pinned to the cluster version:
curl -sL https://github.com/siderolabs/talos/releases/download/v1.13.4/talosctl-linux-amd64 \
  -o ~/.local/bin/talosctl && chmod +x ~/.local/bin/talosctl
# talhelper (https://github.com/budimanjojo/talhelper/releases) + sops + age to ~/.local/bin
```

#### age key setup (one-time — REQUIRED for encrypted secrets, B2 leak fix)
The Talos secrets (`talsecret.sops.yaml`) are sops/age-encrypted. Generate the keypair
ONCE, register the PUBLIC key, and vault the PRIVATE key:
```bash
mkdir -p ~/.config/sops/age
age-keygen -o ~/.config/sops/age/keys.txt        # prints "Public key: age1…"
# 1) paste that age1… PUBLIC key into the repo-root .sops.yaml (REPLACE_WITH_AGE_PUBLIC_KEY).
# 2) the PRIVATE key file ~/.config/sops/age/keys.txt is a SECRET:
#      - never commit it (gitignored), and
#      - store it in the HANDOFF VAULT with the `ualaims` creds — the NEXT cohort
#        needs it to decrypt talsecret/talenv (continuance). No key = re-key the cluster.
```
sops + talhelper auto-find the private key at `~/.config/sops/age/keys.txt` (or via
`SOPS_AGE_KEY_FILE`). The `.sops.yaml` recipient (public key) is committed; the private
key never is.

### ⚠ Prereqs for apply (all REQUIRED or apply fails)
- **Same-segment reachability:** `talosctl ... --insecure -n <maint-ip>` needs your
  laptop on the SAME switch segment as the box in maintenance mode (pre-Tailscale).
- **The switch MUST have an internet UPLINK.** During `apply-config` the node PULLS
  the factory installer image AND joins Tailscale — **air-gapped = install fails.**
  (Same uplinked switch the DB box used.) Confirm uplink before applying.
- **⚠ SHELL = fish on the workstation.** `bash`-style `export VAR=value` SILENTLY
  FAILS in fish (`Expected a string`), which is what left SCHEMATIC_ID/TS_AUTHKEY
  EMPTY → the empty-schematic + empty-authkey bugs. So below:
  - talhelper vars (TS_AUTHKEY, etc.) go in **`talenv.yaml`** — NOT a shell export.
  - For real shell env (TALOSCONFIG, KUBECONFIG) in **fish**, use `set -x VAR value`
    (each `export X=Y` step shows the fish form too). `echo $SHELL` to confirm which
    shell you're in; the bash form works only in bash/zsh.
- **⚠ NO shell `$(...)` (command substitution) ANYWHERE in talconfig/patches/
  ExtensionServiceConfig.** talhelper's envsubst expands `${VAR}` ONLY — a `$(cmd)`
  survives as a LITERAL into the rendered config and breaks at runtime (the
  `--hostname=$(hostname)` → `tailscale up: "$(hostname)" is not a valid DNS label`
  failure). For per-node values, rely on what Talos already sets per node (e.g. the
  OS hostname) or use a per-node `nodes[].patches` entry — never a shell-sub. The
  Step-3.5 gate greps for both `${...}` and `$(...)` to catch this pre-apply.

### Step 3 — generate the machine configs ONCE (before touching any box)
The generated per-node config is IDENTICAL regardless of the box's transient DHCP IP
(nodes are `dhcp: true`; `ipAddress` in talconfig is only the talosconfig endpoint,
not a baked static IP — see talconfig header). So generate up front, apply per box:
```bash
cd clusters/real-talos
# ── SECRETS ARE SOPS/age-ENCRYPTED (B2 leak fix, D-040) ──
# ONE-TIME (if you haven't already — see "age key setup" in prereqs): generate the
# age keypair, paste its PUBLIC key into the repo-root .sops.yaml recipient, store the
# PRIVATE key (~/.config/sops/age/keys.txt) in the HANDOFF VAULT. Then:
talhelper gensecret > talsecret.sops.yaml      # writes PLAINTEXT secrets...
sops -e -i talsecret.sops.yaml                 # ...then ENCRYPT in place (uses .sops.yaml rule). NOT OPTIONAL.
# VERIFY it actually encrypted before doing ANYTHING else (this is the gate that was missing):
grep -q 'ENC\[' talsecret.sops.yaml && grep -q '^sops:' talsecret.sops.yaml \
  && ! grep -qiE 'BEGIN .*PRIVATE KEY|tskey-auth-' talsecret.sops.yaml \
  && echo "✅ talsecret encrypted (ENC[] + sops: stanza, no plaintext keys)" \
  || { echo "❌ NOT ENCRYPTED — STOP. Check .sops.yaml recipient + re-run sops -e -i."; }
# talhelper genconfig auto-DECRYPTS talsecret.sops.yaml on the fly (default secret-file)
# as long as the age PRIVATE key is at ~/.config/sops/age/keys.txt (or SOPS_AGE_KEY_FILE).
# TS_AUTHKEY is an ENV-VAR (${TS_AUTHKEY} in the tailscale ExtensionServiceConfig
# patch), so it lives in the talhelper ENV file — talenv.sops.yaml — NOT in talsecret
# (that's the PKI secret-file). Write it, then ENCRYPT it the same way (the .sops.yaml
# rule covers talenv.sops.yaml too). genconfig auto-loads talenv.sops.yaml and envsubst's
# ${TS_AUTHKEY} in — more reliable than a shell export (an UNSET var silently substitutes
# to EMPTY → that's what put box-3 on the empty schematic + broke tailscale auth):
cat > talenv.sops.yaml <<EOF
TS_AUTHKEY: "tskey-auth-...the-fresh-reusable-tag:talos-node-key-on-ualaims..."
EOF
sops -e -i talenv.sops.yaml                     # ENCRYPT (uses the .sops.yaml talenv rule). NOT OPTIONAL.
grep -q 'ENC\[' talenv.sops.yaml && ! grep -q 'tskey-auth-' talenv.sops.yaml \
  && echo "✅ talenv encrypted (TS_AUTHKEY is ENC[], no plaintext key)" \
  || { echo "❌ talenv NOT encrypted — STOP, re-run sops -e -i."; }
# (Local-only fallback if you'd rather not commit it: write talenv.yaml [gitignored]
#  instead, plaintext, NEVER committed. The encrypted talenv.sops.yaml is preferred —
#  it survives in git for the next cohort + can't be the thing that leaks.)
talhelper genconfig                            # auto-decrypts talsecret.sops.yaml + talenv.sops.yaml -> ./clusterconfig/{…-n1,-n2,-n3}.yaml + talosconfig
```
> The install image comes from the LITERAL **node-level `talosImageURL`** in talconfig
> (pinned to the 8957 schematic, no `:version` suffix — talhelper appends it). ⚠ This
> MUST be node-level: a TOP-LEVEL `schematic:`/`talosImageURL` is SILENTLY IGNORED by
> talhelper 3.1.11 → it POSTs an EMPTY schematic → install.image = 376567… (no
> extensions, no tailscale). That top-level mistake is exactly what the gate below
> caught pre-hardware. No `SCHEMATIC_ID` env is needed; only `TS_AUTHKEY` is
> env-substituted — hence talenv.sops.yaml + the MANDATORY gate next.

### Step 3.5 — PRE-APPLY GATE: verify the generated config (catch unsubstituted values)
⚠ **Run this on EVERY generated node file BEFORE apply.** envsubst silently turns an
unset `${VAR}` into empty — this gate catches the whole class (the schematic-image,
authkey, and endpoint bugs would ALL have been caught here pre-hardware):
```bash
F=clusterconfig/capstone-capstone-n3.yaml      # repeat per node file
# (1) real Tailscale key present (expect a tskey-auth-... line), not literal/empty:
grep -i 'tskey-auth-' "$F" || echo "❌ NO real TS key — fix talenv.yaml + re-genconfig"
# (2) install image = the 8957 extension set, NOT the empty 376567 (HARD pass/fail):
grep -q 'image:.*metal-installer/8957336bb929170959e3afc61b9088e41cb072988407edd699b9b3deb4a26972' "$F" \
  && ! grep -q '376567988ad370138ad8b2698212367b8edcb69b5fd68c80be1f2ec7d603b4ba' "$F" \
  && echo "✅ install image = 8957 (extensions present)" \
  || echo "❌ WRONG install image (empty 376567 or other) — talosImageURL must be NODE-LEVEL + no :version. STOP."
# (3) FAIL LOUD on ANY leftover ${...} OR $(...) shell-sub OR empty TS_AUTHKEY.
#     Note BOTH forms: talhelper envsubst expands ${VAR} only — a literal $(cmd)
#     (e.g. the old --hostname=$(hostname)) survives into the config and breaks the
#     extension at runtime, so catch it here too:
grep -nE '\$\{[A-Z_]+\}|\$\([a-z]+\)|TS_AUTHKEY=$|TS_AUTHKEY=""' "$F" \
  && echo "❌ STOP: unsubstituted \${VAR} / leftover \$(shell-sub) / empty value — do NOT apply" \
  || echo "✅ no unsubstituted placeholders — safe to apply"
# (4) endpoint is a real IP, not the placeholder:
grep -E 'NODE1_TAILSCALE_100_IP|N[123]_TAILSCALE_100_IP' "$F" \
  && echo "❌ endpoint still a placeholder — set it in talconfig + re-genconfig" \
  || echo "✅ endpoint substituted"
```
Proceed to apply ONLY when (1) shows a real `tskey-auth-…`, (2) the image is `8957…`,
(3) prints ✅, and (4) prints ✅.

### Step 4 — ONE BOX AT A TIME: BIOS → boot → confirm → apply → move to switch
The human has a single setup station, so do each box fully, then move it to the
(uplinked) switch and do the next:

**Per box (repeat for n1, n2, n3):**
1. At the station: BIOS → set SATA mode **AHCI** (not RAID), boot order USB first; insert USB, power on.
2. Talos boots **maintenance mode** + DHCPs. Note this box's CURRENT maintenance IP
   (`$MIP`) from the Talos console or your DHCP server.
3. CONFIRM hardware (over the same segment):
   ```bash
   talosctl -n $MIP --insecure get links     # note the REAL NIC name (Intel i219 = enp0s31f6/eno1, NOT eth0)
   talosctl -n $MIP --insecure get disks      # expect nvme0n1 (install target)
   ```
   The talconfig uses `deviceSelector: { physical: true }` (NOT a hardcoded name), so
   it auto-matches the onboard NIC whatever its predictable name is — no edit needed.
   ⚠ NEVER hardcode an interface name: naming a non-existent `eth0` took box-3 offline
   (phantom iface → real NIC lost DHCP → couldn't pull the installer → no install).
   If `get links` shows MULTIPLE physical NICs (it won't on a stock 7080), narrow the
   selector with `driver: e1000e` or `busPath`.
4. APPLY this box's config, TARGETING ITS CURRENT IP with `-n $MIP` (overrides whatever
   `ipAddress` is in talconfig — that's fine):
   ```bash
   talosctl apply-config --insecure -n $MIP --file clusterconfig/capstone-capstone-n1.yaml   # n1; use -n2/-n3 file per box
   ```
   The box installs Talos to nvme0n1, REBOOTS off the USB into the installed system,
   and (per the tailscale patch) joins the tailnet. Remove the USB after first reboot.
5. Move the box to the uplinked switch. → next box.

Known IPs so far (maintenance, transient): n1=10.237.26.254, n3=10.237.26.253, n2=TBD.
The `-n $MIP` target uses whatever each box has when YOU apply it — don't rely on
these persisting.

### Step 5 — once all 3 are installed + on the tailnet: set the endpoint + bootstrap
Resolve the endpoint chicken-egg (apiserver endpoint = node-1's Tailscale 100.x, only
known post-install):
```bash
# Find node-1's Tailscale 100.x — from the Tailscale admin console (host capstone-n1),
# or once you can reach it: talosctl -n <n1 any-reachable-ip> get addresses | grep 100\.
# Put each node's 100.x into talconfig.yaml ipAddress (N1/N2/N3_TAILSCALE_100_IP), then:
talhelper genconfig                            # regenerates talosconfig + cert SANs incl the 100.x
export TALOSCONFIG=$(pwd)/clusterconfig/talosconfig    # bash/zsh
# fish:  set -x TALOSCONFIG (pwd)/clusterconfig/talosconfig
# Re-apply so the apiserver cert SAN includes the 100.x endpoint (secure mode now — node is installed):
talosctl -n <n1 100.x> apply-config --file clusterconfig/capstone-capstone-n1.yaml
# Bootstrap etcd ONCE, on node-1 only:
talosctl config endpoint <n1 100.x> && talosctl config node <n1 100.x>
talosctl bootstrap
```
> Shortcut if you want to bootstrap BEFORE chasing the 100.x: bootstrap against n1's
> current reachable IP first (`talosctl -n <n1 ip> bootstrap`), get the cluster up,
> THEN do the endpoint→100.x re-gen/re-apply as a follow-up. Either order works; the
> 100.x endpoint is what makes the cluster reachable overlay-only long-term.

### Step 6 — kubeconfig + verify Ready
```bash
talosctl kubeconfig .                            # writes ./kubeconfig
export KUBECONFIG=$(pwd)/kubeconfig              # bash/zsh
# fish:  set -x KUBECONFIG (pwd)/kubeconfig
kubectl get nodes -o wide                        # EXPECT: 3 nodes, all Ready, control-plane
talosctl -n <n1 100.x> health                    # EXPECT: all checks pass (etcd, apid, kubelet)
```
**GATE: do not proceed until all 3 nodes are `Ready` and `talosctl health` is green.**

### Step 7 — storage: Rook-Ceph replica-3 (dual-disk nodes)
Every 7080 is **DUAL-DISK**: `nvme0n1` (512GB) holds the OS; a 500GB sata SSD (`sda`)
is the dedicated **raw Ceph OSD disk**, left untouched by Talos (installDisk pins the
OS to nvme0n1 only). 3 OSDs across the 3 nodes → **replica-3, host failure domain**
(survives any single node loss). The Rook charts ship via GitOps as two Applications
(`platform-rook-ceph-operator` wave 0, `platform-rook-ceph-cluster` wave 1).

**7a — discover each node's Ceph-disk WWN (stable selector).** The kernel name `sda`
is NOT stable (the install USB stick floats across `sda`/`sdb`), so the CephCluster
targets the disk by its `/dev/disk/by-id/wwn-…` path. For each node, read the WWID:
```bash
talosctl -n <node 100.x> get disks                # find the 500GB sata SSD row → WWID col
# e.g. n3: WDC WDS500G2B0A, WWID naa.5001b448b555979f → /dev/disk/by-id/wwn-0x5001b448b555979f
```
All three WWNs are pre-filled in `applicationsets/rook-ceph-cluster-app.yaml`
(`storage.nodes[].devices[].name`): n1 `wwn-0x5001b448b5559d1d`, n2
`wwn-0x5001b448b555195c`, n3 `wwn-0x5001b448b555979f`. If a box is ever re-disked,
re-read its WWID and update its line — **the cluster app must not sync against a
non-existent device.**

**7b — ZAP each Ceph disk (DESTRUCTIVE — human-gated).** Rook REFUSES a disk with an
existing partition table/filesystem. The 7080 sata SSDs shipped with a leftover
Windows GPT (EFI/MSR/Basic-data). Wipe ONLY the sata disk on each node (NEVER
`nvme0n1` = the OS):
```bash
# ⚠ Verify the device is the sata SSD, NOT nvme0n1, NOT the USB stick, before running.
talosctl -n <node 100.x> wipe disk sda            # zaps sda's partition table; OS (nvme0n1) untouched
talosctl -n <node 100.x> get discoveredvolumes | grep sda   # EXPECT: sda 'disk' only, no sdaN partitions
```

**7c — let GitOps install Rook.** The two apps land via the root-app/appset
(operator first, then the CephCluster). Verify:
```bash
kubectl -n rook-ceph get pods                     # EXPECT: operator, 3× mon, 2× mgr, 3× osd, csi pods Running
kubectl -n rook-ceph get cephcluster              # EXPECT: HEALTH_OK (HEALTH_WARN briefly during OSD bring-up)
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s   # 3 osds up/in, pgs active+clean
kubectl get storageclass                          # EXPECT: ceph-block (default)
```
**GATE: a healthy hardware cluster = 3 nodes `Ready` + `talosctl health` green + Ceph
`HEALTH_OK` (3 OSDs up/in) + `ceph-block` as the default StorageClass.** Stop here —
the k3d→hardware migration (sealing-key migrate, netpol CIDR re-param for the overlay
ranges, `make bootstrap` with the kube-context override) + the DB tier are sequenced
AFTER this, per the team lead.

> **FALLBACK — if a node's Ceph disk is missing/unusable:** start with the OSDs you
> have (replica-3 needs all 3; with 2 OSDs set `replicated.size: 2` temporarily, NOT
> size 1 — `requireSafeReplicaSize` forbids size 1) and add the third OSD by filling
> its WWN + re-syncing once the disk is present. local-path-provisioner is the
> last-resort non-replicated stopgap only if no raw disk is usable on any node.

### Step 8 — land the platform (ArgoCD + app-of-apps) on the real cluster
**PRE-REQ: Step 7 Ceph `HEALTH_OK` + `ceph-block` default StorageClass.** Harbor / Dex /
ARC PVCs land on ceph-block, so storage must be green first. Run from a worktree that
has the merged platform-infra (the `p4/rook-ceph-storage` content), with the Talos
kubeconfig:
```fish
set -x KUBECONFIG /home/ccsmith33/Projects/Capstone-Modernization/.wt-talos/clusters/real-talos/talos-kubeconfig
kubectl config get-contexts                       # confirm the context is admin@capstone (cluster capstone), NOT k3d-*
```

**8a — repo base.** The manifests' repoURLs point at `github.com/UA-MIS/platform-infra`.
If that IS the real GitOps home for the Talos cluster, **skip `make set-repo-base`**
(no-op). Only run it if the cluster pulls from a different base — set `GIT_BASE_URL` in
`clusters/real-talos/values.env` first, then `make set-repo-base TARGET=real-talos`.
(Also fill `PLATFORM_DOMAIN` + `REGISTRY` in that values.env before Harbor's ingress
comes up — they're still `REPLACE_ME` placeholders; not bootstrap-blocking but Harbor's
ingress host needs them.)

**8b — install ArgoCD + the app-of-apps root (KUBE_CONTEXT override).** The Makefile
defaults to the k3d context; override it for Talos:
```fish
make bootstrap TARGET=real-talos KUBE_CONTEXT=admin@capstone \
  KUBECONFIG=/home/ccsmith33/Projects/Capstone-Modernization/.wt-talos/clusters/real-talos/talos-kubeconfig
# installs ArgoCD v3.4.3, applies the platform AppProject + root-app; the root-app
# recurse then fans in platform-services + the Helm apps (Rook adopts its existing
# Helm releases by name, metrics-server, Harbor, Dex, ARC).
```

**8c — sealed-secrets sealing-key migration (DESTRUCTIVE-ADJACENT, SECURITY-GATED).**
The 5 committed SealedSecrets (harbor-admin, harbor-oidc, argocd-config/Dex SSO,
arc-github-app) were sealed against the **k3d** sealed-secrets controller's keypair. A
fresh Talos controller generates a NEW keypair, so those SealedSecrets will NOT decrypt
there until the OLD private key is migrated in. **Migrate** (keeps all committed
SealedSecrets valid — no re-seal):
```fish
# ⚠ The exported secret IS the cluster's PRIVATE sealing key — same sensitivity class
#   as talsecret / the cluster CA. /tmp only, NEVER commit, shred after import.
#   SECURITY REVIEWS this step before the human runs it.

# 1) export the active sealing key from the k3d cluster (still up):
kubectl --context k3d-capstone -n kube-system \
  get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml > /tmp/ss-key.yaml

# 2) import it into the Talos cluster (after the sealed-secrets app has synced in 8b):
kubectl --context admin@capstone apply -f /tmp/ss-key.yaml

# 3) restart the Talos controller so it loads the migrated key:
kubectl --context admin@capstone -n kube-system rollout restart deploy sealed-secrets-controller
kubectl --context admin@capstone -n kube-system rollout status  deploy sealed-secrets-controller

# 4) SHRED the exported private key immediately:
shred -u /tmp/ss-key.yaml    # or: rm -P /tmp/ss-key.yaml
```
Then verify the SealedSecrets decrypt (the underlying Secrets get created):
```fish
kubectl --context admin@capstone -n harbor get secret harbor-admin          # EXPECT: exists
kubectl --context admin@capstone -n argocd get secret argocd-dex-server      # (or the Dex SSO secret name)
kubectl --context admin@capstone get sealedsecret -A                         # EXPECT: all Synced, no decrypt errors
```
> **If k3d is gone / the key is lost:** you cannot migrate — RE-SEAL instead. Recreate
> each plaintext source Secret, `make seal SECRET=… NS=… KUBE_CONTEXT=admin@capstone`
> against the new controller, and re-commit all 5 SealedSecrets. More work + needs all
> 5 plaintext sources in hand.

**8d — verify the fleet is green.**
```fish
kubectl --context admin@capstone -n argocd get applications      # EXPECT: all Synced/Healthy
# (intentional exception: platform-netpol-controlplane stays OutOfSync — SEC-011 manual gate)
kubectl --context admin@capstone get pvc -A                      # Harbor/etc PVCs Bound on ceph-block
```
**GATE: platform fleet green on ceph-block storage.** AFTER this: netpol CIDR re-param
for the overlay ranges (security-gated) + the DB tier, per the team lead.

---

### Troubleshooting quick-refs
- **Node went offline after apply / "Applied configuration without a reboot" but never
  installed** = the network config named a non-existent interface (e.g. hardcoded
  `eth0`), so the real NIC lost DHCP → no network → no installer pull → no install.
  The node is NOT installed (still on USB/RAM), so just **power-cycle it back into
  maintenance mode** (DHCP returns), confirm `get links`, and re-apply with the
  CORRECTED config (deviceSelector physical:true — already fixed in talconfig). No
  reinstall/wipe needed since it never installed.
- A node won't `apply-config`: it's not in maintenance mode (already configured) —
  `talosctl -n <ip> reset --graceful=false --reboot` to wipe back to maintenance.
- apiserver cert SAN errors after moving `endpoint` to the overlay IP: re-run
  `talhelper genconfig` + `talosctl apply-config` so the new SAN is in the cert.
- Talos can't see the disk at boot: BIOS storage is in **RAID** mode — switch to
  **AHCI** (the 7080s shipped RAID+Windows; AHCI is required for Talos to see nvme0n1).
- "disk in use" on apply: the NVMe still has the old Windows/partition table — Talos
  wipes the install disk on apply, but if it balks, `talosctl -n <ip> --insecure wipe
  disk nvme0n1` from maintenance first.
- Rook OSD never appears: the Ceph disk still has a partition table/filesystem — Rook
  skips non-empty disks. Re-run the Step-7b zap (`talosctl -n <node> wipe disk sda`),
  confirm `get discoveredvolumes` shows the bare `sda` disk with no `sdaN` partitions,
  then `kubectl -n rook-ceph rollout restart deploy rook-ceph-operator` to re-scan. Or
  the WWN in rook-ceph-cluster-app.yaml is wrong/placeholder — match `talosctl get disks`.
