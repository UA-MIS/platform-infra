# Talos node onboarding

**Add or replace a Talos node in the `capstone` cluster with talhelper.**

Audience: platform operator with cluster admin + the handoff vault. This is the
**recurring** node op (grow the fleet, replace a dead box). For the **first-time
3-node bring-up from bare metal** (etcd bootstrap, Rook-Ceph, landing ArgoCD) use the
deeper [`docs/phase-4-runbook.md`](../phase-4-runbook.md); for the **CNI** see
[`docs/cilium-cni-runbook.md`](../cilium-cni-runbook.md).

> **⚠️ Mac Minis do NOT run Talos.** Late-2014 Mac Minis (`Macmini7,1`) **cannot boot
> Talos v1.13.4** (a Talos-build-specific early boot hang; the same box boots Debian 13
> fine). Such a box would have to join as a **Debian worker** instead — see
> [`docs/operator/debian-worker-onboarding.md`](debian-worker-onboarding.md), **not**
> this runbook. This runbook is for Talos-capable hardware (the Dell OptiPlex 7080 class).
>
> *No Mac Mini is in the fleet as of 2026-08-15* — the worker tier is `capstone-w1` /
> `capstone-w2` (Dell OptiPlex 7080). This note is retained because the finding still
> constrains any future attempt to use that hardware.

---

## 1. What's live today (verified)

