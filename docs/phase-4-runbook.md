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
talhelper gensecret > talsecret.sops.yaml      # PROOF: leave plaintext LOCALLY; it's
                                               # gitignored — sops-encrypt before ANY commit
# Provide the Tailscale auth key via talenv.yaml — talhelper AUTO-LOADS it and
# envsubst's ${TS_AUTHKEY} into the tailscale ExtensionServiceConfig. More reliable
# than a shell export (an UNSET var silently substitutes to EMPTY — that's what put
# box-3 on the empty schematic + would break tailscale auth):
cat > talenv.yaml <<EOF
TS_AUTHKEY: "tskey-auth-...the-real-reusable-tag:talos-node-key..."
EOF
# talenv.yaml is gitignored; sops-encrypt -> talenv.sops.yaml before ANY commit.
talhelper genconfig                            # -> ./clusterconfig/{capstone-capstone-n1,-n2,-n3}.yaml + talosconfig
```
> The install image comes from the `schematic` block in talconfig (talhelper hashes
> it → the 8957 extension set), so NO `SCHEMATIC_ID` env is needed. Only `TS_AUTHKEY`
> is env-substituted — hence the talenv.yaml + the MANDATORY gate next.

### Step 3.5 — PRE-APPLY GATE: verify the generated config (catch unsubstituted values)
⚠ **Run this on EVERY generated node file BEFORE apply.** envsubst silently turns an
unset `${VAR}` into empty — this gate catches the whole class (the schematic-image,
authkey, and endpoint bugs would ALL have been caught here pre-hardware):
```bash
F=clusterconfig/capstone-capstone-n3.yaml      # repeat per node file
# (1) real Tailscale key present (expect a tskey-auth-... line), not literal/empty:
grep -i 'tskey-auth-' "$F" || echo "❌ NO real TS key — fix talenv.yaml + re-genconfig"
# (2) install image = the 8957 extension set, NOT the empty 376567:
grep 'image:.*metal-installer' "$F"            # expect 8957336b…a26972:v1.13.4
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
Put each node's path into `applicationsets/rook-ceph-cluster-app.yaml`
(`storage.nodes[].devices[].name`). n3 is pre-filled; replace the
`wwn-REPLACE_N1/N2_CEPH_DISK_WWN` placeholders as boxes 1 & 2 join. **The cluster app
must not sync with placeholders present** (it would target a non-existent device).

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
