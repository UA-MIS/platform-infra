# Debian Mac-Mini worker onboarding

**Turn a fresh Debian 13 Mac Mini into a Ready Kubernetes worker in the Talos cluster.**

Audience: platform operator. Tooling: an Ansible controller + `kubectl`/`talosctl`
with cluster admin, and access to the Tailscale admin console for tailnet
`taile5d412.ts.net`.

Automation: [`ansible/`](../../ansible/) (playbook `site.yml`, roles
`common` → `hardening` → `containerd` → `tailscale` → `kubelet_join`).

---

## 1. Why this exists

There are ~20 **Late-2014 Mac Minis (`Macmini7,1`)** to add as workers. They
**cannot boot Talos v1.13.4** — a Talos-build-specific boot hang on this hardware.
Debian 13 (trixie) boots fine on the same 6.12-series kernel and the on-board
**Broadcom BCM57766** NIC works with the in-tree `tg3` driver. So these boxes run
**Debian** and join the existing Talos-bootstrapped cluster as ordinary kubelet
workers.

The control plane is 3 Talos nodes; **all workloads already run on the (untainted)
control plane**, so the Macs simply add capacity.

### Live cluster facts baked into the automation (read-only, 2026-07-03)

| Fact | Value | Source |
|---|---|---|
| Kubernetes version | **v1.31.5** | `kubectl version` (server) |
| API endpoint | **`https://100.117.55.70:6443`** | `kubectl cluster-info` (n3 Tailscale IP) |
| API cert SANs | all 3 CP Tailscale IPs + LAN IPs | `openssl s_client` |
| Cluster CA | `O=kubernetes`, valid → 2036-06-14 | `kube-root-ca.crt` |
| CNI | **Cilium v1.17.4**, tunnel/VXLAN, `kubeProxyReplacement=true`, `hostLegacyRouting=true`, `ipam=kubernetes` | `cilium-config` |
| kube-proxy | **absent** (Cilium replaces it) | `kubectl -n kube-system get ds` |
| CoreDNS ClusterIP | **10.96.0.10** | `kube-dns` svc |
| Service CIDR / Pod CIDR | 10.96.0.0/12 / 10.244.0.0/16 | apiserver SAN / CiliumNode |
| CP node InternalIPs (VXLAN underlay) | 10.237.171.5 / .6 / .8 | `kubectl get nodes -o wide` |
| Worker taints/labels | control plane is **untainted** | node objects |

Re-verify any time with `make -C ansible show-cluster-facts`.

---

## 2. The crux — joining a non-Talos node to a Talos cluster

Talos has **no kubeadm**, so there is no `kubeadm join` and no `kubeadm token`.
We use the **native Kubernetes TLS bootstrap** that kubeadm itself is built on:

1. The operator mints a **bootstrap-token Secret** (`bootstrap.kubernetes.io/token`)
   in `kube-system`.
2. The kubelet starts with a **bootstrap kubeconfig** (API endpoint + cluster CA +
   that token). It authenticates as the token, whose extra group is
   `system:bootstrappers:nodes`, and **creates a CSR** for its own client cert.
3. The in-cluster **csrapprover controller auto-approves** that client CSR, because
   the required RBAC **already exists in this cluster** (it was laid down at Talos
   bootstrap):

   ```
   system-bootstrap-node-bootstrapper        -> system:node-bootstrapper
       subjects: Group system:bootstrappers:nodes, Group system:nodes
   system-bootstrap-approve-node-client-csr  -> ...:certificatesigningrequests:nodeclient
       subjects: Group system:bootstrappers:nodes
   system-bootstrap-node-renewal             -> ...:certificatesigningrequests:selfnodeclient
       subjects: Group system:nodes
   ```

   Confirm they are present:
   ```bash
   kubectl get clusterrolebindings | grep system-bootstrap
   ```
   **You do NOT need to create these bindings** — only the token.
4. The kubelet writes its issued credential to `/etc/kubernetes/kubelet.conf` and
   registers the `Node`. It stays `NotReady` until the **Cilium** agent schedules a
   pod on it and installs the CNI, then goes `Ready`.

We deliberately **do not** enable `serverTLSBootstrap`, so the kubelet self-signs
its *serving* cert and **no kubelet-serving CSR needs manual approval** (this
cluster has no serving-cert auto-approver — enabling it would leave CSRs `Pending`).

### 2a. Node identity: `--node-ip` = the Tailscale 100.x IP

