#!/usr/bin/env bash
# Per-tenant Vault policy + Kubernetes-auth role (ADR-030 B1, per-namespace
# isolation, deliverable #5). Creates a policy scoped to ONE tenant's path and a
# k8s-auth role bound to that tenant's eso-tenant ServiceAccount — so a tenant SA
# can read ONLY secret/data/tenants/<team>/* and nothing else (least privilege,
# D-048 spine). Pairs with the per-namespace SecretStore in secretstore-template.yaml.
#
# Usage (inside the Vault pod, logged in as root or a platform-admin token):
#   ./tenant-role.sh <team> <env>            # env optional; role is per-team
#   e.g.  kubectl -n vault exec -i vault-0 -- sh -s -- sample dev < tenant-role.sh
set -euo pipefail

TEAM="${1:?usage: tenant-role.sh <team> [<env>]}"
ENV="${2:-}"   # informational; the role grants the whole tenant subtree across envs

# --- Policy: read-only, scoped to THIS tenant's subtree ONLY.
vault policy write "tenant-${TEAM}-ro" - <<POLICY
path "secret/data/tenants/${TEAM}/*" {
  capabilities = ["read"]
}
path "secret/metadata/tenants/${TEAM}/*" {
  capabilities = ["read", "list"]
}
POLICY

# --- k8s-auth role: only the tenant's eso-tenant SA, in any of that team's
#     <team>-<env> namespaces, may assume the scoped policy. List the namespaces the
#     team owns (dev/staging/prod/preview) — a tenant SA in another ns cannot bind.
vault write "auth/kubernetes/role/tenant-${TEAM}" \
  bound_service_account_names="eso-tenant" \
  bound_service_account_namespaces="${TEAM}-dev,${TEAM}-staging,${TEAM}-prod,${TEAM}-preview" \
  audience="vault" \
  token_policies="tenant-${TEAM}-ro" \
  token_ttl="1h"

echo "OK: tenant-${TEAM}-ro policy + tenant-${TEAM} k8s-auth role created (env hint: ${ENV:-n/a})."
