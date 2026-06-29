# Vault Auto-Unseal + Disaster-Recovery Runbook (Track-2, ADR-030 B1)

**Audience:** the platform operator (human keyboard). Every step here is a cluster
write or a secret-handling action — **agents cannot run these** (classifier-gated).

**What this delivers (retro #5 — "Vault is single-node, manual-unseal, no DR"):**

1. **Transit auto-unseal** — the main Vault (`platform-vault`, `vault` ns) self-
   unseals on every restart against a tiny second **unsealer Vault**
   (`platform-vault-unsealer`, `vault-unsealer` ns). No more hand-typing 3 Shamir
   shares after every reboot/upgrade/OOM.
2. **Raft snapshots** — a daily CronJob (`vault-raft-snapshot`, `vault` ns) writes
   `vault operator raft snapshot save` to a Ceph PVC, retaining the newest 14.
3. **This runbook** — key custody, the one-time Shamir→Transit `-migrate` ceremony,
   and the restore-from-snapshot procedure.

> **3-node HA is explicitly OUT of scope** (anti-gold-plate). Single-node Vault +
> auto-unseal + snapshots only.

GitOps surfaces (PR — **do NOT merge/sync until §C is done**, see §D ⚠ ORDERING):
- `applicationsets/vault-unsealer-app.yaml` — the unsealer Vault (Helm app)
- `platform-services/vault-unsealer/` — the `vault-unsealer` namespace
- `applicationsets/vault-app.yaml` — main Vault, now with the active `seal "transit"`
- `platform-services/vault/raft-snapshot.yaml` — the snapshot CronJob/PVC/SA
- `hardening/netpol-controlplane/vault-unsealer-netpol.yaml` (+ `vault-netpol.yaml`
  now wired) — default-deny + scoped-allow for both Vault namespaces

---

## §A — Architecture & the trade-off

```
  ┌────────────────────────┐  seal "transit" (TLS, token-auth)   ┌──────────────────────┐
  │  platform-vault         │ ──── encrypt/decrypt root key ────▶ │ platform-vault-unsealer │
  │  (vault ns)             │   on every unseal                   │ (vault-unsealer ns)     │
  │  Raft on Ceph, the ESO  │                                     │ standalone, file/Ceph   │
  │  secret store           │                                     │ holds ONE transit key   │
  │  AUTO-unseals           │                                     │ MANUAL-unseal (rare)    │
  └────────────────────────┘                                     └──────────────────────┘
```

- **Why a second Vault?** It is the only auto-unseal option that is *both* low-
  maintenance *and* keeps the seal key **off the main Vault's own disk** (storing
  unseal keys in a k8s Secret next to the data defeats the seal). There is no cloud
  KMS on Talos, so `awskms`/`gcpckms`/`azurekeyvault` are unavailable.
- **The trade-off (accepted):** the unsealer is extra infra and **itself** stays on
  manual Shamir unseal — bootstrapping *it* with a third Vault is infinite regress.
  But the unsealer holds one key, carries no app load, and **restarts rarely**, so
  hand-unsealing it is a once-in-a-blue-moon task — versus hand-unsealing the busy
  main Vault on *every* restart. Net: the platform's day-to-day unseal toil → ~0.
- **Availability:** if the **unsealer** is down, the main Vault cannot *unseal* (so a
  main-Vault restart during an unsealer outage waits) — but an already-unsealed main
  Vault keeps serving, and ESO keeps serving already-materialized k8s Secrets. Bring
  the unsealer back (§C step 2) and the main Vault auto-unseals on its next restart.

---

## §B — Secrets you will create (NONE are committed to git — B1)

