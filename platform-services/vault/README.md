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

**Configured: 3-node Raft HA (`ha.replicas: 3`), upgraded from the original
single-node topology.** Rationale + tradeoff:

- **Why 3-node now:** single-node Raft had no Vault-**process** HA — if the one
  pod went down, secret **sync** paused platform-wide until it rescheduled. With
  3-node Raft, the cluster tolerates **one node/pod loss** with **zero**
  interruption to secret sync — an active leader is always reachable via the
  `vault-active` Service. Each replica keeps its own **replica-3 Ceph RBD PVC**
  (unchanged from single-node), so a node loss is doubly survivable: Raft quorum
  on the other two nodes, and the PVC reattaches if/when the pod reschedules.
- **Hard pod anti-affinity** (`server.affinity` in `vault-app.yaml`) pins one
  Vault server pod per node — required so a single node loss can never take out
  2-of-3 pods (which would cost the cluster quorum). There are exactly 3
  control-plane OptiPlex nodes and 3 replicas, so this is a clean 1:1 mapping.
- **Tradeoff vs single-node:** 3x the pods/PVCs, and a one-time
  `vault operator raft join` per new follower during the rollout (see §G below).
  Ongoing unseal toil is **unchanged** — transit auto-unseal (decision A) still
  means no manual Shamir typing on *any* of the 3 main-Vault pods; only the small
  unsealer Vault stays single-node/manual-unseal (see §A).
- **No re-init / no data migration needed** for the 1→3 scale-up: `vault-0` keeps
  its existing Raft data; `vault-1`/`vault-2` join it empty and replicate.

### §G — ⚠ HA ROLLOUT RUNBOOK (human keyboard steps, 1 → 3 replicas)

> Prereq: decision A (transit auto-unseal) must already be live and proven on the
> single node — do **not** combine the Shamir→Transit migration and this HA
> scale-up in the same sync (see the ORDERING warning in `vault-app.yaml`'s
> header). The full write-up + failure cheatsheet lives in
> `artifacts/design/vault-dr-runbook.md` §G.

```bash
# 1) Sync the updated platform-vault Application (ha.replicas: 1 -> 3). ArgoCD
#    scales the StatefulSet; vault-1 and vault-2 come up immediately (Parallel
#    podManagementPolicy) as NEW, empty, sealed Raft nodes — vault-0 is untouched.
argocd app sync platform-vault
kubectl -n vault get pods -w
#    vault-0: Running 1/1 (already unsealed, untouched)
#    vault-1, vault-2: Running 0/1 (sealed, not yet raft members — expected)

# 2) Join vault-1, THEN vault-2 (order matters only in that each join is a
#    separate operator-run command; both target the existing leader vault-0 via
#    its stable per-pod DNS on the headless vault-internal Service).
kubectl -n vault exec -it vault-1 -- vault operator raft join \
    https://vault-0.vault-internal:8200
kubectl -n vault exec -it vault-2 -- vault operator raft join \
    https://vault-0.vault-internal:8200

# 3) Unseal each follower — because transit auto-unseal is already active
#    cluster-wide (the seal "transit" stanza + VAULT_TOKEN env apply to every
#    pod in the StatefulSet, not just vault-0), each follower AUTO-unseals within
#    seconds of joining. There is NO Shamir key-share typing here (that only
#    applies to the small unsealer Vault, which stays manual — decision A).
#    Just watch for Ready:
kubectl -n vault get pods -w
#    vault-1, vault-2 -> Running 1/1 within ~10-30s of the join command.
#    If a pod stays 0/1 for minutes, see the failure cheatsheet (§G below /
#    vault-dr-runbook.md §G) — do NOT assume it needs a manual `vault operator
#    unseal`; that command only accepts Shamir shares and this cluster has none.

# 4) Verify full quorum — all 3 as voters, one leader.
kubectl -n vault exec -it vault-0 -- vault operator raft list-peers
#    Expect 3 rows, Voter=true for all three, exactly one has state "leader".
kubectl -n vault exec -it vault-0 -- vault status
#    HA Enabled: true, Sealed: false on all 3 (run per-pod to confirm each).

# 5) Confirm the active/standby Services picked up the new topology.
kubectl -n vault get endpoints vault-active vault-standby
#    vault-active: 1 endpoint (the leader). vault-standby: 2 endpoints.

