# Vault restore — break-glass procedure and DR drill

**This is the procedure to follow when Vault's data is lost or corrupted.** It is written
to be executed by a tired person at an unreasonable hour, so it states the order of
operations and the traps explicitly rather than assuming Vault expertise.

Companion to [Vault & disaster recovery](vault-and-dr.md) (architecture, snapshots,
key custody) and `artifacts/design/vault-dr-runbook.md` §E (the original restore notes).

> **Status of verification (2026-08-15, task VAULT-DR).** The *seal path* and the
> *snapshots* are verified by execution — see "What has been proven" below. A full
> end-to-end restore into a scratch instance has **NOT** been performed, because it
> cannot be done without a change to live seal infrastructure. Read
> "Why the full drill was not run" before trusting this document as rehearsed.

---

## The one thing to understand first

Vault's raft snapshots are **sealed with the Transit key held by the separate
`vault-unsealer` Vault**. Concretely, every snapshot contains a `SHA256SUMS.sealed`
member (verified — see below). That means:

> **A snapshot is only restorable while the unsealer is alive and its `autounseal`
> Transit key is intact. Losing the unsealer's Shamir keys makes every snapshot on the
> DR PVC permanently unrecoverable — the backups are not self-contained.**

So "the snapshot CronJob is green" is **necessary but not sufficient** evidence that DR
works. Green snapshots plus a dead seal path equals no recovery. Both halves need
checking, and the seal half is the one nothing was watching.

---

## What has been proven (2026-08-15, by execution)

| # | Check | Result |
|---|---|---|
| 1 | **Seal path alive.** Transit `encrypt` then `decrypt` round-trip against the live unsealer using the real `autounseal` credential | **PASS** — plaintext round-tripped byte-identical |
| 2 | **Transit key never rotated.** Ciphertext prefix is `vault:v1:` | **v1** — so *every* snapshot on the PVC, oldest to newest, is decryptable by the key in use today. A rotation would have split this set |
| 3 | **Snapshots exist and are well-formed.** 14 retained (matches `RETAIN=14`), daily at 03:00, newest same-day | **PASS** — newest 60,142,428 bytes, `gzip -t` OK |
| 4 | **Snapshots are genuinely transit-sealed.** Archive members inspected | `meta.json`, `state.bin`, `SHA256SUMS`, **`SHA256SUMS.sealed`** — the sealed member is the structural proof |
| 5 | **Unsealer healthy** | `Sealed=false`, `Initialized=true`, Seal Type `shamir`, v1.21.2 |
| 6 | **Auto-unseal automation is live** (previously believed blocked) | 522 workflow runs, succeeding on schedule, latest minutes before this was written; `UNSEAL_PAUSED` unset |

**Not proven:** that a restore of one of these snapshots into a running Vault completes
and serves data. That is the gap; see the last section.

---

## ⚠ What the auto-unseal cron does and does *not* cover

The `unseal-vault` GitHub Actions workflow (`ccsmith33/capstone-ops-secrets`,
`*/10 * * * *` + manual button, `runs-on: ua-mis-kaniko`) **unseals the
`vault-unsealer` only.** It does not touch the main Vault.

The main Vault has no unseal button because it does not need one *in the normal case*:
it auto-unseals against the unsealer's Transit engine on every start. The chain is:

```
unsealer sealed ──cron heals within ~10min──▶ unsealer open
                                                   │
main vault restarts ──transit decrypt──────────────┘──▶ main vault unsealed
                          (needs a VALID transit token)
```

**The failure mode the cron does NOT cover:** if the token in
`vault-transit-unseal-token` has expired, the cron will keep the unsealer perfectly
healthy and the main Vault will *still* fail to unseal, because the decrypt call is
rejected with 403. That is the 2026-07-14 outage exactly. The only thing that prevents
it is the `vault-transit-token-renewer` CronJob (FIX-4) — and the token is capped at 32
days per renewal by the 768h mount cap (see vault-and-dr.md §"Token lifetimes").

