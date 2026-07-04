#!/usr/bin/env bash
# Raft-snapshot Vault policy + Kubernetes-auth role (ADR-030 B1, Track-2 DR).
# Backs the `vault-raft-snapshot` CronJob (platform-services/vault/raft-snapshot.yaml),
# which runs `vault operator raft snapshot save` daily for disaster recovery.
#
# WHY THIS FILE EXISTS (was prose-only): the `snapshot` policy + role were originally
# documented only as an inline block in artifacts/design/vault-dr-runbook.md §D, NOT
# as a committed, re-runnable script like its four siblings in this directory
# (eso-role.sh, backstage-role.sh, tenant-role.sh, crossplane-push-role.sh). That gap
# meant the role was NOT reliably reproduced after a Vault re-init / seal migration —
# and it went missing, so every CronJob run failed with:
#     Error writing data to auth/kubernetes/login ... 400  * invalid role name "snapshot"
# → no snapshot taken → silent DR gap. Committing the script closes that gap: re-run it
# any time the role is absent and it is idempotent (policy write + role write overwrite).
#
# ⚠ NO `audience=` HERE — DELIBERATE, this is the ONE difference from the siblings.
#   The snapshot CronJob authenticates with the pod's DEFAULT projected ServiceAccount
#   token (/var/run/secrets/kubernetes.io/serviceaccount/token), whose audience is the
#   API server, NOT `vault`. It does NOT mount a projected audience:vault token the way
#   Backstage/ESO/Crossplane do. Setting audience="vault" on this role would REJECT the
#   default token ("invalid audience") and re-break the job. Leave audience unset so the
#   role accepts the default SA token via TokenReview. (If you later harden the CronJob
#   to mount a projected audience:vault token, add audience="vault" here to match.)
#
# Run AFTER `vault auth enable kubernetes` (vault/README.md §D step 6), inside the Vault
# pod (already `vault login`'d as root), e.g.:
#   kubectl -n vault exec -i vault-0 -- \
#     env VAULT_CACERT=/vault/userconfig/vault-server-tls/ca.crt sh < snapshot-role.sh
set -euo pipefail

# --- Policy: read-only on the single raft-snapshot save endpoint. `read` on
#     sys/storage/raft/snapshot is what streams the snapshot back to the client
#     (`vault operator raft snapshot save`). NOTHING else — least privilege.
vault policy write snapshot - <<'POLICY'
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
POLICY

# --- Kubernetes-auth role: ONLY the vault-snapshot SA (vault ns) may assume `snapshot`.
#     token_ttl=10m — the job authenticates, saves one snapshot, and exits in seconds;
#     a short TTL keeps the backup identity from lingering (tighter than the 1h siblings).
vault write auth/kubernetes/role/snapshot \
  bound_service_account_names="vault-snapshot" \
  bound_service_account_namespaces="vault" \
  token_policies="snapshot" \
  token_ttl="10m"

echo "OK: snapshot policy + snapshot k8s-auth role created (SA vault-snapshot/vault)."
