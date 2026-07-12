# Vault raft-FSM bloat — diagnosis & operator hygiene runbook

**Status:** live-diagnosed 2026-07-11. Companion to `vault-dr-runbook.md`.
**Who runs this:** the platform operator, with the **Vault root token** (saved offline at
init, README §D step 3). Every capping/pruning/tidy command below is root-only — ESO/
Crossplane SAs are deliberately scoped and cannot tune mounts, destroy versions, or tidy
tokens/leases. The GitOps PR (README `-max-versions=10` default + this doc) covers the
*forward-looking* enforcement; the *reclaim* of the already-bloated file is keyboard work.

---

## 1. What was measured (no root needed — read-only SA)

Auth as a non-root read SA to reproduce:

```bash
JWT=$(kubectl create token external-secrets -n external-secrets --audience=vault)
RT=$(kubectl -n vault exec vault-0 -- sh -c \
  "VAULT_ADDR=https://127.0.0.1:8200 VAULT_SKIP_VERIFY=true \
   vault write -field=token auth/kubernetes/login role=external-secrets jwt=$JWT")
X(){ kubectl -n vault exec vault-0 -- sh -c \
  "VAULT_ADDR=https://127.0.0.1:8200 VAULT_SKIP_VERIFY=true VAULT_TOKEN=$RT $1"; }
```

Findings (2026-07-11):

| Metric | Value |
|---|---|
| `vault.db` (raft FSM, BoltDB) on all 3 nodes | **~274–280 MB** (was ~74 MB ~2 days prior) |
| `raft/raft.db` (raft log) | ~31.6 MB |
| Last **successful** snapshot | ~150 MB |
| Tenant teams in KV | 3 (`smoketest`, `swami`, `teardown`) |
| **Total live KV versions across ALL tenant paths** | **73** (max 10 on any single path; `max_versions: 0` = uncapped everywhere) |
| ESO objects driving 1h-TTL logins | 1 ClusterSecretStore, 4 SecretStores, 18 ExternalSecrets (`refreshInterval: 1h`), 6 PushSecrets |
| k8s-auth role `token_ttl` | `1h` (eso / tenant / backstage / crossplane-push) |

### The key correction to the initial hypothesis

The stated root cause was "KV-v2 keeps every version → versions accumulate forever."
That mechanism is **real but minor here**: only **73 live versions** exist mount-wide, a
few KB each — single-digit MB, not the ~190 MB of growth. A per-path metadata read
confirms the churn is bounded (highest is `swami/*/database` at `current_version=10`):

```
secret/tenants/swami/dev/database    current=10 oldest=1   (max_versions=0)
secret/tenants/smoketest/dev/app     current=7  oldest=0
secret/tenants/swami/console/database current=5 oldest=0
...  (16 paths, 73 live versions total)
```

So KV capping is **worth doing** (cheap insurance, and it shrinks future snapshots), but
it will **not by itself** explain or reclaim the 274 MB. The FSM is ~274 MB while live KV
is a few MB ⇒ the bulk is **non-KV storage**: expired-but-not-tidied **tokens and leases**.
This is consistent with the load: 24 ExternalSecrets/PushSecrets re-login hourly and
Upjet `provider-vault` mints a **child token per API call** on every reconcile, so token /
`sys/expiration` lease entries churn orders of magnitude faster than KV versions. The
Jul-10 duplicate-tenant-claim apply-fight was a burst of exactly this churn.

Confirming the token/lease split needs **root** (the read SA gets 403 on
`sys/leases/count`, `auth/token/accessors`, `sys/mounts/secret/tune`) — see §2.

### BoltDB does not shrink

`vault.db` is a BoltDB B+tree: it grows to a high-water mark and **never returns freed
pages to the OS**. Destroying KV versions or tidying tokens frees pages *for reuse inside
the file* (growth plateaus) but the on-disk size stays ~274 MB. Reclaiming disk requires a
**snapshot save + restore** (writes a fresh, compacted db) or a PVC rebuild (§5). Note the
snapshot *file* only serializes live data, so shrinking live data DOES shrink every future
backup even while `vault.db` stays large.

---

## 2. Confirm the real driver (ROOT token required)

```bash
kubectl -n vault exec -it vault-0 -- sh -c \
 'VAULT_ADDR=https://127.0.0.1:8200 VAULT_SKIP_VERIFY=true vault login <ROOT_TOKEN>'

R(){ kubectl -n vault exec -it vault-0 -- sh -c \
 "VAULT_ADDR=https://127.0.0.1:8200 VAULT_SKIP_VERIFY=true $1"; }

# How many stored tokens accumulated? (expect this to be large)
R 'vault list -format=json auth/token/accessors | jq length'
# Lease counts (irrevocable leases never expire on their own — pure bloat):
R 'vault read sys/leases/count type=irrevocable'
R 'vault read sys/leases/count type=revocable'
# Confirm the mount is uncapped today:
R 'vault read sys/mounts/secret/tune'          # expect max_versions 0
```

If `auth/token/accessors` is in the thousands and/or `irrevocable` leases are non-trivial,
the token/lease theory is confirmed and §4 is the high-value step.

---

## 3. Cap KV versions going forward (ROOT — one command, permanent)

The PR sets `-max-versions=10` for **fresh** installs (README step 6). On this **already
running** mount, tune it in place:

```bash
R 'vault secrets tune -max-versions=10 secret/'
R 'vault read sys/mounts/secret/tune'          # verify max_versions=10
```

Mount tune affects the **default for future writes only** — it does not retroactively
delete existing excess versions. To retroactively cap a specific path you must set its
metadata (which trims to the newest N on the *next* write) and/or destroy old versions (§4).

