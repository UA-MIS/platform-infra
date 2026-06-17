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

### Step 0 — WG-UDP probe: which overlay branch? (run BEFORE imaging)

Phase-4 needs a node-to-node overlay. Two branches; **the probe decides which**:
- **KubeSpan** (Talos-native WireGuard mesh, UDP) — preferred (no extra dependency)
  if the network lets WireGuard UDP through between the boxes.
- **Tailscale-everywhere** — fallback if UDP is blocked (Tailscale relays
  WireGuard over DERP/TCP-443, which is nearly unblockable).

Run the probe from **two machines on the SAME network segment the 7080s will live
on** (e.g. your laptop + any second host, or two of the boxes once booted into
Talos maintenance mode — but easiest to do now on two normal hosts on that LAN/VLAN).

**Probe A — general UDP verdict (needs Tailscale on the probe host; you already run it):**
```bash
tailscale netcheck
```
Read the output:
- **PASS (→ KubeSpan):** `UDP: true` AND it reports a **direct** path / a low-latency
  nearest DERP with `MappingVariesByDestIP: false` (well-behaved NAT). UDP egress works.
- **FAIL (→ Tailscale-everywhere):** `UDP: false`, or only DERP latencies are shown
  with no direct path (the network blocks/varies UDP). Corporate/campus firewalls
  that drop outbound UDP land here.

**Probe B — direct WireGuard-port reachability between the two hosts (authoritative
for the intra-LAN KubeSpan path; KubeSpan uses UDP/51820):**
```bash
# On host RECEIVER (one of the LAN hosts), open a UDP listener on the KubeSpan port:
nc -u -l 51820            # (BSD nc: `nc -u -l -p 51820`)

# On host SENDER (the other LAN host), send a datagram to RECEIVER's LAN IP:
echo "kubespan-probe" | nc -u -w3 <RECEIVER_LAN_IP> 51820
```
- **PASS (→ KubeSpan):** the string `kubespan-probe` appears on RECEIVER. UDP/51820
  flows between the boxes on this segment.
- **FAIL (→ Tailscale-everywhere):** nothing arrives within a few seconds → the
  segment filters UDP/51820 (host firewall or switch/VLAN ACL). Re-test with the
  host firewalls off to isolate; if still blocked, it's the network → Tailscale.

**DECISION:** Probe A `UDP:true` **and** Probe B delivers the datagram → **KubeSpan**.
Either fails → **Tailscale-everywhere**. Record the result here:
`[ ] KubeSpan   [ ] Tailscale-everywhere   (probe run: ____, by: ____)`

> Both overlay configs are provided in `clusters/real-talos/` and toggled by one
> variable — see Deliverable 2. The **Tailscale system extension is baked into the
> image regardless** (Step 1), so a KubeSpan→Tailscale switch needs NO re-imaging.

---

### Step 1 — generate the custom Talos image (Image Factory schematic)

These boxes need system extensions baked in: **iscsi-tools** + **util-linux-tools**
(Rook-Ceph RBD + disk tooling), **intel-ucode** (Comet Lake CPU microcode), and
**tailscale** (so the Tailscale overlay branch is available without re-imaging —
inert if KubeSpan is chosen). The 7080's NIC is Intel i219-LM, driven by the
in-kernel `e1000e` — **no NIC extension needed** (verify in Step 3 if a NIC doesn't
appear).

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

## DELIVERABLE 2 — 3-node install (configs in clusters/real-talos/, steps below)
*(filled in next — burn→boot→apply machine config→bootstrap etcd→verify Ready + Ceph HEALTH_OK)*
