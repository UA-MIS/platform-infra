#!/usr/bin/env bash
# ESO Vault policy + Kubernetes-auth role (ADR-030 B1, runbook step 7).
# Run AFTER `vault auth enable kubernetes` (vault/README.md §D). Binds the
# PLATFORM ESO ServiceAccount (external-secrets/external-secrets) to a read-only
# policy over the tenant + platform secret subtrees, so the ClusterSecretStore
# (vault-backend) can resolve ExternalSecrets cluster-wide.
#
# Run inside the Vault pod (already `vault login`'d as root), e.g.:
#   kubectl -n vault exec -i vault-0 -- sh < eso-role.sh
set -euo pipefail

# --- Policy: read-only on the KV v2 data + metadata under tenants/* and platform/*.
#     KV v2 paths are secret/DATA/... and secret/METADATA/... (the engine split).
vault policy write external-secrets-ro - <<'POLICY'
path "secret/data/tenants/*" {
  capabilities = ["read"]
}
path "secret/metadata/tenants/*" {
  capabilities = ["read", "list"]
}
path "secret/data/platform/*" {
  capabilities = ["read"]
}
path "secret/metadata/platform/*" {
  capabilities = ["read", "list"]
}
POLICY

# --- Kubernetes-auth role: only the ESO controller SA may assume this policy.
#     `audience: vault` matches the ClusterSecretStore serviceAccountRef.audiences.
vault write auth/kubernetes/role/external-secrets \
  bound_service_account_names="external-secrets" \
  bound_service_account_namespaces="external-secrets" \
  audience="vault" \
  token_policies="external-secrets-ro" \
  token_ttl="1h"

echo "OK: external-secrets-ro policy + external-secrets k8s-auth role created."
