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
> Keep this `SCHEMATIC_ID` — the machine configs reference the matching INSTALLER
> image `factory.talos.dev/metal-installer/${SCHEMATIC_ID}:v1.13.4` (Deliverable 2),
> so the installed system keeps the same extensions as the boot ISO.

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

### Step 3 — boot each 7080 from the USB into maintenance mode
For each box: insert the USB, power on, F12 → boot the USB. Talos boots into
**maintenance mode** (no config yet) and DHCPs an IP. Note each box's IP (from your
DHCP server, or the Talos console). Then CONFIRM hardware before applying config:
```bash
# NIC name (expect eth0 via in-kernel e1000e for the i219-LM) + the disks:
talosctl -n <BOX_IP> --insecure get links            # find the ethernet link name
talosctl -n <BOX_IP> --insecure disks                # OS SSD vs the 512GB Ceph NVMe
```
- If the NIC is NOT `eth0`, set the real name in `talconfig.yaml` `networkInterfaces`.
- If NO NIC appears at all, the box has a non-i219 PHY — capture `talosctl -n <ip>
  --insecure get pcidevices` and add the matching `siderolabs/<nic>-firmware`
  extension to the schematic (Step 1a) + re-burn. (Unlikely on a stock 7080.)
- Note which disk is the OS SSD (≤256GB) vs the 512GB NVMe; set `installDiskSelector`
  in `talconfig.yaml` accordingly. **The NVMe must stay raw for Ceph.**

### Step 4 — fill the configs + generate machine configs
In `clusters/real-talos/`:
1. Fill `values.env` (SCHEMATIC_ID from Step 1a, OVERLAY=kubespan|tailscale per the
   probe) and the placeholders in `talconfig.yaml` (node IPs, OS-disk selector, and
   `endpoint` = node-1's overlay IP — for KubeSpan you'll get the stable IP after
   bootstrap; bootstrap with node-1's LAN IP first, see note below).
2. If `OVERLAY=tailscale`: in `talconfig.yaml` comment the `kubespan.yaml` patch +
   uncomment `tailscale.yaml`, and put the tailnet auth key in the talhelper secret
   (`talsecret.sops.yaml`, sops-encrypted — never plaintext).
3. Generate secrets + machine configs:
```bash
cd clusters/real-talos
talhelper gensecret > talsecret.sops.yaml      # then: sops --encrypt -i talsecret.sops.yaml
talhelper genconfig                            # -> ./clusterconfig/*.yaml + talosconfig
```

### Step 5 — apply config to each node (installs Talos to the OS disk)
```bash
# Per node — apply its generated config (talhelper names them by hostname):
talosctl apply-config --insecure -n <BOX_IP> \
  --file clusterconfig/capstone-capstone-n1.yaml
# repeat for n2, n3. Each node installs Talos to the selected OS disk + REBOOTS
# off the USB into the installed system. (Remove the USB after first reboot.)
```

### Step 6 — bootstrap etcd (ONCE, on node-1 only)
```bash
# Point talosctl at the generated config + node-1:
export TALOSCONFIG=$(pwd)/clusterconfig/talosconfig
talosctl config endpoint <NODE1_IP> && talosctl config node <NODE1_IP>
talosctl bootstrap                              # initializes etcd on node-1 ONLY
```
> KubeSpan note: nodes form the WireGuard mesh once configured; after bootstrap,
> read node-1's stable KubeSpan address (`talosctl get kubespanidentities` /
> `talosctl get addresses`) and set `endpoint:` in talconfig to it, then
> `talhelper genconfig` + re-apply so the apiserver cert SANs include the overlay IP.
> (For Tailscale, use node-1's `100.x` tailnet IP as the endpoint.)

### Step 7 — get kubeconfig + verify the cluster is Ready
```bash
talosctl kubeconfig .                            # writes ./kubeconfig
export KUBECONFIG=$(pwd)/kubeconfig
kubectl get nodes -o wide                        # EXPECT: 3 nodes, all Ready, control-plane
talosctl -n <NODE1_IP> health                    # EXPECT: all checks pass (etcd, apid, kubelet)
```
**GATE: do not proceed until all 3 nodes are `Ready` and `talosctl health` is green.**

### Step 8 — storage class (SINGLE-DISK nodes → local-path now)
⚠ **The 7080 Micro is SINGLE-DISK** (only `nvme0n1`, which now holds the OS). There
is no raw dedicated disk for Ceph, so for the proof we use **local-path-provisioner**
as the storage class — fastest to a proven platform; the platform's GitOps/tenancy/CI
do not need replicated storage to be proven. **Ceph-on-a-partition is the documented
upgrade** (below), and a true dedicated Ceph disk is the real fix if the Micro can
take a second NVMe/SATA (verify the chassis — likely not on the Micro).
```bash
# local-path-provisioner (pin a current release), then make it the default SC:
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
kubectl get storageclass                          # EXPECT: local-path (default)
```
**GATE: a healthy proof cluster = 3 nodes `Ready` + `talosctl health` green + a
default StorageClass.** Stop here — the k3d→hardware migration (sealing-key migrate,
netpol CIDR re-param for the overlay ranges, `make bootstrap` with the kube-context
override) + the DB tier are sequenced AFTER this, per the team lead.

> **UPGRADE PATH — Ceph-on-partition (keep-it-replicated, when you want HA storage):**
> carve a raw partition out of `nvme0n1` (leave the OS + a capped EPHEMERAL partition,
> reserve the rest raw via a Talos user-volume / disk layout), then point Rook at the
> PARTITION (`devicePathFilter: ^/dev/nvme0n1p[0-9]+$`, NOT the whole device),
> `mon.count: 3`, `failureDomain: host`, `replicated.size: 3` — replica-3 across the
> 3 nodes' partitions is still a legit 3-failure-domain pool. This needs a Talos
> machine-config disk-layout change + re-apply (reinstall), so do it as a deliberate
> follow-up, not during first bring-up. (A second physical disk per node, if the
> chassis allows, is cleaner than partitioning — prefer that if available.)

---

### Troubleshooting quick-refs
- A node won't `apply-config`: it's not in maintenance mode (already configured) —
  `talosctl -n <ip> reset --graceful=false --reboot` to wipe back to maintenance.
- apiserver cert SAN errors after moving `endpoint` to the overlay IP: re-run
  `talhelper genconfig` + `talosctl apply-config` so the new SAN is in the cert.
- Talos can't see the disk at boot: BIOS storage is in **RAID** mode — switch to
  **AHCI** (the 7080s shipped RAID+Windows; AHCI is required for Talos to see nvme0n1).
- "disk in use" on apply: the NVMe still has the old Windows/partition table — Talos
  wipes the install disk on apply, but if it balks, `talosctl -n <ip> --insecure wipe
  disk nvme0n1` from maintenance first.
- (Ceph-on-partition upgrade only) OSD not created: Rook needs the PARTITION raw +
  `devicePathFilter` matching `nvme0n1pN`, not the whole in-use device.