The Talos control-plane nodes have **static LAN IPs** (10.237.171.x) and register
those as their InternalIP. The Macs get **DHCP** and will be **relocated** (their
LAN IP changes), so we register each Mac with its **stable Tailscale 100.x IP** as
`--node-ip`. Benefits:

- The apiserver can always reach the Mac's kubelet (logs/exec/metrics) at a stable
  address over the tailnet, regardless of which LAN the Mac is on.
- The node identity doesn't churn when DHCP hands out a new address.

### 2b. ⚠️ Routing prerequisite (READ THIS — it is the one real gotcha)

Cilium runs in **VXLAN tunnel** mode and uses each node's **InternalIP** as the
tunnel underlay endpoint. So:

- **Talos → Mac** VXLAN goes to the Mac's InternalIP = **100.x** → rides Tailscale
  → always works (the CP nodes are on the tailnet). ✅
- **Mac → Talos** VXLAN goes to the CP node InternalIP = **10.237.171.x** → the Mac
  needs **L3 reachability to `10.237.171.0/24`**.

There are **no Tailscale subnet routes** advertised in this tailnet (every peer is a
`/32`), so a Mac on a *different* subnet cannot reach `10.237.171.0/24` by itself.
Satisfy the prerequisite one of two ways:

- **Recommended:** keep the Macs on the **same lab LAN** as the Talos nodes
  (`10.237.171.0/24`, where `ua-mis-db-1` and the CP nodes already live). Then the
  route is automatic. This is the default assumption.
- **If a Mac must live on another subnet:** stand up a **Tailscale subnet router**
  advertising `10.237.171.0/24` and approve the route in the admin console.

The playbook does not assume L2 adjacency for the *SSH* transport (it reaches the box
by Tailscale name/IP), but the *Cilium data plane* needs the route above. Validation
step 8 checks it explicitly.

---

## 3. Security tradeoff vs pure-Talos (call-out)

Talos is a minimal, immutable, API-only OS with no shell and no package manager.
Debian is a general-purpose, **mutable** OS with SSH, a package manager, systemd
services, and a writable rootfs — a **materially larger attack surface**. By adding
Debian workers you accept:

| Risk on Debian (not present on Talos) | Mitigation in this automation |
|---|---|
| Interactive SSH / password auth | `hardening` role: **key-only SSH**, no root password login, `MaxAuthTries 3` |
| Package/supply-chain drift | Versions **pinned + held** (`kubelet`, `cri-tools`, `containerd.io`); `unattended-upgrades` restricted to **security** origin and **blacklists** the k8s packages |
| Unpatched kernel/userland | `unattended-upgrades` (security), **no auto-reboot** (operator drains first) |
| Extra running services | `hardening` disables `avahi`, `cups`, `bluetooth`, `ModemManager` |
| Host network exposure | Optional **overlay-safe nftables** ruleset (default **OFF**; enable in a window — see §7) |
| Mutable node = weaker workload isolation | Prefer the **taint** (`mac_worker_taint_enabled: true`) to keep sensitive workloads off the Macs; rely on Cilium NetworkPolicy for pod isolation |

Because these nodes are less trustworthy than the Talos control plane, treat them as
a **lower-trust pool** (label `capstone.io/pool=mac-debian`) and steer sensitive
workloads away with the taint if warranted.

---

## 4. Operator prerequisites (cluster writes — do these BEFORE the first play run)

> The Ansible play performs **no cluster writes**. Minting the token and (later)
> labelling the node are operator actions. Commands below use placeholders.

### 4.1 Mint the kubelet bootstrap token

```bash
# 6-char id + 16-char secret (lowercase alnum), per the bootstrap-token format.
TOKEN_ID=$(openssl rand -hex 3)                 # e.g. 7f2a1c
TOKEN_SECRET=$(openssl rand -hex 8)             # e.g. 0b1d2e3f4a5b6c7d

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: bootstrap-token-${TOKEN_ID}
  namespace: kube-system
type: bootstrap.kubernetes.io/token
stringData:
  token-id: "${TOKEN_ID}"
  token-secret: "${TOKEN_SECRET}"
  usage-bootstrap-authentication: "true"
  usage-bootstrap-signing: "true"
  auth-extra-groups: "system:bootstrappers:nodes"
  expiration: "$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)"
EOF

echo "kubelet_bootstrap_token: ${TOKEN_ID}.${TOKEN_SECRET}"
```

