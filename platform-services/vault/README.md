# Vault (ADR-030 model B1) — the secrets store behind ESO

HashiCorp Vault, **Raft integrated storage** on a persistent **Ceph RBD PVC**, **TLS
on**. Deployed as the ArgoCD Application `platform-vault`
(`applicationsets/vault-app.yaml`, deploy method A — pinned `hashicorp/vault` chart
`0.33.0`, appVersion Vault `1.21.2`). This dir ships only the `vault` **namespace**
(the chart installs into it). It is the single store ESO reads from — **no secret
material is committed to git** (the whole point of B1).

> ⚠ **This file documents TWO decisions the human must make/confirm and the
> keyboard runbook to bring Vault live.** Agents cannot apply to the cluster.

---

## §A — ⚠ THE KEY OPERATIONAL DECISION: Vault unseal strategy

Vault boots **sealed** and **re-seals on every pod restart** (reboot, image bump,
node drain, OOM-kill). Until unsealed it serves nothing → ESO secret sync pauses.
There is **no cloud KMS on Talos**, so cloud auto-unseal (`awskms` / `gcpckms` /
`azurekeyvault`) is unavailable. The realistic options:

| Option | How | Maintenance | Security | Verdict |
| --- | --- | --- | --- | --- |
| **1. Manual unseal** | Human runs `vault operator unseal` (×3 of 5 key shares) after every restart | **HIGH** — hand-unseal after every reboot/upgrade/drain; a 3 AM node reboot leaves secrets down until someone types keys | Keys live only with the human (Shamir split) — **strongest** | Default ON now (zero infra), but **too much toil** for a low-maintenance homelab |
| **2. ⭐ Transit auto-unseal (RECOMMENDED)** | A tiny **second "unsealer" Vault** holds a Transit key; the main Vault auto-unseals against it on boot | **LOW** — main Vault self-unseals on every restart; you only unseal the *small* unsealer (or run IT manual since it restarts rarely) | The unseal key never touches the main Vault's disk; rotatable; audited | **Pick this** — turns Vault into a low-maintenance service, which is the user's stated goal |
| **3. Stored/auto-init keys** | Scripts stash the unseal keys in a k8s Secret + auto-unseal from it | LOW | **WEAK** — the unseal key sits next to the thing it unseals (defeats the seal); avoid | ❌ Not recommended |

### ⭐ CHOSEN: **Option 2 — Transit auto-unseal from a small in-cluster unsealer Vault.** (now WIRED)