So when the main Vault is sealed and will not open, **check in this order**:
1. Is the unsealer up and unsealed? (`kubectl -n vault-unsealer exec vault-unsealer-0 -- env VAULT_SKIP_VERIFY=1 vault status`)
2. Is the transit token valid? A 403 in the main Vault's logs, not a 503, means the token — not the seal.
3. Only then suspect data/raft.

---

## Restore procedure (break-glass)

**Preconditions.** The unsealer must be alive and unsealed, and the transit token valid.
Verify both before touching data — restoring into a Vault that cannot unseal wastes the
outage window and teaches you nothing.

```bash
# 0) PROVE THE SEAL PATH FIRST — this is the check that was missing historically.
#    A round-trip through the real autounseal key. Non-mutating: transit encrypt and
#    decrypt are compute operations; they do NOT alter the key or the unsealer's state.
TT=$(kubectl get secret vault-transit-unseal-token -n vault -o jsonpath='{.data.token}' | base64 -d)
PT=$(printf 'seal-path-check' | base64)
CT=$(kubectl exec -n vault vault-0 -- env \
      VAULT_ADDR=https://vault-unsealer.vault-unsealer.svc:8200 \
      VAULT_CACERT=/vault/userconfig/vault-unsealer-ca/ca.crt VAULT_TOKEN="$TT" \
      vault write -field=ciphertext transit/encrypt/autounseal plaintext="$PT")
kubectl exec -n vault vault-0 -- env \
      VAULT_ADDR=https://vault-unsealer.vault-unsealer.svc:8200 \
      VAULT_CACERT=/vault/userconfig/vault-unsealer-ca/ca.crt VAULT_TOKEN="$TT" \
      vault write -field=plaintext transit/decrypt/autounseal ciphertext="$CT"
# Must print back the same base64 as $PT. If this 403s, STOP: fix the token first
# (vault-and-dr.md §"Token lifetimes"), because no restore can succeed until it works.
```

```bash
# 1) Pick a snapshot. They live on the vault-snapshots PVC, written daily 03:00 UTC,
#    newest 14 retained. Mount the PVC read-only to browse (the PVC is RWO and normally
#    unmounted between CronJob runs):
#      manifest: a hashicorp/vault:1.21.2 pod, runAsUser 100, mounting claim
#      vault-snapshots readOnly at /snapshots. Then: ls -lt /snapshots/
#    Sanity-check the file BEFORE restoring — a truncated snapshot restores as garbage:
#      gzip -t /snapshots/vault-raft-<UTC>.snap        # integrity
#      gzip -dc <file> | tar -tv                        # expect meta.json, state.bin,
#                                                       # SHA256SUMS, SHA256SUMS.sealed

# 2) Identify the CURRENT RAFT LEADER — restore is a raft-local operation and is NOT
#    forwarded to the active node.
kubectl -n vault exec vault-0 -- env VAULT_CACERT=/vault/userconfig/vault-server-tls/ca.crt \
  vault operator raft list-peers

# 3) Copy the snapshot into the LEADER pod and restore. -force is required when the
#    cluster ID differs from the snapshot's.
kubectl -n vault cp <local>/vault-raft-<UTC>.snap vault/<leader>:/tmp/restore.snap
kubectl -n vault exec -it <leader> -- env VAULT_CACERT=/vault/userconfig/vault-server-tls/ca.crt \
  vault operator raft snapshot restore -force /tmp/restore.snap

# 4) Confirm recovery. The restored keyring is decrypted through the SAME transit key,
#    so the node should come back unsealed on its own.
kubectl -n vault exec <leader> -- vault status                  # Sealed=false
kubectl -n vault exec <leader> -- vault operator raft list-peers # all 3 still voters

# 5) Bounce ESO so it drops stale Vault connections, then spot-check that a tenant
#    ExternalSecret still resolves (they have a 1h refreshInterval — force-sync rather
#    than waiting):
kubectl rollout restart deploy -n external-secrets
kubectl annotate externalsecret <name> -n <ns> force-sync="$(date +%s)" --overwrite
```