- Put `${TOKEN_ID}.${TOKEN_SECRET}` into `kubelet_bootstrap_token` in
  `secrets.yml`.
- `auth-extra-groups: system:bootstrappers:nodes` is **required** — it maps the
  token onto the auto-approver RBAC (§2). The default `system:bootstrappers` group
  alone would leave the CSR `Pending`.
- Keep the TTL short (mint per onboarding batch). Reusable across all boxes in that
  batch. It expires on its own; the Secret can also be deleted afterward.

### 4.2 Create a reusable, pre-approved Tailscale auth key

In the Tailscale admin console for `taile5d412.ts.net` → **Settings → Keys →
Generate auth key**:

- **Reusable:** ON (one key onboards the whole fleet).
- **Pre-approved:** ON (so nodes join without manual device approval; requires
  device approval to be on for the tailnet).
- **Ephemeral:** **OFF** (these nodes persist across reboots).
- **Tags:** apply the tag your ACL uses for these boxes (the CP nodes show as
  `tagged-devices`; use the same tag, e.g. `tag:capstone`), so ACLs treat the Mac
  like the other cluster nodes.

Put the key into `tailscale_authkey` in `secrets.yml`. Confirm the tailnet ACL
permits that tag to reach `:6443`, `:10250`, and UDP `:8472` on the cluster peers
(the existing nodes already have this).

### 4.3 (If Macs are off the CP LAN) advertise the underlay route

See §2b. Add a subnet router for `10.237.171.0/24` and approve it. Skip if the Macs
are on `10.237.171.0/24`.

### 4.4 Refresh the shipped cluster CA (only if it ever rotated)

The play ships the current CA at `ansible/roles/kubelet_join/files/cluster-ca.crt`.
It is valid until 2036, but if the cluster CA is ever rotated:

```bash
make -C ansible fetch-ca
```

---

## 5. Prepare the Ansible controller

```bash
cd ansible
cp inventory/hosts.example.ini inventory/hosts.ini
# set ansible_host (Tailscale name/IP, or LAN IP for the very first pre-Tailscale run)
# and a unique kube_node_name per box.

cp inventory/group_vars/secrets.example.yml inventory/group_vars/secrets.yml
$EDITOR inventory/group_vars/secrets.yml     # kubelet_bootstrap_token + tailscale_authkey
ansible-vault encrypt inventory/group_vars/secrets.yml

# Add your admin SSH public key(s) so key-only SSH does not lock you out:
$EDITOR inventory/group_vars/mac_workers.yml # set admin_ssh_keys: [...]
```

Base image assumptions for each Mac before the play runs: Debian 13 installed,
network up, an `admin` sudo user reachable over SSH (password or key), Python 3
present (Debian ships it).

Validate before touching a box:

```bash
make syntax
make check LIMIT=mac-debian-01     # dry run (--check --diff)
```

---

## 6. Run the play

```bash
# One box (recommended for the first of a batch):
make run LIMIT=mac-debian-01 --ask-vault-pass
#   == ansible-playbook site.yml --limit mac-debian-01 --ask-vault-pass

# Whole fleet, once validated:
make run-all --ask-vault-pass
```

What it does per host: base prep + hardening → install & configure containerd →
`tailscale up` (records the 100.x IP) → install pinned kubelet, drop the CA +
bootstrap kubeconfig + kubelet config + systemd flags → start kubelet → **wait for
`/etc/kubernetes/kubelet.conf`** (proves the TLS bootstrap succeeded).

### 6.1 Post-join operator step — label the node (cluster write)

Custom-prefix labels can't be self-set by the kubelet (NodeRestriction), so apply
the pool label from your admin workstation:

```bash
kubectl label node mac-debian-01 capstone.io/pool=mac-debian --overwrite
# optional, only if you also want the steering taint AND did not set it via the play:
# kubectl taint node mac-debian-01 capstone.io/pool=mac-debian:NoSchedule
```

---

## 7. Enabling the host firewall (optional, later)

`hardening_firewall_enabled` defaults **OFF**. An incorrectly-scoped host firewall on
a Cilium `hostLegacyRouting` node can break the datapath, so the shipped
`nftables.conf.j2` is overlay-safe (accepts `tailscale0`, Cilium interfaces, VXLAN
`8472/udp`, kubelet `10250`, Cilium health `4240`, NodePorts; leaves FORWARD to
Cilium/NetworkPolicy) but you should still enable it in a **maintenance window**:

