# Crossplane provider credentials — ⚠ SECURITY: one-time SRE review + reseal

These `SealedSecret`s carry the Crossplane providers' admin credentials
(provider-kubernetes uses in-cluster `InjectedIdentity`, so it needs no secret —
see `config/providerconfig-kubernetes.yaml`). They are the **only** privileged
credentials in the whole onboarding stack and they live **only** in
`crossplane-system` (never in Backstage, never with humans), per ADR-031 §6.
`mysql-admin-creds-sealed.yaml` is the ADR-033 addition (the DB-tier provisioner).

> **⚠ SECURITY FLAG (for the one-time SRE review, ADR-031 constraint #4).**
> `github-app-creds-sealed.yaml`, `harbor-provisioner-creds-sealed.yaml`, and
> `vault-provisioner-creds-sealed.yaml` still carry **PLACEHOLDER** ciphertext (the
> same pattern as PR #120's ArgoCD repo-creds) — they will NOT decrypt, and the
> providers they configure sit unauthenticated (not reconciling — the safe failure
> mode) until the operator reseals each with a REAL scoped credential against the
> live cluster's sealed-secrets controller. `mysql-admin-creds-sealed.yaml` and
> `postgres-admin-creds-sealed.yaml` **are now resealed with real in-cluster
> credentials** (docs/operator/in-cluster-db-tier-runbook.md §4c) — see their rows
> below for the current target. Agents cannot reach the cluster to seal on their
> own initiative; this is normally the operator's keyboard (matches the platform's
> "agents can't do cluster writes" classifier gate) — the DB-tier reseal above was
> done under explicit operator-supplied live-access instructions for this cutover.

## What each one is (and the least-privilege scope to grant)

| File | Secret (crossplane-system) | Credential — scope to grant (NOT admin) |
| --- | --- | --- |
| `github-app-creds-sealed.yaml` | `github-provider-creds` | the EXISTING `ua-mis-backstage` GitHub App (App ID 4097147, install 141394298). JSON: `{"app_auth":[{"id":"4097147","installation_id":"141394298","pem_file":"<PEM \n-escaped>"}],"owner":"UA-MIS"}` |
| `harbor-provisioner-creds-sealed.yaml` | `harbor-provider-creds` | a Harbor PROVISIONER ROBOT — project + robot + member admin ONLY (derive from harbor-admin; do NOT use harbor-admin itself). JSON: `{"url":"https://harbor-core.harbor.svc","username":"robot$provisioner","password":"<token>"}` |
| `vault-provisioner-creds-sealed.yaml` | `vault-provider-creds` | a Vault token with a `tenant-provisioner` policy: write `sys/policies/acl/tenant-*` + `auth/kubernetes/role/tenant-*`, plus `auth/token/create` (provider-vault mints a short-lived child token per call — see below). JSON: `{"token":"<token>","address":"https://vault.vault.svc.cluster.local:8200"}` |
| `mysql-admin-creds-sealed.yaml` (ADR-033) | `db-tier-mysql-admin` | **RESEALED — IN-CLUSTER (docs/operator/in-cluster-db-tier-runbook.md §4c).** A DB-tier MariaDB PROVISIONER LOGIN — **NOT** `root`. The in-cluster `crossplane-provisioner` mariadb-operator User/Grant (`applicationsets/mariadb-cluster-app.yaml`) — same least-privilege grant list as the retired off-box login (excludes SUPER/FILE/PROCESS/RELOAD/SHUTDOWN). **Four keys** (NOT a JSON blob): `endpoint`=`capstone-mariadb-mariadb-cluster-primary.db-tier.svc.cluster.local`, `port`=`3306`, `username`=`crossplane-provisioner`, `password`=`<token, matches secret db-tier/mariadb-crossplane-provisioner-credentials>`. provider-sql reads these via `MySQLConnectionSecret` (config/providerconfig-sql.yaml). |
| `postgres-admin-creds-sealed.yaml` (ADR-033) | `db-tier-postgres-admin` | **RESEALED — IN-CLUSTER (docs/operator/in-cluster-db-tier-runbook.md §4c).** A DB-tier **PG17** PROVISIONER ROLE — **NOT** `postgres` superuser. The in-cluster `crossplane_provisioner` CNPG DatabaseRole (`platform-services/cnpg/cluster/roles.yaml`) — `LOGIN CREATEDB CREATEROLE` ONLY (no `SUPERUSER`/`REPLICATION`/`BYPASSRLS`). **Four keys**: `endpoint`=`capstone-pg-rw.db-tier.svc.cluster.local`, `port`=`5432`, `username`=`crossplane_provisioner`, `password`=`<token, matches secret db-tier/cnpg-crossplane-provisioner-credentials>`. provider-sql reads these via `PostgreSQLConnectionSecret` (config/providerconfig-postgres.yaml). No live Postgres tenant exists yet — this reseal activates reconciliation for the first time with no prior state. |

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
| kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
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
# provider-vault is Upjet over hashicorp/terraform-provider-vault: given a static
# token, that provider mints a short-lived CHILD token per API call (skip_child_token
# would avoid this but the upstream docs discourage it — it keeps the long-lived
# primary token in play on every request instead). Without this the provider's
# `observe` fails: "failed to create limited child token". A Vault child token can
# only ever be minted with a SUBSET of its parent's policies, so granting this here
# does not widen the token's blast radius beyond tenant-*.
path "auth/token/create" { capabilities = ["create","update"] }
```

## DB-tier MariaDB provisioner login (ADR-033, operator at go-live)

Mint the scoped provisioner login on `ua-mis-db-1` (over the Tailscale SSH session,
DB-tier runbook §2). **Do NOT use `root`** as the provider credential. The login needs
just enough to mint per-tenant `Database` + `User` + `Grant` and nothing else:

```sql
-- run as root on ua-mis-db-1 (MariaDB 11.8). Bind the account to the tailnet CIDR.
CREATE USER 'crossplane_provisioner'@'100.64.0.0/255.192.0.0'
  IDENTIFIED BY '<STRONG_TOKEN>';
-- Least privilege = the explicit schema-level privilege list (CREATE/DROP DATABASE,
-- CREATE USER, and ALL-on-a-schema so provider-sql's `Grant` can be delegated), NOT
-- `GRANT ALL PRIVILEGES ON *.*`. ⚠ At the GLOBAL level `ALL PRIVILEGES` INCLUDES
-- SUPER/PROCESS/RELOAD/SHUTDOWN — it is near-root and does NOT exclude SUPER. Use the
-- canonical explicit grant in docs/operator/db-tier-provisioner-setup.md §3 (the
-- authoritative, deliberately SUPER-free list) — do not use the broad `*.*` grant.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER,
      CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW,
      CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER, DELETE HISTORY, CREATE USER
  ON *.* TO 'crossplane_provisioner'@'100.64.0.0/255.192.0.0'
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
| kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
    --format yaml > platform-services/crossplane/creds/mysql-admin-creds-sealed.yaml
```