# 6) Optional but recommended: kill the current leader pod and confirm a standby
#    is promoted and `vault-active` re-points to it automatically (proves the
#    HA failover path end-to-end before you rely on it).
kubectl -n vault exec -it vault-0 -- vault operator raft list-peers   # note current leader
kubectl -n vault delete pod <current-leader-pod>
kubectl -n vault get pods -w                                          # it restarts, auto-unseals, rejoins
kubectl -n vault exec -it vault-1 -- vault operator raft list-peers   # confirm a new leader was elected
```

**Rollback:** scaling back down (`ha.replicas: 3 -> 1`) is NOT a supported
downgrade path for a live Raft cluster — removing voters without first running
`vault operator raft remove-peer` can strand the cluster below quorum. If you
need to revert, remove the two extra peers via `remove-peer` first, then scale
down; do not just edit `ha.replicas` back down under load.

---

## §C — Server TLS cert (built at init, NOT committed)

TLS is on; the listener reads `/vault/userconfig/vault-server-tls/{tls.crt,tls.key}`
from the **`vault-server-tls`** Secret. **The same Secret is mounted into all 3
server pods** (one Certificate/cert, shared — not per-pod), so its SAN list must
cover every pod's raft-peer hostname, not just `vault-0`. This Secret is **created
by the human at init** (a SAN-correct cert for the in-cluster Vault service names)
and is **not in git** (B1: no secret material in the repo). Generate with
cert-manager (preferred — a `Certificate` against the in-cluster issuer) or
`openssl`. **Required SANs:**

```
vault, vault.vault, vault.vault.svc, vault.vault.svc.cluster.local,
vault-active, vault-active.vault.svc.cluster.local,
vault-standby, vault-standby.vault.svc.cluster.local,
vault-internal, *.vault-internal,
vault-0.vault-internal, vault-1.vault-internal, vault-2.vault-internal,
127.0.0.1   (each pod's own VAULT_ADDR=https://127.0.0.1:8200)
```

(`*.vault-internal` alone technically covers all three pod hostnames — the
explicit `vault-N.vault-internal` entries are listed for clarity/verifiability
when reviewing an issued cert, not because the wildcard is insufficient.)

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
    - vault-standby.vault.svc.cluster.local
    - vault-0.vault-internal
    - vault-1.vault-internal
    - vault-2.vault-internal
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
#    ha.replicas is 3 here: vault-1/vault-2 come up sealed + NOT yet raft members.
#    They are brought in AFTER this initial Shamir bring-up + the transit
#    auto-unseal migration (§9 below) — see §G in this file for the join order
#    (`vault operator raft join` + auto-unseal, no Shamir typing on followers).

# 5) Log in with the root token to configure auth (subsequent steps).
kubectl -n vault exec -it vault-0 -- vault login <ROOT_TOKEN>

# 6) Enable the KV v2 engine ESO reads from + the Kubernetes auth method.
#    -max-versions=10: cap retained versions PER SECRET at the mount level so KV
#    version churn (every ESO PushSecret reconcile writes a new version) can't
#    accumulate unbounded and bloat the raft FSM. Applies to every existing and
#    future secret with no per-secret metadata override. See the FSM-hygiene
#    runbook (§ Storage hygiene below) for capping/pruning an ALREADY-bloated mount.
kubectl -n vault exec -it vault-0 -- vault secrets enable -path=secret -version=2 -max-versions=10 kv
#    (On an already-running install where the mount predates this flag, tune it in
#    place instead — root only: `vault secrets tune -max-versions=10 secret/`.)
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

# 10) 3-node HA rollout (decision B, THIS PR) — join vault-1/vault-2 into the raft
#     cluster and confirm quorum. Do this AFTER step 9 (transit auto-unseal must
#     already be proven on the single node first). Full procedure: §G above /
#     artifacts/design/vault-dr-runbook.md §G.
```

### Rollback / recovery

- **Lost unseal keys/root token before saving** → unrecoverable; `kubectl -n vault
  delete pvc data-vault-0` (⚠ destroys all stored secrets) and re-init. This is why
  step 3 says save them offline immediately.
- **Bad TLS cert (pod CrashLoop on listener)** → fix the `vault-server-tls` Secret
  SANs (§C), `kubectl -n vault delete pod vault-0` (or vault-1/vault-2) to restart.
- **Sync issues** → `platform-vault` is `automated{selfHeal}`; the StatefulSet +
  PVCs are retained on delete (`persistentVolumeClaimRetentionPolicy: Retain`).
- **HA scale-down** → not a supported live operation; see §G's Rollback note
  (`vault operator raft remove-peer` before reducing `ha.replicas`).

### Storage hygiene (raft FSM bloat)

The raft FSM (`/vault/data/vault.db`, a BoltDB file) grows to a high-water mark and
**never shrinks on its own** — deleting KV versions / tidying tokens frees pages
*inside* the file for reuse but does not return them to the OS. Two levers keep it
bounded:

1. **Cap KV versions** — `-max-versions=10` on the `secret/` mount (step 6 above, or
   `vault secrets tune` in place). Root-only; capping is permanent + automatic.
2. **Tidy expired tokens/leases** — the ~24 ESO ExternalSecrets/PushSecrets each
   re-login via k8s-auth (`token_ttl=1h`) and Upjet provider-vault mints a child
   token per API call, so token/lease storage entries dominate FSM churn far more
   than KV versions do. `vault token tidy` / `vault lease tidy` (root-only) reclaim
   them internally; a snapshot save+restore rewrites a compacted `vault.db` to
   actually reclaim disk.

Full diagnosis + exact operator commands (root token required for the tune/tidy/
prune steps): **`artifacts/design/vault-storage-hygiene-runbook.md`**.

---

## Validation (this PR, no apply)

`helm template hashicorp/vault 0.33.0` with `vault-app.yaml`'s values (now
`ha.replicas: 3` + explicit `server.affinity` + `server.service.active/standby`)
renders cleanly: 1 StatefulSet (3 replicas, `OnDelete` update strategy, hard
`podAntiAffinity` on `kubernetes.io/hostname`, 2 volumeClaimTemplates per pod), 1
PDB (`maxUnavailable: 1`), and 5 Services (`vault`, `vault-active`,
`vault-standby`, `vault-internal` headless, `vault-ui`) — `kubeconform -strict`
passes all 13 rendered resources. The netpols
(`hardening/netpol-controlplane/vault-netpol.yaml`,`vault-cnp.yaml`) also pass
`kubeconform -strict`. See the PR body for the captured output.
