#!/usr/bin/env bash
# Backstage secrets-UX Vault WRITE policy + Kubernetes-auth role (ADR-030 B1, #108).
# Backs the Backstage secrets-UX: the Backstage backend writes tenant secret VALUES
# into Vault over the HTTP KV-v2 API (PATCH merge-patch; null = single-key delete) so
# NOTHING lands in git — the scaffolder commits only ExternalSecret name+remoteRef
# declarations.
#
# Distinct from eso-role.sh (READ-ONLY, ESO controller). THIS is the only WRITE
# identity into secret/data/tenants/*. The grant is intentionally COARSE (one writer
# token can write any tenant path); per-tenant authorization is enforced in the
# Backstage app layer (capstone.secret.seal owner re-check BEFORE every write, #105
# authz spine) — that re-check IS the per-tenant boundary. Flag to security review.
#
# Names match #108's committed config (app-config.production.yaml): role + policy
# `backstage-writer`, SA `backstage-vault-writer` in ns `backstage`.
#
# Run AFTER `vault auth enable kubernetes` (vault/README.md §D), inside the Vault pod
# (already `vault login`'d as root). ⚠ the chart sets VAULT_ADDR but NOT VAULT_CACERT,
# so every in-pod vault cmd needs the CA — use the env-prefixed pipe:
#   kubectl -n vault exec -i vault-0 -- \
#     env VAULT_CACERT=/vault/userconfig/vault-server-tls/ca.crt sh < backstage-role.sh
set -euo pipefail

# --- Policy: WRITE (NO read on data) scoped to the tenant subtree.
#     KV v2 PATCH (merge-patch) needs the `patch` capability EXPLICITLY (separate
#     from create/update); create+update cover the first-write POST fallback to a
#     fresh path. NO `read` on data (least privilege — the UX never reads values
#     back; merge-patch set + {KEY:null} delete-key both work without read). NO
#     `delete` (single-key removal is merge-patch null, not a destroy). metadata
#     read/list supports key-name enumeration without exposing values.
vault policy write backstage-writer - <<'POLICY'
path "secret/data/tenants/*" {
  capabilities = ["create", "update", "patch"]
}
path "secret/metadata/tenants/*" {
  capabilities = ["read", "list"]
}
POLICY

# --- Kubernetes-auth role: ONLY the Backstage backend SA (backstage-vault-writer in
#     the backstage ns) may assume this policy. NOT the `default` SA — binding default
#     would grant write-any-tenant to every pod in the backstage ns.
#     ⚠ `audience: vault` MUST match the audience of the JWT Backstage presents at
#     login. The DEFAULT SA token's audience is the apiserver, NOT vault, so the
#     Backstage Deployment mounts a PROJECTED serviceAccountToken volume with
#     audience: vault and reads THAT token (/var/run/secrets/vault/vault-token), not
#     the default token. (See the backstage-process-app.yaml deploy wiring.)
vault write auth/kubernetes/role/backstage-writer \
  bound_service_account_names="backstage-vault-writer" \
  bound_service_account_namespaces="backstage" \
  audience="vault" \
  token_policies="backstage-writer" \
  token_ttl="1h"

echo "OK: backstage-writer policy + backstage-writer k8s-auth role created (SA backstage-vault-writer/backstage)."
