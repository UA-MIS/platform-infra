# Service mesh: Cilium mutual authentication (east-west mTLS)

**Status:** manifests + Helm values overlay in git (this PR), **not yet applied**.
Enforcement is a deliberate, watched rollout — see
[`cilium-cni-runbook.md` Step 5](cilium-cni-runbook.md#step-5--mutual-authentication-mtls-via-spire-service-mesh-additive)
for the exact commands, validation, and rollback.

## What this is

Cilium — already the cluster's CNI — has a built-in, **sidecarless** service
mesh feature: mutual authentication backed by SPIFFE/SPIRE workload identity,
plus its existing L3–L7 `CiliumNetworkPolicy` engine. This is deliberately
**not** Istio or Linkerd: there is no sidecar proxy injected into every pod, no
second control plane, no extra per-pod resource overhead. Cilium's eBPF
datapath (already in every pod's path as the CNI) is extended with:

- **Mutual authentication** — a SPIRE server (bundled in the same Cilium Helm
  release, its own `cilium-spire` namespace) issues short-lived SPIFFE X.509
  SVIDs to Cilium agents. Any `CiliumNetworkPolicy` rule can add
  `authentication: {mode: "required"}` to demand a real mTLS handshake, proving
  the *identity* of both ends of a connection, before Cilium allows the flow —
  on top of (not instead of) the existing label/namespace-based policy match.
- **L7 (HTTP) policy** — for plaintext-HTTP internal traffic, Cilium's
  Envoy-based proxy can additionally restrict to specific HTTP methods/paths
  (`toPorts.rules.http`), not just IP:port.

Both are **opt-in per policy rule** — nothing in the cluster is required to
authenticate or gets L7-filtered unless a specific `CiliumNetworkPolicy` asks
for it. This PR turns the feature on cluster-wide (SPIRE install) but only
*exercises* it for two service-to-service paths (below); every other flow in
the cluster is completely unchanged.

## What's shipped in this PR

| Path | Mutual auth (mTLS) | L7 HTTP scoping | File |
|---|---|---|---|
| ESO / provider-vault / Backstage → Vault:8200 | ✅ required | — (Vault is TLS end-to-end already; Cilium's L7 proxy can't see inside it without a separate TLS-interception project) | `hardening/netpol-controlplane/mtls-vault-cnp.yaml` |
| provider-harbor → harbor-core:8080 | ✅ required | ✅ `/api/v2.0/projects*` + `/api/v2.0/robots*` only (GET/POST/PUT/DELETE) | `hardening/netpol-controlplane/mtls-harbor-provider-cnp.yaml` |

Both are **additive**: they sit alongside the existing L3/L4 allows
(`vault-netpol.yaml`, `harbor-netpol.yaml`, `vault-cnp.yaml`) and only add a
*requirement* on top of what was already allowed — nothing that worked before
stops working, and nothing new is granted access. See each file's header for
the full justification, and the Harbor file's header for a documented Cilium
gotcha (a co-existing L3/L4-only allow for the same identity+port can shadow
L7 proxy redirection) that must be verified at rollout, not just assumed.

These two were chosen as the highest-value, lowest-risk starting points: Vault
is the secrets store (the single highest-value east-west spoofing target), and
Harbor's provider-onboarding path is the one plaintext-HTTP control-plane
traffic where L7 scoping is actually possible. Extending the same pattern to
more platform pairs (ArgoCD↔Dex, ESO↔apiserver, etc.) is straightforward
follow-up once this is proven live — each is a small, independent
`CiliumNetworkPolicy` addition, same shape as the two here.

## What it covers vs. the Tailscale node-level encryption

This cluster is **Tailscale-everywhere** (see `cilium-cni-runbook.md`'s
"THE REAL DANGER" section) — node-to-node and node-to-apiserver traffic rides
the Tailscale WireGuard overlay. It is easy to assume that already means
"east-west traffic is encrypted." It doesn't cover what this PR covers. The
two operate at different layers and protect against different attackers:

| | Tailscale overlay (existing) | Cilium mutual auth (this PR) |
|---|---|---|
| **Layer** | Node-to-node network tunnel (WireGuard, L3) | Pod-to-pod application identity (SPIFFE/mTLS, L3.5–L7) |
| **What's encrypted/authenticated** | The link between two **nodes** (e.g. control-plane box 1 ↔ box 2, or a node ↔ the Tailscale-routed apiserver) | The connection between two **workload identities** (e.g. "the real ESO controller" ↔ "the real Vault pod") |
| **On-node pod-to-pod traffic** | **NOT covered.** Two pods scheduled on the *same* node never touch the Tailscale interface — that traffic goes pod-veth → node's Linux/eBPF stack → pod-veth, entirely inside one host. Tailscale has nothing to say about it. | **Covered.** SPIRE identity + mTLS is enforced between the two pods' Cilium endpoints regardless of which node(s) they're on — same-node traffic gets the *same* authentication guarantee as cross-node traffic. |
| **Cross-node pod-to-pod traffic** | Encrypted incidentally (the VXLAN-over-Tailscale packet is inside the WireGuard tunnel) — but that only proves "this packet came from the right *node*," not "this packet came from the right *pod/workload* on that node." A compromised pod sharing a node with Vault's client still rides the same trusted tunnel. | Proves the specific **workload's** identity (a SPIFFE ID tied to the pod's Cilium security identity / service account, not just its node), independent of which node either end is on. |
| **What an attacker needs to defeat it** | Tailscale: compromise/join the tailnet, or compromise a node already in it. | Cilium mutual auth: possess a valid SPIRE-issued SVID for the *specific* claimed identity — i.e. actually be (or fully compromise) that specific workload, not just co-locate on the same node or namespace. |
| **Failure mode if bypassed** | Node traffic is unencrypted/unauthenticated at the network layer (the KubeSpan/Tailscale outage class already documented in the CNI runbook). | A required-auth flow is DROPPED (fails closed) if the handshake can't complete — see the runbook's rollback note. |

**The value-add in one sentence:** Tailscale answers "is this traffic between
two nodes I trust," Cilium mutual auth answers "is this traffic between the
two *specific workloads* it claims to be" — and it is the ONLY control in this
platform that gives that guarantee for pods that happen to share a node,
which Tailscale structurally cannot do (that traffic never reaches its
interface).

## What this does NOT do

- **Not a blanket cluster-wide mTLS requirement.** Only the two policies above
  require authentication; every other pod-to-pod flow is unauthenticated at
  this layer (same as before this PR), scoped only by the existing L3/L4/L7
  `NetworkPolicy`/`CiliumNetworkPolicy` allows.
- **Not encryption-at-rest for the wire.** Cilium mutual auth authenticates the
  peers before allowing a connection; it does not itself provide transparent
  wire encryption for plaintext HTTP traffic between two pods that lack it
  today (Cilium has a *separate* opt-in feature, `encryption.type: wireguard`
  or IPsec, for transparent pod-to-pod encryption — not enabled here, and a
  distinct decision from mutual auth; flagged as a candidate follow-up, not
  in scope for this PR).
- **Not a replacement for Vault's own TLS** or Harbor's OIDC/RBAC — this is a
  network-identity layer underneath those, not a substitute.
- **Not yet enforced.** See the runbook: manual-sync, watched rollout, same
  SEC-011 discipline as every other control-plane netpol change in this repo.

## Follow-ups (not in this PR)

- Extend `authentication.mode: required` to more platform pairs (ArgoCD↔Dex
  OIDC calls, ESO↔apiserver, provider-vault↔apiserver) once this rollout is
  validated live.
- Resolve the Harbor L7 "shadowed by L3/L4 allow" gotcha permanently by
  narrowing `harbor-netpol.yaml`'s crossplane-system rule (a deliberate,
  separate change to a live, manual-sync netpol — intentionally not bundled
  into this additive PR).
- Consider Cilium's transparent WireGuard/IPsec pod-to-pod encryption
  (`encryption.type`) as a distinct follow-up if wire-level confidentiality
  for on-node traffic (not just identity) becomes a requirement.
