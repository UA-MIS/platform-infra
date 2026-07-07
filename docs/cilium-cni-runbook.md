# Cilium CNI swap — runbook (Talos, NetworkPolicy enforcement)

**Status: ✅ COMPLETE / HISTORICAL (verified live 2026-07-04)** for Steps 1–4
(the CNI swap itself). **Step 5 (mutual-auth mTLS) is NEW in this PR — manifests
+ values are in git, NOT applied.** Cilium **v1.17.4** is
the live CNI on all nodes — VXLAN tunnel mode, `kubeProxyReplacement=true`,
`ipam=kubernetes`, `bpf.hostLegacyRouting=true`; **kube-proxy is absent** and
`cniConfig.name: none` is set in `talconfig.yaml`. NetworkPolicies are enforced. Keep
this runbook as the **reference** for how the swap was done and the design constraints
(re-run only if rebuilding the cluster or bumping Cilium). The "why" below is the
original motivation.

## Why (original motivation — flannel had no policy backend)

Talos ships **flannel**, which has **no NetworkPolicy backend** — every NetworkPolicy in
this repo was accepted by the API but **NOT enforced** (tenant isolation, the SEC-011
control-plane denies, the SEC-014 runner egress lockdown all provided ZERO real
protection). Going public via the Cloudflare Tunnel with inert netpols was the risk
security flagged. Replacing flannel with a **policy-enforcing CNI** was the prerequisite
for a safe public cutover — now done.

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
- Done: Step 5 below (service-mesh east-west mTLS via Cilium's built-in mutual auth).

## Step 5 — Mutual Authentication (mTLS) via SPIRE (service-mesh, additive)

**Status: manifests + values in git; NOT applied.** This turns on Cilium's
built-in, sidecarless service-mesh mutual-auth feature — SPIFFE/SPIRE-backed
workload identity, cryptographically proving "who is on the other end of this
connection" for east-west pod-to-pod traffic. It does **not** replace or
require Istio/Linkerd; Cilium *is* the mesh here (it already terminates every
packet as the CNI). Full concept/scope writeup, and what it covers vs the
Tailscale node-level encryption: **docs/service-mesh-mtls.md**.

This is an **overlay on the live Cilium install** (Step 2 above) — it does not
touch `kubeProxyReplacement`, `bpf.hostLegacyRouting`, or any other existing
value. Cilium remains INSTALL-OWNED (helm CLI, not an ArgoCD Application) for
the same chicken/egg reason as the original install, so the overlay lives as a
pinned, reviewable values file rather than a Helm-source Application:
`clusters/real-talos/cilium-mtls-values.yaml`.

```fish
set -x KUBECONFIG /home/ccsmith33/Projects/Capstone-Modernization/.wt-talos/clusters/real-talos/talos-kubeconfig
helm upgrade cilium cilium/cilium --version 1.17.4 --namespace kube-system \
  --reuse-values -f clusters/real-talos/cilium-mtls-values.yaml
kubectl -n kube-system rollout restart deployment/cilium-operator
kubectl -n kube-system rollout restart ds/cilium
```

This installs a bundled SPIRE server + per-node SPIRE agents (own `cilium-spire`
namespace, part of the same `cilium` Helm release) with the SPIRE server's
registration/trust-bundle data on a `ceph-block` PVC (replica-3, survives a node
loss — same convention as Vault/Harbor). It does **not** enforce anything by
itself: mutual auth is opt-in **per CiliumNetworkPolicy rule**
(`authentication.mode: "required"`) — flows with no such rule keep behaving
exactly as they do today. The two opt-in policies shipped in this PR:

- `hardening/service-mesh-mtls/mtls-vault-cnp.yaml` — requires mTLS for
  ESO / provider-vault / Backstage → Vault:8200 (Vault is TLS end-to-end
  already, so this is mutual-auth ONLY, no L7 — see the file header for why).
- `hardening/service-mesh-mtls/mtls-harbor-provider-cnp.yaml` — requires
  mTLS **and** restricts to the Harbor `/api/v2.0/projects*` +
  `/api/v2.0/robots*` paths for provider-harbor → harbor-core:8080 (this path
  is plaintext HTTP in-cluster, so Cilium's L7 proxy can actually parse it —
  see the file header for a known Cilium gotcha to verify before trusting the
  L7 narrowing).

**⚠ These do NOT live in `hardening/netpol-controlplane/` and are NOT synced
by `platform-netpol-controlplane`.** Cilium v1.17.4 (pinned) **fails CLOSED**
on `authentication.mode: required` — it DROPS the flow if the mTLS handshake
can't complete, it does not fall back to unauthenticated (fail-open on an
incomplete handshake only lands in Cilium 1.19+). `platform-netpol-
controlplane`'s manual sync is used for routine, SPIRE-independent netpol
changes; if these policies lived in that directory, a routine sync run before
SPIRE is live would immediately drop ESO/Backstage/provider-vault → Vault and
provider-harbor → Harbor traffic. So instead these two manifests live in
`hardening/service-mesh-mtls/` — a directory with **no ArgoCD Application
wired to it at all** — and are applied ONLY by a human, in this exact order:

```fish
# 1. SPIRE must already be installed and healthy (the helm upgrade above) with
#    a registered entry for every participating identity — verify FIRST:
kubectl -n cilium-spire get pods
kubectl exec -n cilium-spire spire-server-0 -c spire-server -- \
  /opt/spire/bin/spire-server entry show -selector cilium:mutual-auth

# 2. Only then apply the required-auth policies (never via ArgoCD sync):
kubectl apply -k hardening/service-mesh-mtls/
```

**Validate:**
```fish
# SPIRE is healthy + has registered identities for the participating workloads:
kubectl -n cilium-spire get pods
kubectl exec -n cilium-spire spire-server-0 -c spire-server -- \
  /opt/spire/bin/spire-server entry show -selector cilium:mutual-auth

# Cilium status shows mutual auth up:
cilium status   # look for the "Authentication" row

# A real ESO ExternalSecret still resolves (Vault path) and a real
# Project/RobotAccount reconcile still succeeds (Harbor path) — i.e. the
# REQUIRED auth handshake is succeeding for the legitimate peers, not just
# silently dropping them:
hubble observe --namespace vault --verdict DROPPED
hubble observe --namespace harbor --verdict DROPPED

# The Harbor L7 gotcha (see mtls-harbor-provider-cnp.yaml header) — confirm the
# HTTP proxy redirect actually exists for harbor-core, not shadowed by the
# pre-existing L3/L4-only allow in harbor-netpol.yaml:
kubectl -n kube-system exec ds/cilium -c cilium-agent -- cilium-dbg status --all-redirects
```

**Rollback:** if a legitimate control-plane path breaks (Vault access from
ESO/Backstage/provider-vault, or Harbor onboarding from provider-harbor) and
the fix isn't obvious quickly:
```fish
kubectl delete -k hardening/service-mesh-mtls/
# and/or fully disable the feature cluster-wide:
helm upgrade cilium cilium/cilium --version 1.17.4 --namespace kube-system \
  --reuse-values --set authentication.enabled=false
kubectl -n kube-system rollout restart deployment/cilium-operator
kubectl -n kube-system rollout restart ds/cilium
```
The `mtls-*-cnp.yaml` policies are additive on top of the existing L3/L4
allows (`vault-netpol.yaml`, `harbor-netpol.yaml`) — deleting them (or
disabling `authentication.enabled` entirely) returns those paths to exactly
their pre-mTLS behavior; no other traffic is affected.
