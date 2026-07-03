#!/usr/bin/env bash
# Crossplane writer Vault policy + Kubernetes-auth role (ADR-031 §10, CXP-4).
# The COUNTERPART to eso-role.sh (read-only). This is the ONLY write identity the
# Crossplane onboarding plane uses: the Composition's per-tenant PushSecrets write
# the Harbor robot creds into Vault at secret/data/tenants/<team>/... via the
# crossplane-system SecretStore `vault-push` (config/vault-push-secretstore.yaml),
# which authenticates as SA `eso-vault-push` through the k8s-auth role created here.
#
# Committed (was prose-only) so the SRE can review the EXACT grant: create/read/
# update on secret/data/tenants/* AND secret/metadata/tenants/* — NO delete, NO
# other paths. `read` is NOT optional here even though this is a "writer" identity:
# ESO's Vault PushSecret provider is documented as requiring create+read+update on
# BOTH the data and metadata subpaths (https://external-secrets.io/latest/provider/
# hashicorp-vault) — it GETs the existing KV v2 secret first (data) and its version
# (metadata) to read-modify-write/CAS the merged value, since Vault's HTTP API has
# no partial-field PUT. Confirmed root cause of a live 403: "could not write remote
# ref ... GET .../v1/secret/data/tenants/<team>/<env>/<leaf> Code: 403". A
# compromise of this identity CAN now read tenant secrets under tenants/* (it
# could not before) — that's the necessary trade-off for KV v2 PushSecret, not a
# scope leak: it is still confined to tenants/* only, same as before.
#
# Run inside the Vault pod (already `vault login`'d as root), e.g.:
#   kubectl -n vault exec -i vault-0 -- sh < crossplane-push-role.sh
set -euo pipefail

# --- Policy: create/read/update on the KV v2 DATA + METADATA under tenants/*.
#     create = first POST to a fresh path; update = overwrite existing; read = the
#     read-modify-write / CAS-version lookup PushSecret does before every write.
#     NO delete, NO other engine paths. Least privilege short of what ESO requires.
vault policy write crossplane-push - <<'POLICY'
path "secret/data/tenants/*" {
  capabilities = ["create", "read", "update"]
}
path "secret/metadata/tenants/*" {
  capabilities = ["create", "read", "update"]
}
POLICY

# --- Kubernetes-auth role: only the dedicated writer SA may assume this policy.
#     `audience: vault` matches the SecretStore serviceAccountRef.audiences
#     (config/vault-push-secretstore.yaml).
vault write auth/kubernetes/role/crossplane-push \
  bound_service_account_names="eso-vault-push" \
  bound_service_account_namespaces="crossplane-system" \
  audience="vault" \
  token_policies="crossplane-push" \
  token_ttl="1h"

echo "OK: crossplane-push policy + crossplane-push k8s-auth role created."
