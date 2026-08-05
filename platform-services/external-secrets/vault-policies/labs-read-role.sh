#!/usr/bin/env bash
# Lab-hosting Vault READ policy + role update (lab-hosting layer). DRAFTED, NOT
# APPLIED — agents are classifier-gated from prod Vault writes; run this
# yourself, see platform-services/lab-hosting/README.md "Vault: read side vs
# write side".
#
# Grants the SAME platform ESO controller SA (external-secrets/external-secrets,
# the vault-backend ClusterSecretStore's identity — eso-role.sh) read on
# secret/data/labs/* too, so ExternalSecrets in lab-<slug> namespaces
# (templates/externalsecret.yaml in the lab-app chart) can resolve.
#
# WHY A SEPARATE POLICY INSTEAD OF EDITING eso-role.sh IN PLACE: eso-role.sh is
# already applied live (its `vault policy write external-secrets-ro` is a FULL
# REPLACE of that policy's rules, not an append). Adding a labs stanza to that
# file would be correct only if re-run in full; a NEW policy attached as a
# SECOND entry on the SAME role's token_policies is idempotent from either
# script's perspective and never risks a copy-paste drop of the tenants/
# platform paths if only this script is re-run later.
#
# ⚠ `vault write auth/.../role/external-secrets token_policies=...` is a FULL
# REPLACE of that field too — this script names BOTH policies together
# (external-secrets-ro, unchanged, PLUS the new external-secrets-labs-ro) so
# re-running it does not silently drop the tenant/platform grant.
#
# Run inside the Vault pod (already `vault login`'d as root), with the CA env
# (the chart sets VAULT_ADDR but not VAULT_CACERT — see backstage-role.sh header
# for the same note):
#   kubectl -n vault exec -i vault-0 -- \
#     env VAULT_CACERT=/vault/userconfig/vault-server-tls/ca.crt sh < labs-read-role.sh
set -euo pipefail

vault policy write external-secrets-labs-ro - <<'POLICY'
path "secret/data/labs/*" {
  capabilities = ["read"]
}
path "secret/metadata/labs/*" {
  capabilities = ["read", "list"]
}
POLICY

vault write auth/kubernetes/role/external-secrets \
  bound_service_account_names="external-secrets" \
  bound_service_account_namespaces="external-secrets" \
  audience="vault" \
  token_policies="external-secrets-ro,external-secrets-labs-ro" \
  token_ttl="1h"

echo "OK: external-secrets-labs-ro policy created + external-secrets role updated (now carries external-secrets-ro + external-secrets-labs-ro)."