| Fact | Value |
|---|---|
| Nodes | `capstone-n1`, `-n2`, `-n3` — 3× Dell OptiPlex 7080, **all control-plane + untainted (converged)**, plus `capstone-w1` and `capstone-w2` (Debian workers, also OptiPlex 7080) |
| Talos | **v1.13.4** (kernel `6.18.34-talos`) |
| Kubernetes | **v1.31.5** |
| CNI | Cilium v1.17.4 (installed post-bootstrap; `cniConfig.name: none` in talconfig, kube-proxy disabled) |
| Overlay | **Tailscale** everywhere (`taile5d412.ts.net` / `ualaims` tailnet); node-to-node + API rides `100.x` |
| apiserver endpoint | `https://100.117.55.70:6443` (n3's Tailscale IP; single-endpoint, cert SANs cover all 3) |
| Node LAN IPs | n1 `10.237.171.5`, n2 `10.237.171.6`, n3 `10.237.171.8` |
| Node Tailscale IPs | n1 `100.120.67.119`, n2 `100.89.87.126`, n3 `100.117.55.70` |
| Storage | Rook-Ceph replica-3 on each node's dedicated **SATA SSD** (`sda`); OS on `nvme0n1` |
| Config | talhelper — [`clusters/real-talos/talconfig.yaml`](https://github.com/UA-MIS/platform-infra/blob/main/clusters/real-talos/talconfig.yaml) + `patches/` |

Re-verify: `kubectl --context admin@capstone get nodes -o wide`.

---

## 2. The model — talhelper, one schematic, sops-encrypted secrets

Talos machine configs are **generated** by [`talhelper`](https://github.com/budimanjojo/talhelper)
from `clusters/real-talos/talconfig.yaml`. You never hand-edit a rendered machine
config; you edit `talconfig.yaml` + `patches/` and re-run `talhelper genconfig`.

- **Image = the Image Factory schematic**
  `8957336bb929170959e3afc61b9088e41cb072988407edd699b9b3deb4a26972`, which bakes in
  four system extensions: **`tailscale`** (the overlay — required), **`iscsi-tools`** +
  **`util-linux-tools`** (Rook-Ceph RBD + disk tooling), **`intel-ucode`** (Comet Lake
  microcode). It is pinned **per node** as `talosImageURL`
  (`factory.talos.dev/metal-installer/8957…`, **no `:version` suffix** — talhelper
  appends `:v1.13.4`).
- **Secrets are sops/age-encrypted** and read by talhelper at genconfig time:
  - `talsecret.sops.yaml` — the cluster **PKI** (CA keys, bootstrap token).
  - `talenv.sops.yaml` — env for `envsubst`, notably `TS_AUTHKEY` (the Tailscale
    node auth key) used by the `tailscale` extension patch.
  - Both decrypt with the **age private key** at `~/.config/sops/age/keys.txt`. The
    committed [`.sops.yaml`](https://github.com/UA-MIS/platform-infra/blob/main/.sops.yaml) holds only the **public** recipient
    (`age1ad2tla3wd2fzz8v6…`).

> ### ⚠️ CONTINUANCE-CRITICAL: `talsecret.sops.yaml` and `talenv.sops.yaml` are NOT in git
> They are **gitignored** (`clusters/real-talos/.gitignore`) and exist **only on the
> operator's workstation**. The age key merely *decrypts* them — you still need the
> files themselves. **A new node cannot join the existing cluster without the existing
> `talsecret.sops.yaml`:** regenerating it with `talhelper gensecret` mints a **new CA**,
> which would not match the running cluster. **Both files MUST be in the handoff vault**
> alongside the age key, or the cluster's PKI is unrecoverable. (This is a gap in the
> older handoff checklist — the vault must hold these two files, not just the age key.)

### Prerequisites (workstation, pinned)

```bash
# talosctl pinned to the cluster version:
curl -sL https://github.com/siderolabs/talos/releases/download/v1.13.4/talosctl-linux-amd64 \
  -o ~/.local/bin/talosctl && chmod +x ~/.local/bin/talosctl
# talhelper + sops + age -> ~/.local/bin  (see phase-4-runbook §Prereqs)
# the age PRIVATE key + talsecret.sops.yaml + talenv.sops.yaml from the handoff vault:
cp <vault>/keys.txt ~/.config/sops/age/keys.txt
cp <vault>/talsecret.sops.yaml <vault>/talenv.sops.yaml clusters/real-talos/
# prove you can decrypt (age key works):
sops -d clusters/real-talos/talsecret.sops.yaml >/dev/null && echo "✅ age key OK"
```

> **Shell = fish gotcha.** `export VAR=value` **silently fails** in fish. For env
> (`TALOSCONFIG`, `KUBECONFIG`) use `set -x VAR value`. For talhelper vars
> (`TS_AUTHKEY`) use `talenv.sops.yaml` — **never** a shell export (an unset var
> substitutes to empty → wrong image / broken tailscale auth).

---

## 3. Add or replace a Talos node

### Step 0 — the Tailscale auth key (overlay credential)

The nodes join the tailnet with a **reusable, tagged** auth key. If a current key is
still valid it's already in `talenv.sops.yaml` (`TS_AUTHKEY`). If you need a fresh one:
mint a **reusable, non-ephemeral, `tag:talos-node`** key in the Tailscale admin console
(`ualaims` tailnet), then `sops clusters/real-talos/talenv.sops.yaml` and update
`TS_AUTHKEY`. (Full ACL/tag detail: phase-4-runbook §Step 0.)

### Step 1 — burn the schematic ISO

Same schematic as the fleet (idempotent — the ID is a content hash):

```bash
SCHEMATIC=8957336bb929170959e3afc61b9088e41cb072988407edd699b9b3deb4a26972
curl -L -o talos-v1.13.4-metal-amd64.iso \
  "https://factory.talos.dev/image/${SCHEMATIC}/v1.13.4/metal-amd64.iso"
# write to USB (verify /dev/sdX!): sudo dd if=talos-*.iso of=/dev/sdX bs=4M status=progress oflag=sync
```

### Step 2 — declare the node in talconfig, then genconfig

Edit [`clusters/real-talos/talconfig.yaml`](https://github.com/UA-MIS/platform-infra/blob/main/clusters/real-talos/talconfig.yaml)
`nodes:` — add a new entry (copy an existing one). Keep the **node-level**
`talosImageURL` (⚠ a **top-level** `schematic:` is silently ignored by talhelper →
empty schematic → no tailscale). Set `controlPlane: true/false`:

- **Worker** (`controlPlane: false`): simplest; adds capacity, no etcd impact.
- **Control-plane** (`controlPlane: true`): joins etcd — **keep the CP count odd**
  (3 → 5, never 4) so quorum survives one loss. Add the node's Tailscale `100.x` to
  `additionalApiServerCertSans` too (so the API cert covers it).

Use `deviceSelector: { physical: true }` for the NIC — **never** hardcode `eth0`
(naming a non-existent iface took a box offline: phantom iface → real NIC lost DHCP →
no installer pull). Set `installDisk: /dev/nvme0n1` (OS); leave the SATA SSD raw for
Ceph.

```bash
cd clusters/real-talos
talhelper genconfig    # auto-decrypts talsecret/talenv -> ./clusterconfig/capstone-<node>.yaml + talosconfig
```

**Pre-apply gate (run per generated file — catches the whole silent-empty class):**

```bash
F=clusterconfig/capstone-capstone-n4.yaml
grep -i 'tskey-auth-' "$F"            || echo "❌ no real TS key"
grep -q 'metal-installer/8957336bb929170959e3afc61b9088e41cb072988407edd699b9b3deb4a26972' "$F" \
  && echo "✅ 8957 image" || echo "❌ WRONG image (talosImageURL must be node-level, no :version)"
grep -nE '\$\{[A-Z_]+\}|\$\([a-z]+\)' "$F" && echo "❌ unsubstituted \${VAR} / \$(shell-sub)" || echo "✅ clean"
```

### Step 3 — apply to the box (target its current maintenance IP)

BIOS: SATA mode **AHCI** (not RAID, or Talos can't see `nvme0n1`), USB first. Boot the
box; it comes up in **maintenance mode** and DHCPs. The switch **must have an internet
uplink** (the box pulls the factory installer + joins Tailscale — air-gapped = fail).

```bash
MIP=<box maintenance IP from the Talos console / DHCP>
talosctl -n $MIP --insecure get links     # confirm the real NIC name (Intel = enp0s31f6/eno1)
talosctl -n $MIP --insecure get disks      # expect nvme0n1 (install target) + the SATA SSD
talosctl apply-config --insecure -n $MIP --file clusterconfig/capstone-capstone-n4.yaml
```

The box installs to `nvme0n1`, reboots off USB into the installed system, and joins
the tailnet. Remove the USB after first reboot.

### Step 4 — join the cluster

- **Worker:** it joins automatically once the config is applied and it reaches the
  apiserver endpoint over Tailscale. It stays `NotReady` until the **Cilium** agent
  schedules on it (Cilium is installed cluster-wide already).
- **Control-plane:** no `talosctl bootstrap` (that's **first-node-only**, once per
  cluster lifetime — never re-run it). The new CP joins the existing etcd quorum
  automatically. Confirm:
  ```bash
  talosctl -n <new-node 100.x> get members
  talosctl -n 100.117.55.70 etcdmembers      # expect the new member Added/started
  ```

### Step 5 — Ceph OSD (if the node has a SATA SSD for storage)

Add the node's disk to `applicationsets/rook-ceph-cluster-app.yaml` by its **stable
WWN** (`/dev/disk/by-id/wwn-…`, from `talosctl -n <node> get disks` — the kernel name
`sda` floats). Zap the disk first if it has a leftover partition table (Rook refuses
non-empty disks): `talosctl -n <node> wipe disk sda` (**never `nvme0n1`**). Full detail:
phase-4-runbook §Step 7.

### Step 6 — verify Ready

```bash
kubectl --context admin@capstone get nodes -o wide          # new node Ready
talosctl -n <new-node 100.x> health                          # etcd/apid/kubelet green (CP)
kubectl --context admin@capstone -n kube-system get pod -o wide | grep <node>   # cilium Running
```

---

## 4. Replace a dead node

Same as add, plus first evict the old one from the cluster and etcd:

```bash
kubectl --context admin@capstone drain <node> --ignore-daemonsets --delete-emptydir-data
kubectl --context admin@capstone delete node <node>
# for a control-plane node, remove its etcd member so quorum math is correct:
talosctl -n <a live node 100.x> get members
talosctl -n <a live node 100.x> etcd remove-member <old-node>   # or `talosctl reset` the dead box if reachable
```

Then image the replacement (§3). Reuse the **same `talconfig` node entry** (update its
Tailscale IP once known) so the SANs/WWN stay consistent.

> If the apiserver endpoint node (**n3**) is the one that died, the API endpoint is
> temporarily gone (single-endpoint design). Repoint `talosctl`/kubeconfig to another
> CP node's `100.x` (its Tailscale IP is already a cert SAN — no cert regen needed), and
> update `endpoint:` in `talconfig.yaml`.

---

## 5. Load-bearing gotchas (each cost real time)

- **Node-level `talosImageURL`, no version suffix.** A top-level `schematic:` block is
  silently ignored by talhelper → empty schematic `376567…` → no tailscale → the box
  is unreachable and never installs. A `:vX.Y.Z` suffix fails validate.
- **No `$(...)` command-substitution anywhere** in talconfig/patches — talhelper's
  envsubst expands `${VAR}` only; a literal `$(hostname)` survives and breaks
  `tailscale up`. The pre-apply gate greps for both forms.
- **`deviceSelector: { physical: true }`, never a hardcoded iface name.**
- **BIOS AHCI, not RAID** (the 7080s ship RAID+Windows) or Talos can't see `nvme0n1`.
- **`talosctl apply-config` dials the talosconfig *endpoint*, not `-n`.** If the
  endpoint is unreachable after a genconfig, override with `-e <reachable-ip>`.
- **fish `export` silently fails** — use `set -x`. Put talhelper vars in
  `talenv.sops.yaml`, not shell exports.
- **Never re-run `talosctl bootstrap`** — it is once-per-cluster (first node only).
- **Confirm you're on the right cluster:** `kubectl config current-context` should be
  `admin@capstone`, not `k3d-capstone`.

---

## 6. Related runbooks

- First-time 3-node bring-up (etcd, Rook, ArgoCD, sealing-key migration): [`phase-4-runbook.md`](../phase-4-runbook.md)
- Cilium CNI (why nodes are `NotReady` pre-Cilium; the Tailscale/eBPF `hostLegacyRouting` hazard): [`cilium-cni-runbook.md`](../cilium-cni-runbook.md)
- Mac Mini / Debian workers (the boxes that can't run Talos): [`debian-worker-onboarding.md`](debian-worker-onboarding.md)
- The successor overview + continuance: [`OPERATIONS-AND-HANDOFF.md`](../OPERATIONS-AND-HANDOFF.md)
