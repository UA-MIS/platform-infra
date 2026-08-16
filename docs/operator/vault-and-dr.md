# Vault & disaster recovery

HashiCorp Vault is the runtime secret store: ESO reads from it and materializes
namespaced Kubernetes Secrets (see [Secrets & ESO](secrets-eso.md)). Vault runs
**3-node Raft HA** (one pod per control-plane node, hard anti-affinity), Raft
storage on Ceph, in the `vault` namespace — tolerating one node/pod loss with no
interruption to secret sync. (Prior to the HA rollout it ran single-node; see
`artifacts/design/vault-dr-runbook.md` §G for the rollout procedure.)

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
B1, PR #126) fixed unseal toil and DR first, on the single node. A follow-up PR
then added 3-node Raft HA (below) — Vault-**process** HA, not just data
durability.

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

## 3-node Raft HA

`applicationsets/vault-app.yaml` runs the main Vault at `ha.replicas: 3` with a
hard `podAntiAffinity` (one Vault server pod per control-plane node — there are
exactly 3). The cluster tolerates **one node/pod loss** with **zero** interruption
to secret sync: a leader is always reachable via the chart-managed `vault-active`
Service (label `vault-active: "true"`, re-pointed automatically on failover); the
two followers are reachable via `vault-standby`. Transit auto-unseal (above)
applies to all 3 pods identically — a follower that restarts or newly joins
auto-unseals within seconds, no Shamir typing.

- **Rollout procedure** (1 → 3, one-time): `vault operator raft join` each new
  follower against the existing leader, confirm auto-unseal, confirm quorum via
  `vault operator raft list-peers`. Full steps + a failure cheatsheet:
  `artifacts/design/vault-dr-runbook.md` §G.
- **Steady state:** a rebooted/rescheduled pod rejoins on its own from its
  persisted Raft state on its Ceph PVC — no manual re-join needed. Only a
  brand-new (empty-PVC) pod needs an explicit `raft join`.
- **Scale-down is not supported live** — see the runbook §G Rollback note
  (`vault operator raft remove-peer` before reducing `ha.replicas`).
- **The unsealer stays single-node, manual-unseal** — 3-node HA applies only to
  the main Vault (see §A above).

---

## DR: Raft snapshots

A daily CronJob `vault-raft-snapshot` (`vault` ns, `platform-services/vault/raft-snapshot.yaml`)
runs `vault operator raft snapshot save` to the `vault-snapshots` Ceph PVC (5Gi,
replica-3), schedule `0 3 * * *`, retaining the newest **14** (`RETAIN` env). It
authenticates via Kubernetes auth as SA `vault-snapshot`, and targets
`vault-active.vault.svc` (not the generic `vault` Service) so the snapshot is
always taken against the current raft leader, never a standby.

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

> **In an incident, use [vault-restore-drill.md](vault-restore-drill.md)** — the
> break-glass procedure. It leads with the seal-path precondition check (a restore
> cannot succeed if the transit token is dead, and that failure looks like a data
> problem), covers the unsealer-down variant, and records what has and has not been
> verified by execution. The commands below remain the short form.

A snapshot restores into a **running, unsealed** Vault and **replaces all data**
cluster-wide (the leader replicates the restored state to both followers over
raft — you do not restore into each pod separately). Run it against whichever pod
is currently the leader (`vault operator raft list-peers` to confirm; `vault-0`
below assumes it still is):

```bash
# copy the chosen .snap into the LEADER pod, then (logged in with a root/recovery-derived token):
kubectl -n vault cp <local>/vault-raft-<UTC>.snap vault/vault-0:/tmp/restore.snap
kubectl -n vault exec -it vault-0 -- vault operator raft snapshot restore -force /tmp/restore.snap
kubectl -n vault exec -it vault-0 -- vault status        # Sealed=false (auto-unseals)
kubectl -n vault exec -it vault-0 -- vault operator raft list-peers   # confirm all 3 still voters after restore
```

