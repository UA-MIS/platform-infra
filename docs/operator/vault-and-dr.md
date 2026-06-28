# Vault & disaster recovery

HashiCorp Vault is the runtime secret store: ESO reads from it and materializes
namespaced Kubernetes Secrets (see [Secrets & ESO](secrets-eso.md)). Vault runs
single-node, Raft on Ceph, in the `vault` namespace.

> **The authoritative procedure is `artifacts/design/vault-dr-runbook.md`.** This
> page summarizes the architecture and the operator-facing actions. **Every step
> in the runbook is a cluster write or secret-handling action — agents cannot run
> them (classifier-gated). They are the human operator's keyboard.**

GitOps surfaces:
`applicationsets/vault-app.yaml` (main Vault, `seal "transit"`),
`applicationsets/vault-unsealer-app.yaml` (the unsealer Vault),
`platform-services/vault/` (namespace + `raft-snapshot.yaml`),
`platform-services/vault-unsealer/`,
`hardening/netpol-controlplane/vault-*.yaml`.

---

## Transit auto-unseal architecture

The retro flagged Vault as "single-node, manual-unseal, no DR." Track-2 (ADR-030
B1, PR #126) fixed unseal toil and DR without going to 3-node HA (explicitly out
of scope — anti-gold-plate).

```
  ┌─────────────────────────┐  seal "transit" (TLS, token-auth)   ┌──────────────────────────┐
  │  platform-vault          │ ──── encrypt/decrypt root key ────▶ │ platform-vault-unsealer   │
  │  (vault ns)              │   on every unseal                   │ (vault-unsealer ns)       │
  │  Raft on Ceph, ESO store │                                     │ standalone, holds ONE     │
  │  AUTO-unseals            │                                     │ transit key; MANUAL-unseal│
  └─────────────────────────┘                                     └──────────────────────────┘
```

- The **main Vault** seals/unseals its root key against a tiny second **unsealer
  Vault** via Vault's `transit` seal. So the main Vault **auto-unseals on every
  restart** — no more hand-typing 3 Shamir shares after each reboot/upgrade/OOM.
- **Why a second Vault?** It is the only auto-unseal option that keeps the seal key
  **off the main Vault's own disk** and needs no cloud KMS (none exists on Talos).
- **The trade-off (accepted):** the unsealer itself stays on manual Shamir unseal
  (bootstrapping it with a third Vault is infinite regress). But it holds one key,
  carries no app load, and **restarts rarely** — so hand-unsealing it is a
  once-in-a-blue-moon task, versus hand-unsealing the busy main Vault every
  restart. Net day-to-day unseal toil ≈ 0.
- **Availability:** if the **unsealer** is down, the main Vault cannot *unseal*
  (a main-Vault restart waits) — but an already-unsealed main Vault keeps serving
  and ESO keeps serving already-materialized k8s Secrets. Bring the unsealer back
  and the main Vault auto-unseals on its next restart.

### One-time migration (Shamir → Transit)

Already done if Vault is live on transit. If you ever rebuild: the
runbook **§C** brings up the unsealer and seeds the two `vault` ns Secrets
(`vault-transit-unseal-token`, `vault-unsealer-ca`); **§D** runs the one-time
`vault operator unseal -migrate <SHAMIR_SHARE>` ceremony.

> ⚠ **Ordering (runbook §D):** §C must be fully done (unsealer live, both `vault`
> ns Secrets seeded) **before** the `seal "transit"` change reaches the cluster.
> If the main Vault restarts into the new config without
> `vault-transit-unseal-token`, it cannot start (missing `VAULT_TOKEN`). Merging /
> syncing `vault-app.yaml` is what triggers the restart — control that timing.

After migration the main Vault issues **recovery keys** (not unseal keys); re-key
and store them offline (`vault operator rekey -target=recovery ...`).

---

## DR: Raft snapshots