```bash
# after validating on clay-mac1:
ansible-playbook site.yml --limit mac-debian-01 --tags hardening \
  -e hardening_firewall_enabled=true --ask-vault-pass
```

Keep an out-of-band console (or a second SSH from the tailnet) open while you do it.

---

## 8. Validate on clay-mac1 (first-node acceptance)

`clay-mac1` is offline being relocated; its DHCP IP will change. **Do not hardcode a
LAN IP.** When it's back, find it by Tailscale or an SSH scan:

```bash
# by Tailscale (once it has ever joined) — or ping its MagicDNS name:
tailscale status | grep -i mac
# or scan the lab subnet for an SSH responder (adjust CIDR to the current lab LAN):
nmap -p22 --open -oG - 10.237.171.0/24 | awk '/22\/open/{print $2}'
```

Set that as `ansible_host` for `mac-debian-01` and run the play (§6). Then verify
from an admin workstation with cluster access:

```bash
# 1) Node registered and Ready, InternalIP is the Tailscale 100.x:
kubectl get node mac-debian-01 -o wide
kubectl get node mac-debian-01 -o jsonpath='{.status.addresses}{"\n"}'
#    expect: InternalIP = 100.x  ,  STATUS eventually Ready

# 2) No stuck CSRs (client CSR should be auto-Approved,Issued):
kubectl get csr | grep -i mac-debian-01 || echo "none pending"

# 3) Cilium scheduled a pod on it and it's Running:
kubectl -n kube-system get pod -o wide | grep mac-debian-01
kubectl -n kube-system exec ds/cilium -- cilium-dbg status --brief   # any cilium pod

# 4) Cilium sees the node healthy (VXLAN underlay reachability — the §2b crux):
kubectl -n kube-system exec ds/cilium -- cilium-dbg status | grep -A3 Controllers
kubectl -n kube-system exec <cilium-pod-on-mac> -- cilium-dbg node list
#    the Mac must reach the CP nodes' 10.237.171.x endpoints; on the Mac itself:
#    ping -c1 10.237.171.8   (must succeed — else fix the routing prerequisite §2b)

# 5) A test workload actually schedules + gets DNS + cross-node networking:
kubectl run mac-smoke --image=registry.k8s.io/e2e-test-images/agnhost:2.47 \
  --overrides='{"spec":{"nodeName":"mac-debian-01"}}' --restart=Never -- \
  sh -c 'nslookup kubernetes.default && sleep 3600'
kubectl wait --for=condition=Ready pod/mac-smoke --timeout=120s
kubectl logs mac-smoke | head        # expect the DNS answer for kubernetes.default
kubectl exec mac-smoke -- wget -qO- --timeout=5 https://kubernetes.default/healthz --no-check-certificate || true
kubectl delete pod mac-smoke

# 6) (If Hubble enabled) observe flows to confirm cross-node connectivity:
# kubectl -n kube-system exec ds/cilium -- hubble observe --node mac-debian-01 --last 20
```

Green = node `Ready`, Cilium pod `Running`, DNS resolves, cross-node/apiserver
reachable. Then proceed to the rest of the fleet.

---

## 9. Rollback / cleanup (remove a Mac worker)

**From an admin workstation (cluster side):**
```bash
kubectl cordon mac-debian-01
kubectl drain mac-debian-01 --ignore-daemonsets --delete-emptydir-data --force
kubectl delete node mac-debian-01
```

**On the Mac (or via Ansible ad-hoc):**
```bash
sudo systemctl disable --now kubelet containerd
sudo tailscale logout && sudo systemctl disable --now tailscaled
sudo rm -rf /etc/kubernetes /var/lib/kubelet /var/lib/containerd /etc/cni/net.d /opt/cni/bin
```

**Cluster hygiene:**
```bash
# revoke the node's Tailscale device in the admin console (or:)
# tailscale (admin) delete device <mac-debian-01>
# expire/delete the bootstrap token if still present:
kubectl -n kube-system delete secret bootstrap-token-<id>
# remove any leftover CSRs for the node:
kubectl get csr | grep mac-debian-01
```

To re-onboard, mint a fresh token (§4.1) and re-run the play.

---

## 10. Reference — files

- Playbook & roles: [`ansible/`](../../ansible/) — see [`ansible/README.md`](../../ansible/README.md)
- Cilium-on-Talos design & the Tailscale-overlay hazard:
  [`docs/cilium-cni-runbook.md`](../cilium-cni-runbook.md)
