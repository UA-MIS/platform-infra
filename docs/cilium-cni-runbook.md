# Cilium CNI swap — maintenance-window runbook (Talos, NetworkPolicy enforcement)

**Status: PREP / DRAFT. DO NOT RUN until the human approves the Cilium-vs-Canal decision
(architect ADR) and schedules a maintenance window.** This is the design + exact sequence,
staged so it's ready; it is not yet a go.

## Why

Talos ships **flannel**, which has **no NetworkPolicy backend** — every NetworkPolicy in
this repo is accepted by the API but **NOT enforced** (tenant isolation, the SEC-011
control-plane denies, the SEC-014 runner egress lockdown all currently provide ZERO real
protection). Going public via the Cloudflare Tunnel with inert netpols is the risk
security flagged. Replacing flannel with a **policy-enforcing CNI** is the prerequisite
for a safe public cutover.

**Decision (devops recommendation — human/architect to confirm):** **Cilium**, replacing
flannel, in `kubeProxyReplacement` mode.
- Cilium is the de-facto Talos default-replacement (first-class in the Talos docs), eBPF
  dataplane, replaces kube-proxy, rich L3–L7 NetworkPolicy + CiliumNetworkPolicy, and
  Hubble for flow visibility (proves the deny-test + debugs the isolation rules).
- **Fallback = Canal** (flannel dataplane + Calico policy only): smallest change to the
  running dataplane, but legacy and no kube-proxy-replacement / Hubble upside. Choose this
  only if the team wants the most conservative swap.

## 🟥 THE REAL DANGER — Cilium eBPF vs the Tailscale overlay (READ FIRST)

This cluster is **Tailscale-everywhere**: the node-to-node and apiserver paths ride the
Tailscale overlay (`100.x`), not the raw LAN. Cilium's eBPF host-routing **bypasses the
kernel routing table**, which can break overlay paths (asymmetric routing → nodes can't
reach each other / the apiserver → cluster falls apart). The Talos docs call this out for
KubeSpan; the same hazard applies to Tailscale.

**Mitigation (MANDATORY in the Helm values):**
```yaml
bpf:
  hostLegacyRouting: true   # eBPF host routing OFF -> traffic uses the kernel route table,
                            # so the Tailscale overlay routes still apply. WITHOUT THIS the
                            # node/apiserver-over-Tailscale paths can break = cluster outage.
```
**How to validate it before trusting the cluster (do this on the FIRST node, before
rolling the rest):** after Cilium is up on node-1, from a test pod confirm it can reach
(a) CoreDNS, (b) the `kubernetes` Service (10.96.0.1:443), and (c) a pod on ANOTHER node
(cross-node overlay path — this is the one that breaks if hostLegacyRouting is wrong):
```fish
kubectl run nettest --image=nicolaka/netshoot --restart=Never -it --rm -- \
  sh -c 'nslookup kubernetes.default && nc -zv 10.96.0.1 443 && echo OK'
# then exec into a pod on node-1 and ping/curl a pod IP on node-2/3 (cross-node).
cilium status        # EXPECT: all green, KubeProxyReplacement: True, no errors
cilium connectivity test   # the authoritative cross-node + policy datapath test
```
If `cilium connectivity test` fails the cross-node cases → STOP, the overlay/eBPF
interaction is wrong; do NOT proceed to the other nodes. (This is why we do node-1 first.)

## Pre-reqs (verify before the window)
- KubePrism (the localhost:7445 apiserver proxy) is enabled — Talos ≥1.5 default ON; Cilium's
  `kubeProxyReplacement` points `k8sServiceHost=localhost k8sServicePort=7445` at it. Confirm:
  `talosctl -n <node> get kubeprismconfig` (or it's on by default; if off, enable via
  `machine.features.kubePrism.enabled: true` + port 7445 in talconfig before this).
- iscsi/util-linux extensions already present (they are — Rook needs them).
- A maintenance window: this re-applies machine config to ALL 3 control-plane nodes and
  briefly disrupts pod networking. Storage/Harbor/etc. tolerate a short network blip but
  expect pod restarts.
- Merge **PR #40 (netpol CIDR re-param)** first so the (now-enforced) policies have the
  correct Talos CIDRs the moment Cilium starts enforcing.

## Step 1 — talconfig: disable flannel + kube-proxy (machine config patch)

Add to `clusters/real-talos/talconfig.yaml` cluster network (commit as part of the swap):
```yaml
cluster:
  network:
    cni:
      name: none            # was flannel — Talos will NOT install a CNI; Cilium provides it
  proxy:
    disabled: true          # kube-proxy off — Cilium's kubeProxyReplacement takes over
```
(pod/service subnets stay 10.244.0.0/16 / 10.96.0.0/12 — unchanged.)