A daily CronJob `vault-raft-snapshot` (`vault` ns, `platform-services/vault/raft-snapshot.yaml`)
runs `vault operator raft snapshot save` to the `vault-snapshots` Ceph PVC (5Gi,
replica-3), schedule `0 3 * * *`, retaining the newest **14** (`RETAIN` env). It
authenticates via Kubernetes auth as SA `vault-snapshot`.

> ⚠ **The snapshot auth (Vault policy + k8s role) is a one-time operator setup
> that is not yet done** — issue #126 follow-up. The CronJob fails
> `permission denied` until you create the `snapshot` policy + role. The
> ready-to-run, fish-safe procedure is in [Runbooks → (A)](runbooks.md).

Verify after the first run:

```bash
kubectl -n vault get cronjob vault-raft-snapshot
kubectl -n vault create job --from=cronjob/vault-raft-snapshot snap-test
kubectl -n vault logs job/snap-test           # expect a /snapshots/vault-raft-<UTC>.snap written
```

### Restore (runbook §E)

A snapshot restores into a **running, unsealed** Vault and **replaces all data**.

```bash
# copy the chosen .snap into vault-0, then (logged in with a root/recovery-derived token):
kubectl -n vault cp <local>/vault-raft-<UTC>.snap vault/vault-0:/tmp/restore.snap
kubectl -n vault exec -it vault-0 -- vault operator raft snapshot restore -force /tmp/restore.snap
kubectl -n vault exec -it vault-0 -- vault status        # Sealed=false (auto-unseals)
```

> **Cross-seal note (runbook §E):** these snapshots are taken under **Transit**, so
> the unsealer Vault (+ its `autounseal` key) must be alive to restore them. Losing
> the unsealer's Shamir keys makes Transit-sealed snapshots unrecoverable. For a
> seal-independent backup, take a snapshot while temporarily on Shamir.

---

## Key custody (write this down offline — runbook §F)

| Material | Where | Needed for |
| --- | --- | --- |
| **Unsealer Shamir shares (5, threshold 3) + unsealer root token** | offline (password manager / sealed medium) | unseal the unsealer after its rare restarts; rotate the `autounseal` key |
| **Main Vault recovery keys + root token** | offline | `operator` ops (rekey, generate-root), snapshot-restore login |
| `autounseal` token | only in the `vault-transit-unseal-token` k8s Secret (periodic, auto-renewed) | the seal — rotate by minting a new token and re-applying the Secret |

**Never commit any of the above to git.** Treat the unsealer Shamir keys and the
main Vault recovery keys exactly like the Sealed Secrets sealing key and the
sops/age key in the handoff vault (`docs/OPERATIONS-AND-HANDOFF.md` §5).

---

## Failure cheatsheet (runbook §F)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `vault-0` CrashLoop, `VAULT_TOKEN`/seal init error | `vault-transit-unseal-token` missing or unsealer down | seed the Secret (runbook §C-5) / unseal the unsealer (§C-2) |
| `vault-0` sealed forever after restart | unsealer unreachable or `autounseal` token expired | check unsealer Ready + netpol; re-mint the token (§C-4) |
| TLS verify error in main Vault logs | `vault-unsealer-ca` wrong/missing | re-create from the unsealer's CA (§C-5) |
| snapshot CronJob `permission denied` | `snapshot` policy/role not created | run [Runbooks → (A)](runbooks.md) |
| snapshot CronJob TLS error | `vault-server-tls` missing `ca.crt` | re-issue the cert with `ca.crt` (cert-manager CA issuer) |

The `VaultSealedOrDown` alert (critical, via kube-state-metrics) fires when the
vault StatefulSet has 0 ready replicas for 5m — see [Observability](observability.md).

---

## ⚠ `OnDelete` StatefulSet update strategy

The Vault StatefulSet uses the `OnDelete` update strategy on purpose: a change to
the StatefulSet spec does **not** roll the pod automatically — you delete the pod
to apply it, on your schedule. This once **prevented an accidental Vault brick**
(an auto-roll into a bad config would have sealed Vault with no operator present).
Expect to `kubectl -n vault delete pod vault-0` deliberately after a Vault config
change, and confirm it returns Ready (auto-unseals) before moving on.
