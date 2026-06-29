#!/usr/bin/env bash
# Crossplane writer Vault policy + Kubernetes-auth role (ADR-031 §10, CXP-4).
# The COUNTERPART to eso-role.sh (read-only). This is the ONLY write identity the
# Crossplane onboarding plane uses: the Composition's per-tenant PushSecrets write
# the Harbor robot creds into Vault at secret/data/tenants/<team>/... via the
# crossplane-system SecretStore `vault-push` (config/vault-push-secretstore.yaml),
# which authenticates as SA `eso-vault-push` through the k8s-auth role created here.
#
# Committed (was prose-only) so the SRE can review the EXACT grant: WRITE
# (create/update) on secret/data/tenants/* ONLY — NO read of app secrets, NO
# metadata, NO other paths. A compromise of this identity can overwrite tenant
# robot creds but cannot READ any tenant/platform secret.
#
# Run inside the Vault pod (already `vault login`'d as root), e.g.:
#   kubectl -n vault exec -i vault-0 -- sh < crossplane-push-role.sh
set -euo pipefail

# --- Policy: WRITE-ONLY on the KV v2 DATA under tenants/*. create = first POST to a
#     fresh path; update = overwrite existing. NO read (the writer never reads values
#     back), NO metadata, NO delete, NO other engine paths. Least privilege.
vault policy write crossplane-push - <<'POLICY'
path "secret/data/tenants/*" {
  capabilities = ["create", "update"]
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