Then (fish-safe, from the talos worktree):
```fish
cd /home/ccsmith33/Projects/Capstone-Modernization/.wt-talos/clusters/real-talos
set -x TALOSCONFIG (pwd)/clusterconfig/talosconfig
talhelper genconfig
# Apply to node-1 FIRST (validate Cilium there before the rest):
talosctl apply-config -n 100.120.67.119 --file clusterconfig/capstone-capstone-n1.yaml
# (n1 will have no CNI until Cilium installs in Step 2 — expected; pods Pending meanwhile.)
```

## Step 2 — install Cilium (Helm) with the Talos + Tailscale-safe values

```fish
set -x KUBECONFIG /home/ccsmith33/Projects/Capstone-Modernization/.wt-talos/clusters/real-talos/talos-kubeconfig
helm repo add cilium https://helm.cilium.io/ ; helm repo update cilium
helm install cilium cilium/cilium --version 1.17.4 --namespace kube-system \
  --set ipam.mode=kubernetes \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=localhost \
  --set k8sServicePort=7445 \
  --set bpf.hostLegacyRouting=true \
  --set securityContext.capabilities.ciliumAgent='{CHOWN,KILL,NET_ADMIN,NET_RAW,IPC_LOCK,SYS_ADMIN,SYS_RESOURCE,DAC_OVERRIDE,FOWNER,SETGID,SETUID}' \
  --set securityContext.capabilities.cleanCiliumState='{NET_ADMIN,SYS_ADMIN,SYS_RESOURCE}' \
  --set cgroup.autoMount.enabled=false \
  --set cgroup.hostRoot=/sys/fs/cgroup \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true
# the ciliumAgent caps + cgroup.autoMount=false + hostRoot are the REQUIRED Talos-specific
# values (Talos mounts cgroupv2 read-only; Cilium must not try to mount it).
```
Then run the **Step-0 validation** above (`cilium status`, `cilium connectivity test`).
**GATE: do not apply node-2/3 until node-1 + connectivity test are green.**

## Step 3 — roll the remaining nodes
```fish
talosctl apply-config -n 100.89.87.126  --file clusterconfig/capstone-capstone-n2.yaml
talosctl apply-config -n 100.117.55.70  --file clusterconfig/capstone-capstone-n3.yaml
# Cilium DaemonSet schedules onto each as flannel/kube-proxy leave; watch:
kubectl -n kube-system rollout status ds/cilium --timeout=300s
cilium status ; cilium connectivity test
```
Clean up the now-orphaned flannel/kube-proxy if Talos leaves any (it removes flannel when
cni:none; kube-proxy DaemonSet is removed when proxy.disabled — verify none linger).

## Step 4 — the DENY-TEST (the security acceptance gate)
This is what flips "netpols inert" → "netpols ENFORCED" for the public cutover. After
PR #40's CIDRs are in and the runner netpol is synced (SEC-011-style watched sync):
```fish
# From an arc-runners job/test pod (the untrusted-code surface):
#  (a) MUST FAIL — apiserver via node IP and via Tailscale:
kubectl -n arc-runners run denytest --image=nicolaka/netshoot --restart=Never -it --rm -- \
  sh -c 'nc -zv -w3 10.237.171.8 6443 ; nc -zv -w3 100.117.55.70 6443 ; nc -zv -w3 <other-tenant-pod-ip> 80'
#       EXPECT: all three time out / refused (blocked).
#  (b) MUST SUCCEED — the allowed paths: DNS, the kubernetes Service ClusterIP, Harbor:
#      nslookup kubernetes.default ; nc -zv 10.96.0.1 443 ; nc -zv harbor-core.harbor 80
hubble observe --namespace arc-runners --verdict DROPPED   # SEE the blocks land
```
Security signs off on (a) all-blocked + (b) all-allowed → netpol enforcement PROVEN.

## Rollback
If node-1 validation fails: revert talconfig (`cni: flannel`, `proxy.disabled: false`),
`talhelper genconfig`, re-apply node-1 → flannel returns, cluster networking restored.
Only node-1 was touched (that's why it's first), so blast radius is one node.

## After this
- Re-param is done (PR #40). Netpols now ENFORCE.
- THEN the public cutover: B2 PLATFORM_DOMAIN flip (#37) + the tunnel (#36) + security re-sign.
- Follow-up: Cilium FQDN egress to tighten the runner's external :443 from 0.0.0.0/0 to
  GitHub's domains/CIDRs (CiliumNetworkPolicy `toFQDNs`) — a real upgrade over the current
  port-only scope.
