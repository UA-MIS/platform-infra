# Crossplane provider credentials — ⚠ SECURITY: one-time SRE review + reseal

These `SealedSecret`s carry the Crossplane providers' admin credentials
(provider-kubernetes uses in-cluster `InjectedIdentity`, so it needs no secret —
see `config/providerconfig-kubernetes.yaml`). They are the **only** privileged
credentials in the whole onboarding stack and they live **only** in
`crossplane-system` (never in Backstage, never with humans), per ADR-031 §6.
`mysql-admin-creds-sealed.yaml` is the ADR-033 addition (the DB-tier provisioner).

> **⚠ SECURITY FLAG (for the one-time SRE review, ADR-031 constraint #4).** The
> ciphertext committed here is a **PLACEHOLDER** (the same pattern as PR #120's
> ArgoCD repo-creds). It will NOT decrypt. Before go-live the operator must reseal
> each with the REAL scoped credential against the live cluster's sealed-secrets
> controller. **Until then the providers will sit unauthenticated (not reconciling)
> — which is the safe failure mode.** Agents cannot reach the cluster to seal; this
> is the operator's keyboard (matches the platform's "agents can't do cluster
> writes" classifier gate).

## What each one is (and the least-privilege scope to grant)

| File | Secret (crossplane-system) | Credential — scope to grant (NOT admin) |
| --- | --- | --- |
| `github-app-creds-sealed.yaml` | `github-provider-creds` | the EXISTING `ua-mis-backstage` GitHub App (App ID 4097147, install 141394298). JSON: `{"app_auth":[{"id":"4097147","installation_id":"141394298","pem_file":"<PEM \n-escaped>"}],"owner":"UA-MIS"}` |
| `harbor-provisioner-creds-sealed.yaml` | `harbor-provider-creds` | a Harbor PROVISIONER ROBOT — project + robot + member admin ONLY (derive from harbor-admin; do NOT use harbor-admin itself). JSON: `{"url":"https://harbor-core.harbor.svc","username":"robot$provisioner","password":"<token>"}` |
| `vault-provisioner-creds-sealed.yaml` | `vault-provider-creds` | a Vault token with a `tenant-provisioner` policy: write `sys/policies/acl/tenant-*` + `auth/kubernetes/role/tenant-*` ONLY. JSON: `{"token":"<token>","address":"https://vault.vault.svc.cluster.local:8200"}` |
| `mysql-admin-creds-sealed.yaml` (ADR-033) | `db-tier-mysql-admin` | a DB-tier MariaDB PROVISIONER LOGIN — **NOT** `root`. CREATE/DROP DATABASE + CREATE/DROP USER + GRANT OPTION on `<team>_<env>` ONLY. **Four keys** (NOT a JSON blob): `endpoint`=`<ua-mis-db-1 tailnet addr>:`, `port`=`3306`, `username`=`crossplane_provisioner`, `password`=`<token>`. provider-sql reads these via `MySQLConnectionSecret` (config/providerconfig-sql.yaml). |
| `postgres-admin-creds-sealed.yaml` (ADR-033) | `db-tier-postgres-admin` | a DB-tier **PG17** PROVISIONER ROLE — **NOT** `postgres` superuser. `LOGIN CREATEDB CREATEROLE` ONLY (no `SUPERUSER`/`REPLICATION`/`BYPASSRLS`). **Four keys**: `endpoint`=`<ua-mis-db-1 tailnet addr>`, `port`=`5432`, `username`=`crossplane_provisioner`, `password`=`<token>`. provider-sql reads these via `PostgreSQLConnectionSecret` (config/providerconfig-postgres.yaml). Reseal: `docs/operator/db-tier-provisioner-setup.md` §6. |

## Resealing the real values (operator, at go-live)

```bash
# Example: GitHub App creds. Build the JSON, seal it for crossplane-system, replace the stub.
PEM=$(awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' ua-mis-backstage.pem)   # \n-escape the key
cat > /tmp/gh.json <<EOF
{"app_auth":[{"id":"4097147","installation_id":"141394298","pem_file":"${PEM}"}],"owner":"UA-MIS"}
EOF
kubectl create secret generic github-provider-creds \
  --namespace crossplane-system --from-file=credentials=/tmp/gh.json \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace sealed-secrets --controller-name sealed-secrets \
    --format yaml > platform-services/crossplane/creds/github-app-creds-sealed.yaml
rm -f /tmp/gh.json
# Repeat for harbor-provider-creds and vault-provider-creds with their scoped values.
```

The `tenant-provisioner` Vault policy (run once, alongside the ESO/tenant policies
in `platform-services/external-secrets/vault-policies/`):

```hcl
# secret/data/tenants/* is read by ESO; the PROVISIONER only manages policy + k8s roles.
path "sys/policies/acl/tenant-*"        { capabilities = ["create","update","read","delete"] }
path "auth/kubernetes/role/tenant-*"    { capabilities = ["create","update","read","delete"] }
```

## DB-tier MariaDB provisioner login (ADR-033, operator at go-live)

Mint the scoped provisioner login on `ua-mis-db-1` (over the Tailscale SSH session,
DB-tier runbook §2). **Do NOT use `root`** as the provider credential. The login needs
just enough to mint per-tenant `Database` + `User` + `Grant` and nothing else:

```sql
-- run as root on ua-mis-db-1 (MariaDB 11.8). Bind the account to the tailnet CIDR.
CREATE USER 'crossplane_provisioner'@'100.64.0.0/255.192.0.0'
  IDENTIFIED BY '<STRONG_TOKEN>';
-- CREATE/DROP DATABASE, CREATE/DROP USER, and the ability to GRANT what it holds.
-- GRANT OPTION + ALL on *.* is the simplest least-effort grant that still excludes
-- SUPER/admin; tighten to `GRANT CREATE, DROP, GRANT OPTION ON *.*` + per-schema ALL
-- if your audit prefers (provider-sql Grant uses ALL PRIVILEGES on the tenant schema).
GRANT ALL PRIVILEGES ON *.* TO 'crossplane_provisioner'@'100.64.0.0/255.192.0.0'
  WITH GRANT OPTION;
FLUSH PRIVILEGES;
```

Then seal the four connection keys into `db-tier-mysql-admin` for crossplane-system:

```bash
TSIP=$(ssh ops@ua-mis-db-1 'tailscale ip -4 | head -1')   # the ua-mis-db-1 tailnet IP
kubectl create secret generic db-tier-mysql-admin \
  --namespace crossplane-system \
  --from-literal=endpoint="${TSIP}" \
  --from-literal=port="3306" \
  --from-literal=username="crossplane_provisioner" \
  --from-literal=password="<STRONG_TOKEN>" \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace sealed-secrets --controller-name sealed-secrets \
    --format yaml > platform-services/crossplane/creds/mysql-admin-creds-sealed.yaml
```
