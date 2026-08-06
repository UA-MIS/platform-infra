#!/usr/bin/env bash
# Lab-hosting Vault WRITE policy + role for the SLIDES app (lab-hosting layer).
# DRAFTED, NOT APPLIED — same classifier gate as labs-read-role.sh; see
# platform-services/lab-hosting/README.md "Vault: read side vs write side".
#
# Mirrors backstage-role.sh EXACTLY (same shape: WRITE-only, no read-back,
# scoped-path, dedicated k8s-auth role bound to ONE named SA in ONE namespace).
# The slides backend writes each student's DB credentials to
# secret/labs/<labSlug>/<username> (keys: DATABASE_URL, DB_HOST, DB_NAME,
# DB_USER, DB_PASSWORD — see chart/templates/externalsecret.yaml for the read
# side) the same way the Backstage backend writes tenant secret values: PATCH
# merge-patch over Vault's HTTP KV-v2 API, nothing in git.
#
# THIS PR DOES NOT MODIFY THE SLIDEDECK REPO. Wiring the slides backend to
# actually call Vault with this role (a projected serviceAccountToken volume
# audience:vault, same pattern backstage-process-app.yaml uses — see
# backstage-role.sh's own header) is a slidedeck-repo change, out of scope here.
# This script only stands up the Vault-side identity slides will authenticate as
# once that wiring lands — see README "OPERATOR ACTIONS" for sequencing.
#
# Run inside the Vault pod (already `vault login`'d as root), with the CA env:
#   kubectl -n vault exec -i vault-0 -- \
#     env VAULT_CACERT=/vault/userconfig/vault-server-tls/ca.crt sh < slides-labs-writer-role.sh
set -euo pipefail

# --- Policy: WRITE (NO read on data) scoped to secret/labs/*. Same capability
#     set as backstage-writer (create+update+patch, metadata read/list only,
#     NO delete — a single-key removal is a merge-patch {KEY:null}, not destroy).
vault policy write slides-labs-writer - <<'POLICY'
path "secret/data/labs/*" {
  capabilities = ["create", "update", "patch"]
}
path "secret/metadata/labs/*" {
  capabilities = ["read", "list"]
}
POLICY

# --- Kubernetes-auth role: ONLY the slides backend's dedicated writer SA (NOT
#     the default SA in ns `slides` — binding default would grant
#     write-any-lab-student-creds to every pod in that namespace, including the
#     lab-mariadb/adminer workloads already there). SA name mirrors
#     backstage-vault-writer's naming convention (<app>-vault-writer).
vault write auth/kubernetes/role/slides-labs-writer \
  bound_service_account_names="slides-vault-writer" \
  bound_service_account_namespaces="slides" \
  audience="vault" \
  token_policies="slides-labs-writer" \
  token_ttl="1h"

echo "OK: slides-labs-writer policy + slides-labs-writer k8s-auth role created (SA slides-vault-writer/slides)."