| Secret / material | Where | Purpose |
| --- | --- | --- |
| Unsealer Shamir keys + root token | **offline** (password manager / sealed env) | unseal + admin the unsealer |
| Main Vault recovery keys + root token | **offline** | post-migration the main Vault issues *recovery* keys (not unseal keys); needed for `operator` ops (rekey, generate-root) |
| `vault-unsealer-server-tls` (`tls.crt`,`tls.key`,`ca.crt`) | `vault-unsealer` ns Secret | the unsealer's listener cert — **issued automatically by cert-manager** from the committed `platform-services/vault-unsealer/certificate.yaml` (not hand-created) |
| `vault-unsealer-ca` (`ca.crt`) | `vault` ns Secret | lets the main Vault verify the unsealer's TLS (`seal.tls_ca_cert`) |
| `vault-transit-unseal-token` (`token`) | `vault` ns Secret | the auto-unseal token (→ `VAULT_TOKEN` in the main Vault) |
| `vault-server-tls` (`tls.crt`,`tls.key`,`ca.crt`) | `vault` ns Secret | main Vault listener cert (already in vault/README.md §C) — **must include `ca.crt`** so the snapshot CronJob can verify TLS |

**Unsealer cert SANs** — these are now baked into the committed
`platform-services/vault-unsealer/certificate.yaml` (cert-manager Certificate, same
pattern as vault/README.md §C); listed here for reference:

```
vault-unsealer, vault-unsealer.vault-unsealer, vault-unsealer.vault-unsealer.svc,
vault-unsealer.vault-unsealer.svc.cluster.local,
vault-unsealer-internal, *.vault-unsealer-internal,
127.0.0.1
```

If you issue both Vault certs from the **same in-cluster CA ClusterIssuer**, the
`ca.crt` is identical — `vault-unsealer-ca` and `vault-server-tls/ca.crt` carry the
same bytes. (cert-manager populates `ca.crt` automatically for CA issuers.)

---

## §C — Bring up the unsealer & seed the auto-unseal token

> Do this **first**, while the main Vault is still on manual Shamir unseal and the
> `seal "transit"` change from `vault-app.yaml` has **NOT** yet reached the cluster.

```bash
# 1) The unsealer's server-TLS Secret is issued AUTOMATICALLY by cert-manager from
#    platform-services/vault-unsealer/certificate.yaml (committed — a Certificate CR, no
#    secret material; same platform-ca-issuer as the main Vault, so ca.crt matches). No
#    manual/out-of-band step. Just confirm cert-manager has materialized the Secret
#    BEFORE the pod tries to mount it (else FailedMount until it appears):
kubectl -n vault-unsealer get certificate vault-unsealer-server-tls   # READY=True
kubectl -n vault-unsealer get secret vault-unsealer-server-tls        # confirm it exists

# 2) Sync the unsealer app (wave -1) and bring it online (ONE-TIME init + unseal).
argocd app sync platform-vault-unsealer
kubectl -n vault-unsealer get pods                  # vault-unsealer-0: Running 0/1 (sealed, expected)
kubectl -n vault-unsealer exec -it vault-unsealer-0 -- vault operator init \
        -key-shares=5 -key-threshold=3              # SAVE OUTPUT OFFLINE (§B)
kubectl -n vault-unsealer exec -it vault-unsealer-0 -- vault operator unseal <SHARE_1>
kubectl -n vault-unsealer exec -it vault-unsealer-0 -- vault operator unseal <SHARE_2>
kubectl -n vault-unsealer exec -it vault-unsealer-0 -- vault operator unseal <SHARE_3>

# 3) Enable transit + create the auto-unseal key (login with the unsealer root token).
kubectl -n vault-unsealer exec -it vault-unsealer-0 -- sh -ec '
  vault login <UNSEALER_ROOT_TOKEN>
  vault secrets enable transit
  vault write -f transit/keys/autounseal'

# 4) Mint a SCOPED auto-unseal token (policy = encrypt/decrypt the autounseal key ONLY).
kubectl -n vault-unsealer exec -i vault-unsealer-0 -- sh -ec '
  vault policy write autounseal - <<EOF
# NB: BOTH "create" and "update" are required (Vault 1.21.2). transit/encrypt evaluates
# as a CREATE op, so a plain ["update"] policy returns 403 at unseal time (proven live).
path "transit/encrypt/autounseal" { capabilities = ["create", "update"] }
path "transit/decrypt/autounseal" { capabilities = ["create", "update"] }
EOF
  # periodic token so it auto-renews (the main Vault renews it: disable_renewal=false)
  vault token create -policy=autounseal -period=24h -orphan -field=token'
#   ^ copy this token value -> use as <AUTO_UNSEAL_TOKEN> below.

# 5) Seed the two k8s Secrets the MAIN Vault needs (vault ns). NOT committed to git.
kubectl -n vault create secret generic vault-transit-unseal-token \
        --from-literal=token='<AUTO_UNSEAL_TOKEN>'
kubectl -n vault create secret generic vault-unsealer-ca \
        --from-file=ca.crt=<path-to-the-unsealer-CA.crt>
```