**Restore replaces ALL data cluster-wide.** The leader replicates the restored state to
both followers over raft; you do not restore into each pod separately.

---

## Variant: the unsealer itself is down

This is the harder case, and the one that caused the 2026-07-14 outage.

1. **Try the automation first.** The `unseal-vault` workflow's manual button (or its
   `*/10` cron) unseals the unsealer without anyone typing Shamir shares. It is live and
   working — 522 runs. This is the intended path.
2. **If the automation cannot run** (GitHub down, runners down, `UNSEAL_PAUSED=true`, or
   the repo's Actions minutes exhausted), unseal by hand with 3 of the 5 Shamir shares:
   ```bash
   kubectl exec -n vault-unsealer vault-unsealer-0 -- sh -c \
     'VAULT_SKIP_VERIFY=1 vault operator unseal <SHARE>'    # repeat ×3, distinct shares
   ```
   Shares are in `vault/unsealer-keys.txt` in the private `capstone-ops-secrets` repo
   (the deliberate, scoped exception to "never commit keys" — see vault-and-dr.md
   §"Key custody") **and** offline.
   ⚠ **Two init key-sets exist historically.** Only the newest works. If shares are
   rejected, you are holding the dead set — see `capstone-ops-secrets` for which is live.
3. **Once the unsealer is open**, the main Vault auto-unseals on its next start.
   Exponential crash-backoff means a sealed pod may not retry promptly — force it with
   `kubectl -n vault delete pod vault-0` (one at a time; the StatefulSet is `OnDelete`).
4. **If the unsealer's Shamir keys are lost entirely**, the Transit key is gone and every
   snapshot is unrecoverable. There is no recovery from that state. This is the single
   worst-case scenario on this platform and the reason the shares are stored in two
   places.

---

## Why the full drill was not run (2026-08-15) — and what it would take

The task called for restoring a snapshot into an **isolated scratch Vault** in a separate
namespace, pointed at the live unsealer, with an explicit instruction to **stop if the
drill required any write or config change to live seal infrastructure**. It does. Stopping
was the correct outcome, not a shortcut:

- The `vault-unsealer` namespace runs `zz-default-deny` (ingress **and** egress) plus a
  single ingress allow whose sources are exactly `namespace=vault` and
  `namespace=arc-runners`.
- A scratch Vault in any **new** namespace therefore **cannot reach
  `vault-unsealer:8200`**, so it can never transit-unseal, so it can never complete a
  restore.
- Making it reachable means editing the unsealer's ingress NetworkPolicy — i.e. changing
  the live seal infrastructure's security posture, four days before classes start, on the
  platform's most load-bearing component, with no human at the keyboard.

The transit *read-only* assumption in the task **was verified and holds**: `encrypt` and
`decrypt` are compute operations that do not mutate the key or the unsealer's state (only
`transit/keys/.../rotate` or config writes would), and the round-trip above exercises
exactly that path safely. The blocker is network reachability, not seal semantics.

**To complete the drill later**, a human should decide between:

1. **Temporary additive NetworkPolicy** allowing `namespace=vault-drill` →
   `vault-unsealer:8200`, removed immediately afterwards. Lowest effort. Note the
   containment that already exists and should be preserved: the `vault` namespace's own
   ingress policy denies the scratch namespace, so a restored scratch node **cannot**
   reach live raft peers on `:8201` even if the restored peer configuration names them.
   That containment is what makes this option defensible — do not also open `vault` ns
   ingress.
2. **Run the drill on a throwaway cluster** with its own unsealer, restoring a copied
   snapshot. Highest fidelity, zero risk to production, most setup. Best done between
   semesters.

Either way the drill should be run **before** relying on this document in an incident.
Until then, treat the restore procedure above as *written but unrehearsed*: the
preconditions and the seal path are verified, the restore commands are not.