It is the only option that is **both** low-maintenance **and** keeps the seal key
off the main Vault's disk. The unsealer is a single tiny Vault pod whose ONLY job is
to hold one Transit key; it restarts rarely, so even leaving the unsealer on manual
unseal is a once-in-a-blue-moon keyboard task. **This is now implemented** (Track-2
DR): the `seal "transit"` stanza is **active** in `vault-app.yaml`, the unsealer
ships as `applicationsets/vault-unsealer-app.yaml` (+ `platform-services/vault-unsealer/`),
and the one-time Shamir→Transit `-migrate` ceremony + key custody live in
**`artifacts/design/vault-dr-runbook.md`**. The migrate is a human keyboard step;
until you run it, do **not** sync the updated `vault-app.yaml` (see the ORDERING
warning in that file's header). If you instead want the absolute simplest footprint
and accept the manual toil for v1, revert the `seal "transit"` stanza to stay on
Option 1 — secure, just higher-touch.

> If the user decides the manual toil is acceptable for v1 and wants the absolute
> simplest footprint, **stay on Option 1** — it is secure, just higher-touch. This
> is the user's call; flagged here because it determines day-to-day operability.

---

## §B — Topology decision: single-node Raft vs 3-node HA

**Configured: single-node Raft (`ha.replicas: 1`).** Rationale + tradeoff:

- **Why single-node:** lowest operating burden — **one** pod to unseal after a
  restart, not three. Raft storage engine still gives real snapshots/restore. Data
  lives on a **replica-3 Ceph RBD PVC**, so a **node loss is survivable** (the pod
  reschedules and reattaches the RBD; the data is on Ceph, not node-local disk).
- **Tradeoff:** no Vault-**process** HA. If the single Vault pod is down, secret
  **sync** pauses — but **ESO keeps serving already-materialized k8s Secrets**, so
  **running apps are not impacted**; only new/refreshed secrets wait for Vault to
  come back. For a student-capstone platform this is an acceptable availability
  posture.
- **To go 3-node HA later:** set `ha.replicas: 3` in `vault-app.yaml`, re-sync, then
  unseal all three and `vault operator raft join` the two followers to `vault-0`
  (see the upstream HA-raft procedure). **No re-init / no data migration needed.**

---

## §C — Server TLS cert (built at init, NOT committed)

TLS is on; the listener reads `/vault/userconfig/vault-server-tls/{tls.crt,tls.key}`
from the **`vault-server-tls`** Secret. This Secret is **created by the human at
init** (a SAN-correct cert for the in-cluster Vault service names) and is **not in
git** (B1: no secret material in the repo). Generate with cert-manager (preferred —
a `Certificate` against the in-cluster issuer) or `openssl`. **Required SANs:**

```
vault, vault.vault, vault.vault.svc, vault.vault.svc.cluster.local,
vault-active, vault-active.vault.svc.cluster.local,
vault-internal, *.vault-internal, vault-0.vault-internal,
127.0.0.1   (the pod's own VAULT_ADDR=https://127.0.0.1:8200)
```

Recommended (cert-manager Certificate, kept out of git or applied imperatively):

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: vault-server-tls
  namespace: vault
spec:
  secretName: vault-server-tls
  duration: 8760h
  privateKey: { algorithm: ECDSA, size: 256 }
  commonName: vault.vault.svc.cluster.local
  dnsNames:
    - vault
    - vault.vault
    - vault.vault.svc
    - vault.vault.svc.cluster.local
    - vault-active.vault.svc.cluster.local
    - vault-0.vault-internal
    - "*.vault-internal"
  ipAddresses: ["127.0.0.1"]
  issuerRef: { name: <in-cluster-ca-issuer>, kind: ClusterIssuer }
```

ESO trusts this cert via the `caBundle` on the ClusterSecretStore
(`platform-services/external-secrets/README.md` §3 / `clustersecretstore.yaml`).

---

## §D — DEPLOY / INIT RUNBOOK (human keyboard steps)

> Order matters: namespace+chart sync first, then create the TLS Secret BEFORE the
> pod can go Ready (the listener needs the cert), then init+unseal, then enable k8s
> auth + the ESO policy/role. None of this can run from an agent (cluster writes are
> classifier-gated).

```bash
# 0) Merge this PR. Then re-assert the install-owned AppProject allowlist + sync:
make bootstrap-reapply          # adds charts.external-secrets.io + helm.releases.hashicorp.com
                                # to the platform AppProject sourceRepos (VERIFY it took)

# 1) Create the server-TLS Secret BEFORE Vault can become Ready (§C).
#    (cert-manager Certificate from §C, OR an openssl-generated kubectl create secret tls.)
kubectl -n vault get secret vault-server-tls    # confirm it exists

# 2) Let ArgoCD sync platform-vault (wave 0) — the StatefulSet comes up SEALED.
argocd app sync platform-vault
kubectl -n vault get pods                        # vault-0: Running 0/1 (sealed = not Ready, expected)

# 3) Initialize Vault (ONCE, from vault-0). SAVE THE OUTPUT SECURELY (offline,
#    e.g. a password manager) — the unseal keys + root token are shown ONLY here
#    and are unrecoverable if lost. Do NOT commit them.
kubectl -n vault exec -it vault-0 -- vault operator init -key-shares=5 -key-threshold=3

# 4) Unseal vault-0 (×3 distinct key shares). After this vault-0 goes Ready (1/1).
kubectl -n vault exec -it vault-0 -- vault operator unseal <KEY_SHARE_1>
kubectl -n vault exec -it vault-0 -- vault operator unseal <KEY_SHARE_2>
kubectl -n vault exec -it vault-0 -- vault operator unseal <KEY_SHARE_3>
#    (If ha.replicas were 3: repeat unseal on vault-1/vault-2 and `vault operator
#     raft join https://vault-0.vault-internal:8200` the followers.)

# 5) Log in with the root token to configure auth (subsequent steps).
kubectl -n vault exec -it vault-0 -- vault login <ROOT_TOKEN>

# 6) Enable the KV v2 engine ESO reads from + the Kubernetes auth method.
kubectl -n vault exec -it vault-0 -- vault secrets enable -path=secret -version=2 kv
kubectl -n vault exec -it vault-0 -- vault auth enable kubernetes
kubectl -n vault exec -it vault-0 -- sh -c \
  'vault write auth/kubernetes/config \
     kubernetes_host="https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT"'

# 7) Write the ESO read policy + bind it to the ESO ServiceAccount via a k8s auth
#    role. (Policy + role HCL/commands live in
#    platform-services/external-secrets/vault-policies/ — copy them in or run the
#    documented `vault policy write` / `vault write auth/kubernetes/role/...`.)
#    See platform-services/external-secrets/README.md §2.

# 8) Apply the ClusterSecretStore (+ per-tenant SecretStores as teams onboard).
#    See external-secrets/README.md §3.

# 9) Transit auto-unseal + Raft snapshots (Track-2 DR) — NOW IMPLEMENTED. The full
#    keyboard procedure (stand up the unsealer, enable transit, mint the scoped
#    auto-unseal token, seed the k8s Secrets, run the one-time `vault operator unseal
#    -migrate`, and configure the snapshot CronJob's policy/role) lives in:
#        artifacts/design/vault-dr-runbook.md   (§C bring-up, §D migrate, §E restore)
```

### Rollback / recovery

- **Lost unseal keys/root token before saving** → unrecoverable; `kubectl -n vault
  delete pvc data-vault-0` (⚠ destroys all stored secrets) and re-init. This is why
  step 3 says save them offline immediately.
- **Bad TLS cert (pod CrashLoop on listener)** → fix the `vault-server-tls` Secret
  SANs (§C), `kubectl -n vault delete pod vault-0` to restart.
- **Sync issues** → `platform-vault` is `automated{selfHeal}`; the StatefulSet +
  PVC are retained on delete (`persistentVolumeClaimRetentionPolicy: Retain`).

---

## Validation (this PR, no apply)

`helm template hashicorp/vault 0.33.0` with `vault-app.yaml`'s values renders the
StatefulSet (TLS listener, raft, Ceph PVCs) + PDB + Services cleanly; the netpols
(`hardening/netpol-controlplane/vault-netpol.yaml`) pass `kubeconform -strict`. See
the PR body for the captured output.