> **Cross-seal note (runbook §E):** these snapshots are taken under **Transit**, so
> the unsealer Vault (+ its `autounseal` key) must be alive to restore them. Losing
> the unsealer's Shamir keys makes Transit-sealed snapshots unrecoverable. For a
> seal-independent backup, take a snapshot while temporarily on Shamir.

---

## Key custody (write this down offline — runbook §F)

| Material | Where | Needed for |
| --- | --- | --- |
| **Unsealer Shamir shares (5, threshold 3) + unsealer root token** | offline (password manager / sealed medium) **AND** `vault/unsealer-keys.txt` in the private `capstone-ops-secrets` repo (Shamir shares only, NOT the root token — see below) | unseal the unsealer after its rare restarts; rotate the `autounseal` key |
| **Main Vault recovery keys + root token** | offline | `operator` ops (rekey, generate-root), snapshot-restore login |
| `autounseal` token | only in the `vault-transit-unseal-token` k8s Secret (periodic; renewed nightly by the CronJob below — **it is not self-renewing**) | the seal — rotate by minting a new token and re-applying the Secret |

**Never commit any of the above to git — with ONE deliberate, scoped exception:**
the unsealer's 5 Shamir shares (only — never its root token, never the main
Vault's recovery keys) also live in plaintext in `vault/unsealer-keys.txt` in
the private `capstone-ops-secrets` repo, read by the `unseal-vault` GitHub
Actions automation (button + `*/10m` cron — [Runbooks (D)](runbooks.md)). This
is an operator decision, not an oversight: this platform's ~3-person staff
turns over every year, and GitHub Actions Secrets are write-only (a successor
can't read them back to hand off or recover). See `unseal-vault.yaml`'s header
comment for the full trade-off. Everything else in this table stays
offline-only, exactly like the Sealed Secrets sealing key and the sops/age key
in the handoff vault (`docs/OPERATIONS-AND-HANDOFF.md` §5).

---

## Token lifetimes — the 768h cap (D-061)

**`-period` does not mean "never expires" on this cluster.** Vault's token auth
mount is tuned `max_lease_ttl=768h`, so **every token it issues is capped at 32
days per issuance**, whatever period you ask for. `vault token create
-period=8760h` records `period=365d` on the token but still grants a 32-day TTL —
Vault says so out loud if you read the warning it returns:

```
* period of "8760h" exceeded the effective max_ttl of "768h"; period value is capped accordingly
```

A periodic token *can* be renewed forever, but each renewal only re-grants
`min(period, 768h)` = 32 days, **and something has to actually renew it**. Nothing
did, until FIX-4. That single misunderstanding caused two incidents:

| Token | Secret | Renewed by | What its expiry breaks |
| --- | --- | --- | --- |
| `tenant-provisioner` | `vault-provider-creds` (crossplane-system) | `provider-vault-token-renewer` CronJob, daily 02:20 | provider-vault stops reconciling → **new tenants silently get no Vault policy/role**, so their app secrets never materialize (finding F-2, ~13 days undetected) |
| `autounseal` | `vault-transit-unseal-token` (vault) | `vault-transit-token-renewer` CronJob, daily 02:40 | Vault **cannot auto-unseal** → the next pod restart comes up sealed and stays sealed (the 2026-07-14 outage) |

Both renewers call `auth/token/renew-self`, which is in the built-in `default`
policy — they hold **no** Vault policy, mint nothing, and cannot read secret
values. Renewal is server-side, so the token string never changes and the Secrets
are never rewritten (no SealedSecret / ArgoCD drift).

> ⚠ **The transit-token failure hides until it bites.** An already-unsealed Vault
> node keeps its key in memory and never re-checks the seal, so an expired
> `autounseal` token shows no symptom at all — `vault status` is green, ESO is
> green — right up until a reboot, upgrade, OOM or reschedule restarts a pod.
> Never infer "the seal path is healthy" from "Vault is up". Check the renewer.

**If a renewer alerts** (`VaultTokenRenewerStale` / `VaultTokenRenewerFailing`),
read the Job log — it prints Vault's actual error. A 403 means the token is
already dead and renewal cannot recover it: mint a fresh one and reseal
(`platform-services/crossplane/creds/README.md` for the provisioner token, §C-4
of the runbook for the autounseal token). A TLS/connection error usually means the
token is fine and Vault or the unsealer is unreachable. There is ~29 days of
margin between the first failed run and an actual outage — but it is finite, and
the alert is the only warning you get.

**Why not Kubernetes auth for provider-vault** (which would remove the static
token entirely, and was the preferred design): upbound provider-vault v0.1.0
cannot do it. Proven by execution — the ProviderConfig CRD exposes no `auth_login*`
field, and passing an `auth_login_kubernetes` block through the credentials JSON
fails with `cannot unmarshal array into Go value of type string` (the credentials
blob is parsed into string-valued fields, so no Terraform block fits). Revisit on
a provider bump; note the provider's ServiceAccount name is revision-hashed, so
pin it via the DeploymentRuntimeConfig first or the role breaks on every upgrade.

---

## Failure cheatsheet (runbook §F)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `vault-0` CrashLoop, `VAULT_TOKEN`/seal init error | `vault-transit-unseal-token` missing or unsealer down | seed the Secret (runbook §C-5) / unseal the unsealer (§C-2) |
| `vault-0` sealed forever after restart | unsealer unreachable or `autounseal` token expired | check unsealer Ready + netpol; re-mint the token (§C-4). If the token expired, the renewer had been failing — check `VaultTokenRenewerStale` and the CronJob logs |
| `VaultTokenRenewerStale` / `VaultTokenRenewerFailing` firing | a Vault token renewer CronJob is failing or has stopped running | fix it NOW — see "Token lifetimes" below. Not yet an outage; you have weeks of margin, and it is the only warning you get |
| TLS verify error in main Vault logs | `vault-unsealer-ca` wrong/missing | re-create from the unsealer's CA (§C-5) |
| snapshot CronJob `permission denied` | `snapshot` policy/role not created | run [Runbooks → (A)](runbooks.md) |
| snapshot CronJob TLS error | `vault-server-tls` missing `ca.crt` | re-issue the cert with `ca.crt` (cert-manager CA issuer) |
| `vault-1`/`vault-2` stuck `0/1`, no raft-join errors | transit auto-unseal in progress (a few seconds to ~30s after join) | wait, then `vault status`; see the runbook §G cheatsheet if still sealed after 2 min |
| `vault operator raft list-peers` shows <3 voters | a pod hasn't been joined yet, or a node/pod is down | join it (runbook §G) if new; otherwise wait for reschedule (rejoins automatically from its own PVC) |

The `VaultSealedOrDown` alert (critical, via kube-state-metrics) fires when the
vault StatefulSet has 0 ready replicas for 5m (all 3 pods down/sealed — full
outage). The `VaultHADegraded` warning alert fires when fewer than 3 of 3 replicas
are ready for 10m (one pod down but the cluster still has quorum and is serving
via the other two) — see [Observability](observability.md).

---

## ⚠ `OnDelete` StatefulSet update strategy

The Vault StatefulSet uses the `OnDelete` update strategy on purpose: a change to
the StatefulSet spec does **not** roll pods automatically — you delete each pod
to apply it, on your schedule, one at a time. This once **prevented an accidental
Vault brick** (an auto-roll into a bad config would have sealed Vault with no
operator present); with 3-node HA it also means a bad config rolls out to at most
one pod before you notice, instead of all 3 simultaneously. Expect to `kubectl -n
vault delete pod vault-0` (then `vault-1`, then `vault-2` — one at a time,
confirming each returns `1/1` and auto-unseals before moving to the next) after a
Vault config change.