---

## §D — Migrate the main Vault: Shamir → Transit (one-time ceremony)

> ⚠ **ORDERING:** §C must be fully done (unsealer live, both `vault` ns Secrets
> seeded) **before** the `seal "transit"` change reaches the cluster. If the main
> Vault pod restarts into the new config without `vault-transit-unseal-token`, it
> cannot start (missing `VAULT_TOKEN` env). The merge/sync of `vault-app.yaml` is
> what triggers the restart — control that timing.

```bash
# 1) Merge the PR, then re-assert the install-owned AppProject allowlist (no new repo
#    added — helm.releases.hashicorp.com is already allowed — but keep the habit) and
#    let ArgoCD apply the updated main-Vault config. The pod restarts; with a transit
#    seal configured but Shamir-sealed data, it comes up awaiting the migrate.
argocd app sync platform-vault
kubectl -n vault get pods            # vault-0 Running 0/1 (sealed, awaiting -migrate)

# 2) ONE-TIME seal migration — supply the OLD Shamir shares with -migrate:
kubectl -n vault exec -it vault-0 -- vault operator unseal -migrate <SHAMIR_SHARE_1>
kubectl -n vault exec -it vault-0 -- vault operator unseal -migrate <SHAMIR_SHARE_2>
kubectl -n vault exec -it vault-0 -- vault operator unseal -migrate <SHAMIR_SHARE_3>
#    Vault detects the seal change, decrypts with Shamir, re-encrypts the root key
#    with Transit, and unseals. From now on it AUTO-unseals on every restart.

# 3) Verify auto-unseal end-to-end: delete the pod and confirm it returns Ready
#    WITHOUT any manual unseal.
kubectl -n vault delete pod vault-0
kubectl -n vault get pods -w        # vault-0 should reach 1/1 on its own
kubectl -n vault exec -it vault-0 -- vault status   # Sealed=false, Seal Type=transit

# 4) NOTE: after migration the main Vault issues RECOVERY keys (not unseal keys).
#    Re-key/save them offline:  vault operator rekey -target=recovery ...

# 5) ESO RECOVERY: after the -migrate, External-Secrets will show
#    `InvalidProviderConfig` on the ClusterSecretStore — this is STALE validation cached
#    from while the main Vault was sealed during the migration, NOT a real config error.
#    The main Vault is now unsealed; force ESO to re-validate by restarting it:
kubectl -n external-secrets rollout restart deploy external-secrets
kubectl -n external-secrets get clustersecretstore   # STATUS Valid once it reconnects
```

### Snapshot CronJob auth (Vault-side policy + k8s role — one-time)

The `vault-raft-snapshot` CronJob authenticates via the Kubernetes auth method as SA
`vault-snapshot` (vault ns). Create its policy + role once (k8s auth is already
enabled per vault/README.md §D step 6):

```bash
kubectl -n vault exec -i vault-0 -- sh -ec '
  vault policy write snapshot - <<EOF
path "sys/storage/raft/snapshot" { capabilities = ["read"] }
EOF
  vault write auth/kubernetes/role/snapshot \
      bound_service_account_names=vault-snapshot \
      bound_service_account_namespaces=vault \
      token_policies=snapshot token_ttl=10m'
```

The CronJob then runs daily at 03:00, writing `/snapshots/vault-raft-<UTC>.snap` to
the `vault-snapshots` Ceph PVC and pruning to the newest **14** (tune via the
`RETAIN` env / `schedule` in `raft-snapshot.yaml`). Verify after the first run:

```bash
kubectl -n vault get cronjob vault-raft-snapshot
kubectl -n vault create job --from=cronjob/vault-raft-snapshot snap-test   # manual trigger
kubectl -n vault logs job/snap-test
```