---

## 4. Prune existing bloat (ROOT — dry-run first, never touch current version)

### 4a. KV old versions (small win, but do it while you're here)

`vault kv destroy` removes the underlying data of specific versions (unlike soft
`delete`). **Only destroy versions strictly older than `current_version`.**

```bash
# DRY-RUN: list every tenant path + its version window FIRST.
for p in $(R 'vault kv list -format=json secret/tenants' | jq -r '.[]'); do
  R "vault kv metadata get -format=json secret/tenants/${p%/}" 2>/dev/null | \
    jq -r --arg P "$p" '"\($P): current=\(.data.current_version) oldest=\(.data.oldest_version)"'
done   # (recurse into env/leaf subkeys the same way — the mount is only ~16 leaf paths)

# Per leaf path: cap its metadata to 10, then hard-destroy versions below (current-10).
# Example for one path (repeat / script per leaf; NEVER include current_version):
R 'vault kv metadata put -max-versions=10 secret/tenants/swami/dev/database'
R 'vault kv destroy -versions=1,2,3,4,5,6 secret/tenants/swami/dev/database'  # keep 7..current
```

Because total live versions are only 73, expect a **few MB** freed internally here — the
point is hygiene + smaller snapshots, not the 274 MB.

### 4b. Tokens & leases (THE high-value reclaim)

```bash
# Revoke + remove expired token store entries and their index:
R 'vault token tidy'                    # async; re-run `vault list auth/token/accessors | jq length` to watch it fall
# Reap dangling leases (expired but not yet cleaned):
R 'vault lease tidy'
# If irrevocable leases exist and are confirmed safe to drop:
#   R 'vault write sys/leases/revoke-force/<prefix>'   # DANGEROUS — only for known-orphan prefixes
```

Reduce future churn (optional, lower priority): the four k8s-auth roles use
`token_ttl=1h`. ESO caches and reuses the token until near expiry, so 1h is fine; the
bigger contributor is Upjet's per-call child tokens, which are short-lived and tidy well.
Keeping `vault token tidy` / `vault lease tidy` on a schedule (or relying on Vault's
built-in expiration manager, which does this automatically in 1.21.x) is the durable fix.

---

## 5. Actually reclaim the 274 MB on disk (ROOT — optional, heavier)

Tidying + destroying only *plateaus* `vault.db`; the file stays ~274 MB. Disk is **not an
emergency** (snapshots PVC 5 Gi @ 18%), so this is optional. When you do want the space
back, compact via snapshot round-trip on a maintenance window:

```bash
# From the ACTIVE node (check `vault status` → HA Mode: active; currently vault-2):
R 'vault operator raft snapshot save /tmp/compact.snap'
# Then restore it into the SAME cluster — this rewrites vault.db compacted:
R 'vault operator raft snapshot restore -force /tmp/compact.snap'
```

Lower-risk alternative on a 3-node HA cluster: delete one follower's data PVC and let it
re-join and receive a fresh (compacted) snapshot from the leader, one node at a time
(`vault operator raft remove-peer` / re-join per README §G). Verify quorum stays healthy
between nodes.

---

## 6. Verify the shrink

```bash
# Before/after FSM + last-snapshot size:
for n in vault-0 vault-1 vault-2; do
  kubectl -n vault exec $n -- du -h /vault/data/vault.db /vault/data/raft/raft.db
done
# Snapshot size (this is what backups cost — should drop after §4):
kubectl -n vault exec vault-0 -- ls -la /snapshots/ | tail
```

Success criteria:
- After **§3+§4**: `vault.db` **stops growing** day-over-day; new snapshot files are
  smaller than the ~150 MB baseline (proves live data shrank).
- After **§5** (if run): `vault.db` on the restored/rebuilt node drops from ~274 MB toward
  the live-data size.

---

## 7. Related issue spotted (out of scope, flagging)

The `vault-raft-snapshot` CronJob has been **failing for ~20h**: last 3 pods `Error` —
`Error taking the snapshot: incomplete snapshot, unable to read SHA256SUMS.sealed file`.
The ~150 MB figure comes from the last *successful* run (~4d20h ago). DR backups are
currently NOT being produced — worth a separate fix (likely snapshot taken against a
standby node or a seal/read race), see `raft-snapshot.yaml` + `vault-dr-runbook.md`.

---

## Root vs. PR — what covers what

| Step | Mechanism | Needs root? | Covered by |
|---|---|---|---|
| Fresh installs get `max_versions=10` | `secrets enable -max-versions=10` | yes (bootstrap) | **PR** (README step 6) |
| Cap the *existing* live mount | `secrets tune -max-versions=10 secret/` | **yes** | runbook §3 |
| Prune old KV versions | `kv metadata put` + `kv destroy` | **yes** | runbook §4a |
| Tidy tokens/leases (the real driver) | `token tidy` / `lease tidy` | **yes** | runbook §4b |
| Reclaim on-disk 274 MB | snapshot save+restore / PVC rebuild | **yes** | runbook §5 |
| Verify | `du` / snapshot size | no (read) | runbook §6 |

The mount cannot be capped via GitOps: `provider-vault` manages only tenant `Policy` +
`AuthBackendRole` (scoped to `tenants/*`); its `tenant-provisioner` token cannot tune
`sys/mounts`, and the `secret/` mount was created by the root bootstrap, not Crossplane.
Widening the provider policy + adopting a live secrets mount into a v0.1.0 provider would
be riskier than one root `secrets tune`. Hence: PR = forward default + this runbook; the
operator runs the tune/tidy/prune with the root token.
