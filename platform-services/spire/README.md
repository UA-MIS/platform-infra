# SPIFFE/SPIRE workload identity — exploratory baseline

SPIRE issues short-lived **X.509-SVIDs** (SPIFFE Verifiable Identity Documents) to
Kubernetes workloads based on their **node** identity (k8s_psat attestation —
"which node am I actually running on") and **workload** identity (k8s workload
attestation — "which pod/namespace/service-account am I actually"), with no
long-lived credential ever touching the workload's filesystem. Deployed as two
ArgoCD Applications (deploy method A, pinned Helm charts from the SPIFFE
project's own "hardened" chart repo):

| Application | Chart | Sync wave | What |
| --- | --- | --- | --- |
| `platform-spire-crds` (`applicationsets/spire-crds-app.yaml`) | `spire-crds` 0.5.0 | -1 | `ClusterSPIFFEID` / `ClusterFederatedTrustDomain` / `ClusterStaticEntry` / `ControllerManagerConfig` CRDs |
| `platform-spire` (`applicationsets/spire-app.yaml`) | `spire` 0.29.0 (appVersion 1.14.5) | 0 | spire-server (StatefulSet) + spire-controller-manager + spire-agent (DaemonSet) + spiffe-csi-driver (DaemonSet) |

This dir (`platform-services/spire/`, Application `platform-svc-spire`) ships:
namespaces the two charts install into, plus a **self-contained demo** (one Job +
a `ClusterSPIFFEID`) proving a real pod gets a real SVID.

> This is an **exploratory baseline**, not a production identity plane. It is
> deliberately **isolated** — it does not touch Dex, Vault, or ESO. See
> "Integration path" below for how a human would wire it into either later.

---

## Topology

Two namespaces (the chart's own recommended production layout,
`global.spire.recommendations.enabled: true` in `spire-app.yaml`):

- **`spire-system`** (privileged PSS) — `spire-agent` DaemonSet (one pod per
  node, does k8s_psat node attestation + k8s workload attestation) and the
  `spiffe-csi-driver` DaemonSet (publishes the agent's Workload API unix socket
  into consuming pods as an ephemeral CSI volume — no hostPath needed on the
  workload side).
- **`spire-server`** (baseline PSS) — the `spire-server` StatefulSet (embedded
  SQLite datastore on a `ceph-block` PVC, same storage class as Vault/Harbor)
  and `spire-controller-manager` (the **Kubernetes Workload Registrar**: watches
  `ClusterSPIFFEID` custom resources cluster-wide and reconciles them into real
  SPIRE registration entries — no hand-run `spire-server entry create`).

A third namespace, **`spire-demo`** (restricted PSS), holds nothing but the demo
workload — deliberately separate from SPIRE's own namespaces to prove the
integration works for an ordinary tenant-shaped workload, not just SPIRE's own
pods.

Trust domain: `capstone.internal` (an internal SPIFFE identity namespace —
**not** `PLATFORM_DOMAIN`/Cloudflare's public DNS; SPIFFE trust domains are not
meant to be internet-resolvable). Cluster name: `real-talos`.

---

## Demo: one workload getting an SVID

`demo-clusterspiffeid.yaml` registers:

```yaml
namespaceSelector: {matchExpressions: [{key: kubernetes.io/metadata.name, operator: In, values: [spire-demo]}]}
podSelector:       {matchLabels: {app.kubernetes.io/name: spire-demo-client}}
```

which mints (the chart's default `spiffeIDTemplate`, `ns/<namespace>/sa/<service-account>`):

```
spiffe://capstone.internal/ns/spire-demo/sa/spire-demo-client
```

`demo-workload.yaml` runs a one-shot `Job` (`spire-demo-client`, ns `spire-demo`)
whose container is the `spire-agent` image itself (it doubles as the Workload
API's CLI client) with its entrypoint overridden to:

```
spire-agent api fetch x509 -socketPath /spiffe-workload-api/spire-agent.sock -timeout 10s
```

reading the socket off the ephemeral `csi.spiffe.io` volume (no privilege, no
hostPath — `runAsNonRoot`, all capabilities dropped, `readOnlyRootFilesystem`).

**Verify after ArgoCD syncs both Applications + this dir:**

```bash
kubectl -n spire-demo wait --for=condition=complete job/spire-demo-client --timeout=120s
kubectl -n spire-demo logs job/spire-demo-client
```

Expected: an `X509-SVID` block whose `SPIFFE ID` line reads
`spiffe://capstone.internal/ns/spire-demo/sa/spire-demo-client`, plus its
certificate chain and the trust bundle. That is a workload — with **zero
credentials baked into its image or mounted as a k8s Secret** — proving its
identity and getting back a short-lived (default 1h) cert purely from *which
pod it is*.

To confirm the registration entry SPIRE actually holds (from the server pod):

```bash
kubectl -n spire-server exec deploy/spire-server -c spire-server -- \
  /opt/spire/bin/spire-server entry show -spiffeID spiffe://capstone.internal/ns/spire-demo/sa/spire-demo-client
```

---

## Integration path (not implemented in this change — documented per task scope)

Two realistic next steps once this baseline is proven live; **neither is wired
up here** (keeps this change's blast radius to "SPIRE exists and can mint
SVIDs" and does not touch Dex/Vault/ESO):

### Option 1 — Back Vault's `jwt`/`oidc` auth method with SPIRE-issued JWT-SVIDs

Enable `spiffe-oidc-discovery-provider` (currently `enabled: false` in
`spire-app.yaml` — the subchart is present in the umbrella chart, just switched
off). It exposes a standard OIDC discovery document
(`/.well-known/openid-configuration` + JWKS) backed by SPIRE's own signing keys.
Vault's `auth/jwt` method can then trust that discovery URL as an OIDC provider
and issue Vault tokens to workloads that present a SPIRE-minted JWT-SVID — i.e.
workloads authenticate to Vault by **being who SPIRE says they are**, with no
Kubernetes ServiceAccount token or AppRole secret involved at all. This would
sit **alongside** the current ESO/Vault K8s-auth path (`capstone-eso-vault-secrets-contract`
memory), not replace it, until proven out. Needs: an Ingress/Service exposure
decision for the discovery endpoint (in-cluster only is sufficient — Vault is
in-cluster too), and a new Vault auth mount + role, both out of scope here.

### Option 2 — Cilium mutual TLS sourced from the SPIFFE Workload API

Cilium's mTLS feature (envoy-based, SDS) can source workload certificates from
any SPIFFE Workload API-compliant provider instead of cert-manager — i.e. this
SPIRE deployment could become the certificate source for pod-to-pod mTLS
enforced by Cilium network policies, giving cryptographic (not just
label-selector) workload identity at the network layer. This is a bigger lift
(Cilium config changes, a live production CNI already handling
[SEC-011](../../artifacts) enforcement) and is flagged here only as the
documented path, not attempted.

---

## Isolation notes

- No changes to `platform-services/dex/`, `platform-services/vault/`, or
  `platform-services/external-secrets/` in this change.
- No new Vault auth methods, ESO `ClusterSecretStore`s, or Dex OIDC clients.
- `spiffe-oidc-discovery-provider` (the one component that *could* bridge into
  Vault) is explicitly disabled.
- Separate trust domain (`capstone.internal`) and separate chart repo
  (`https://spiffe.github.io/helm-charts-hardened/`) from every existing
  Helm-source Application — zero shared state with the rest of the platform
  beyond the shared `ceph-block` StorageClass and the Cilium CNI/network
  policies that already govern every namespace on this cluster.