---

## §E — Restore from a Raft snapshot (disaster recovery)

A snapshot restores into a **running, unsealed** Vault and **replaces all data**.

```bash
# 0) Identify the snapshot to restore. Snapshots live on the vault-snapshots PVC;
#    copy one out of the CronJob's last pod or mount the PVC in a throwaway pod:
kubectl -n vault run snap-shell --image=hashicorp/vault:1.21.2 --restart=Never -it \
  --overrides='{"spec":{"containers":[{"name":"snap-shell","image":"hashicorp/vault:1.21.2","command":["sh"],"stdin":true,"tty":true,"volumeMounts":[{"name":"s","mountPath":"/snapshots"}]}],"volumes":[{"name":"s","persistentVolumeClaim":{"claimName":"vault-snapshots"}}]}}'
#    -> ls -lt /snapshots ; copy the chosen .snap to your workstation if needed.

# 1) Ensure the main Vault is running + unsealed (auto-unseal handles this), then
#    restore. -force is needed if the snapshot's cluster identity differs.
kubectl -n vault cp <local-or-pod>/vault-raft-<UTC>.snap vault/vault-0:/tmp/restore.snap
kubectl -n vault exec -it vault-0 -- sh -ec '
  vault login <ROOT_or_RECOVERY-derived token>
  vault operator raft snapshot restore -force /tmp/restore.snap'

# 2) After restore, Vault may re-seal; with Transit auto-unseal it re-unseals on its
#    own. Verify:
kubectl -n vault exec -it vault-0 -- vault status        # Sealed=false
kubectl -n vault exec -it vault-0 -- vault kv list secret/   # data present
```

> **Cross-seal note:** a snapshot carries the seal type it was taken under. These
> snapshots are taken under **Transit**, so the unsealer Vault (+ its `autounseal`
> key) must be alive to restore them. Keep the unsealer's Shamir keys offline (§B) —
> losing the unsealer key makes Transit-sealed snapshots unrecoverable. If you ever
> need a seal-independent backup, take a snapshot while temporarily on Shamir.

---

## §F — Key custody summary (write this down offline)

- **Unsealer Shamir shares (5, threshold 3) + unsealer root token** → offline. Needed
  to unseal the unsealer after its (rare) restarts and to rotate the `autounseal` key.
- **Main Vault recovery keys + root token** → offline. Needed for `operator` ops and
  snapshot restore login.
- **`autounseal` token** → lives only in the `vault-transit-unseal-token` k8s Secret;
  it is periodic (auto-renewed). Rotate by minting a new token (§C step 4) and
  `kubectl create secret ... --dry-run=client -o yaml | kubectl apply -f -`, then
  restart vault-0.
- **Never** commit any of the above to git (B1).

### Failure cheatsheet

| Symptom | Cause | Fix |
| --- | --- | --- |
| `vault-0` CrashLoop, "VAULT_TOKEN" / seal init error | `vault-transit-unseal-token` missing or unsealer down | seed the Secret (§C-5) / unseal the unsealer (§C-2) |
| `vault-0` sealed forever after restart | unsealer unreachable or `autounseal` token expired/invalid | check unsealer Ready + netpol; re-mint token (§C-4/§F) |
| TLS verify error in main Vault logs | `vault-unsealer-ca` wrong/missing | re-create from the unsealer's CA (§C-5) |
| snapshot CronJob fails `permission denied` | `snapshot` policy/role not created | run §D snapshot-auth block |
| snapshot CronJob TLS error | `vault-server-tls` missing `ca.crt` | re-issue the cert with `ca.crt` (cert-manager CA issuer) |
| ESO `InvalidProviderConfig` after a seal migration / Vault outage | stale validation cached while Vault was sealed (not a real config error) | `kubectl -n external-secrets rollout restart deploy external-secrets` (§D-5) |
| unsealer pod CrashLoop `FailedMount` `vault-unsealer-server-tls` | Certificate not committed / not yet issued | confirm `platform-services/vault-unsealer/certificate.yaml` is applied + cert READY=True (§C-1) |
