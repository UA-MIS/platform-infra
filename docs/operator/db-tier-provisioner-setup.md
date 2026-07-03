# DB-tier provisioner setup (ADR-033) — operator runbook

**Audience:** operator, at the DB keyboard (SSH to `ua-mis-db-1`) + a local shell with
`kubectl`/`kubeseal` against the `capstone` cluster.
**Shell:** the LOCAL commands are written **fish-safe** (Clayton's shell — `set`, not
`VAR=`; no heredocs in the outer shell). The commands you paste *on db1* run in `mysql`/
`bash` there and are shell-agnostic.
**When:** one-time, at DB-tier go-live. This mints the scoped MariaDB provisioner login
that **provider-sql** uses (ADR-033) and seals it into `db-tier-mysql-admin`.

> ⚠ **PREREQ — DB tier must be LIVE.** `ua-mis-db-1` is draft PR #29. Until the box is
> provisioned and on the tailnet, provider-sql sits unauthenticated (safe failure mode —
> no `Database`/`User` is created). Do NOT run this until the box is up.
>
> ⚠ **This is a privileged credential** — the focal point of the one-time SRE review
> (ADR-031 §6 / ADR-033). It is **NOT** `root`; it is scoped below.

---

## 0. What you are creating

| | |
| --- | --- |
| MariaDB login | `crossplane_provisioner`, host-restricted to the tailnet `100.64.0.0/10` |
| Privileges | create/drop **databases**, create/drop **users**, and **grant** schema-level privileges to tenant users — **no** `SUPER`/`FILE`/`PROCESS`/`RELOAD`/`SHUTDOWN` |
| Listener | MariaDB bound to the db1 **tailnet IP** so it never listens on the public/LAN NIC |
| Sealed secret | `db-tier-mysql-admin` (ns `crossplane-system`), 4 keys: `endpoint`, `port`, `username`, `password` → `platform-services/crossplane/creds/mysql-admin-creds-sealed.yaml` |

The `endpoint`/`port`/`username`/`password` key names are exactly what provider-sql's
`MySQLConnectionSecret` source reads (`config/providerconfig-sql.yaml`) — verified against
provider-sql v0.15.0 docs.

---

## 1. SSH to db1 and note its tailnet IP

```bash
ssh ops@ua-mis-db-1
tailscale ip -4 | head -1      # -> the 100.64.x.y address; note it as <TSIP>
```

`<TSIP>` is both the MariaDB bind address (§2) and the sealed `endpoint` (§4).

---

## 2. Bind MariaDB to the tailnet interface

By default MariaDB binds `127.0.0.1` — provider-sql (off-box, over the tailnet) cannot
reach it. Bind it to the tailnet IP so it listens **only** there (not the public/LAN NIC).

On db1, edit the server config (path on MariaDB 11.8 / Debian-family):

```bash
sudo sed -i "s/^bind-address.*/bind-address = <TSIP>/" /etc/mysql/mariadb.conf.d/50-server.cnf
sudo grep -n '^bind-address' /etc/mysql/mariadb.conf.d/50-server.cnf   # confirm = <TSIP>
sudo systemctl restart mariadb
ss -ltnp | grep 3306                                                   # confirm LISTEN on <TSIP>:3306
```

> If the box legitimately needs MariaDB on more than one interface, use
> `bind-address = 0.0.0.0` instead — the account host-restriction in §3 + the tailnet
> being the only route to it are then the access controls. Binding to `<TSIP>` is tighter;
> prefer it.

---

## 3. Create the scoped provisioner login + grants

On db1, open a root MariaDB shell and run the SQL. The host `'100.64.0.0/255.192.0.0'` is
CIDR-notation for the `/10` tailnet — the login can connect **only** from a tailnet source.

```bash
sudo mariadb          # (or: sudo mysql) — opens the MariaDB [(none)]> prompt
```

```sql
-- Pick a strong token; you will re-type it in §4 (or read it back with SHOW GRANTS won't reveal it).
CREATE USER 'crossplane_provisioner'@'100.64.0.0/255.192.0.0'
  IDENTIFIED BY '<STRONG_TOKEN>';

-- Least privilege: exactly the schema-level privileges that make up ALL-on-a-schema
-- (so provider-sql's `Grant` of ALL on `<team>_<env>.*` can be delegated) + CREATE/DROP
-- (databases) + CREATE USER (create/drop/rename tenant users). WITH GRANT OPTION lets it
-- delegate what it holds. Deliberately EXCLUDES SUPER/FILE/PROCESS/RELOAD/SHUTDOWN/
-- REPLICATION — this login is NOT root-equivalent.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER,
      CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW,
      CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER, DELETE HISTORY, CREATE USER
  ON *.* TO 'crossplane_provisioner'@'100.64.0.0/255.192.0.0'
  WITH GRANT OPTION;

FLUSH PRIVILEGES;
SHOW GRANTS FOR 'crossplane_provisioner'@'100.64.0.0/255.192.0.0';   -- eyeball: no SUPER
```

Then `\q` to exit the MariaDB shell and `exit` the SSH session.

> **Why not `GRANT ALL PRIVILEGES ON *.*`?** At the GLOBAL level, `ALL PRIVILEGES`
> **includes** `SUPER`, `PROCESS`, `RELOAD`, `SHUTDOWN`, etc. — that is effectively root
> and defeats the "NOT root" requirement. The explicit list above is the correct
> least-privilege grant. (If an audit accepts the broad grant as a temporary bridge, it is
> `GRANT ALL PRIVILEGES ON *.* ... WITH GRANT OPTION`, but understand it is near-root.)

### 3a. Fix: existing provisioner missing `GRANT OPTION` (idempotent re-run)

If `crossplane_provisioner` was already created on this box and tenant `Grant` MRs
(provider-sql's `Grant` resource, which delegates schema privileges to the per-tenant app
user) are failing with `Access denied for user 'crossplane_provisioner'@'...' to database
'<team>_<env>'`, the login is missing `WITH GRANT OPTION`. MySQL's privilege model requires
the grantor to hold `GRANT OPTION` on a privilege before it can hand that privilege to
someone else — without it, `provider-sql` can create the tenant `Database`/`User` fine but
cannot `GRANT` anything on it, since the provisioner would be handing out privileges it does
not itself hold the right to delegate.

`GRANT` is additive and re-running it is safe (it does not revoke privileges already held,
and re-asserting a privilege the user already has is a no-op) — so this is a safe, idempotent
patch on top of §3, not a replacement for it. Run on db1 as admin:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW,
      CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER
  ON *.* TO 'crossplane_provisioner'@'100.64.0.0/255.192.0.0' WITH GRANT OPTION;
FLUSH PRIVILEGES;
```

Verify with `SHOW GRANTS FOR 'crossplane_provisioner'@'100.64.0.0/255.192.0.0';` — the line
should now end `WITH GRANT OPTION`. Still no `SUPER`/`FILE`/`PROCESS`/`RELOAD`/`SHUTDOWN` —
this does not change the "not root" posture, it only lets the provisioner delegate the
schema-level privileges it already holds down to tenant app users, which is the whole point
of an auto-provisioning login.

---

## 4. Seal `db-tier-mysql-admin` (LOCAL shell — **fish**)

Run these locally (repo root of `platform-infra`), against the live cluster's
sealed-secrets controller. **Correct controller coordinates for this cluster:**
`--controller-namespace kube-system --controller-name sealed-secrets-controller`
(bitnami v0.37.0 — see `docs/phase-1-golden-path.md`; this is what `make seal` targets).

```fish
# tailnet IP of db1 (or paste <TSIP> from §1 directly)
set TSIP (ssh ops@ua-mis-db-1 'tailscale ip -4 | head -1')

# read the token WITHOUT it landing in shell history (fish: -s = silent)
read -s -P "crossplane_provisioner password: " DB_PROV_PASS

kubectl create secret generic db-tier-mysql-admin \
    --namespace crossplane-system \
    --from-literal=endpoint=$TSIP \
    --from-literal=port=3306 \
    --from-literal=username=crossplane_provisioner \
    --from-literal=password=$DB_PROV_PASS \
    --dry-run=client -o yaml \
  | kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
      --format yaml > platform-services/crossplane/creds/mysql-admin-creds-sealed.yaml

set -e DB_PROV_PASS      # clear the token from the session
```

This **overwrites** the placeholder `mysql-admin-creds-sealed.yaml` committed by PR #146
with a real, cluster-decryptable seal. Commit it on a branch + PR (do not commit to main
directly; the placeholder → real seal is a normal reviewed change).

> `endpoint` is the bare host (`<TSIP>`); provider-sql appends `:port` from the separate
> `port` key. Keep `port` a string (`3306`) — `--from-literal` stores it as such.

---

## 5. Verify (after ArgoCD syncs the real seal)

```bash
# the SealedSecret decrypts to the Opaque secret with the 4 keys
kubectl -n crossplane-system get secret db-tier-mysql-admin \
  -o jsonpath='{.data}' | tr ',' '\n'      # endpoint/port/username/password present

# provider-sql's ProviderConfig goes Ready (it can now authenticate)
kubectl get providerconfig.mysql.sql.crossplane.io db-tier-mariadb

# a real end-to-end check: a CapstoneTenant with `database: mysql` should produce
# Database/User/Grant MRs that reconcile Ready, and PushSecrets landing in Vault at
# tenants/<team>/<env>/database (ADR-033 contract).
kubectl get database.mysql.sql.crossplane.io,user.mysql.sql.crossplane.io -A
```

If `ProviderConfig` never goes Ready: check the egress path. provider-sql's
`crossplane-system` egress to `<TSIP>:3306` is governed by
`hardening/netpol-controlplane/crossplane-db-cnp.yaml` — but that is **manual-sync gated**
(`platform-netpol-controlplane`) and only DENIES once synced. Confirm with Hubble
(`hubble observe --namespace crossplane-system --port 3306`) during the DB-tier deny-test.

---

## 6. Postgres tier (ADR-033 parity) — provisioner role on the SAME box

`ua-mis-db-1` also runs **PG17** alongside MariaDB. A tenant that picks `database: postgres`
is provisioned by the **same** provider-sql controller through a **second** ProviderConfig
(`db-tier-postgres`, `config/providerconfig-postgres.yaml`) reading a **separate** sealed
secret `db-tier-postgres-admin`. This section mints the scoped Postgres provisioner role
and seals it. **Do this only after §1–5** (the box must be live on the tailnet).

| | |
| --- | --- |
| Postgres role | `crossplane_provisioner` — attributes **`LOGIN CREATEDB CREATEROLE`**, **NOT** `SUPERUSER` |
| Why those two | `CREATEDB` = create/drop tenant databases; `CREATEROLE` = create/drop tenant login roles AND (CREATEROLE auto-grants membership in roles it creates) assign each tenant DB's ownership to its role + delegate privileges. Excludes SUPERUSER/REPLICATION/BYPASSRLS |
| Listener | `listen_addresses` includes the db1 **tailnet IP** (`<TSIP>`); never the public/LAN NIC |
| Host auth | one `pg_hba.conf` line scoping the role to the tailnet CIDR `100.64.0.0/10` |
| Sealed secret | `db-tier-postgres-admin` (ns `crossplane-system`), 4 keys `endpoint`/`port`(**5432**)/`username`/`password` → `platform-services/crossplane/creds/postgres-admin-creds-sealed.yaml` |

The `endpoint`/`port`/`username`/`password` key names are exactly what provider-sql's
`PostgreSQLConnectionSecret` source reads (`config/providerconfig-postgres.yaml`, which also
sets `defaultDatabase: postgres` + `sslMode: disable` — the tailnet is the transport
boundary, same as MariaDB).

### 6a. Bind PG17 to the tailnet + allow the tailnet CIDR (on db1)

```bash
# listen on localhost + the tailnet IP only (adjust the conf path for your PG17 install)
sudo sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost,<TSIP>'/" \
  /etc/postgresql/17/main/postgresql.conf
sudo grep -n '^listen_addresses' /etc/postgresql/17/main/postgresql.conf   # confirm

# host-auth: the provisioner role, any db, only from the tailnet CIDR, scram password.
echo "host  all  crossplane_provisioner  100.64.0.0/10  scram-sha-256" \
  | sudo tee -a /etc/postgresql/17/main/pg_hba.conf
sudo systemctl restart postgresql
ss -ltnp | grep 5432                                                       # LISTEN on <TSIP>:5432
```

### 6b. Create the scoped provisioner role (on db1)

```bash
sudo -u postgres psql
```

```sql
-- Pick a strong token; you will re-type it in §6c.
-- LOGIN + CREATEDB + CREATEROLE only. NOT SUPERUSER (which would ignore pg_hba host
-- restriction AND every privilege check — that is root-equivalent and defeats "NOT root").
CREATE ROLE crossplane_provisioner LOGIN CREATEDB CREATEROLE PASSWORD '<STRONG_TOKEN>';

-- eyeball: rolsuper = f, rolcreatedb = t, rolcreaterole = t
\du crossplane_provisioner
\q
```

> **Why not `SUPERUSER`?** A superuser bypasses `pg_hba.conf` host scoping and all
> privilege checks — effectively root. `CREATEDB CREATEROLE` is the correct least-privilege
> grant for a provisioner that only mints per-tenant `Database` + `Role` + `Grant`.

### 6c. Seal `db-tier-postgres-admin` (LOCAL shell — **fish**)

Same controller coordinates as §4 (`--controller-namespace kube-system --controller-name
sealed-secrets-controller`). Note **port 5432**.

```fish
set TSIP (ssh ops@ua-mis-db-1 'tailscale ip -4 | head -1')
read -s -P "crossplane_provisioner (postgres) password: " PG_PROV_PASS

kubectl create secret generic db-tier-postgres-admin \
    --namespace crossplane-system \
    --from-literal=endpoint=$TSIP \
    --from-literal=port=5432 \
    --from-literal=username=crossplane_provisioner \
    --from-literal=password=$PG_PROV_PASS \
    --dry-run=client -o yaml \
  | kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
      --format yaml > platform-services/crossplane/creds/postgres-admin-creds-sealed.yaml

set -e PG_PROV_PASS
```

This **overwrites** the placeholder `postgres-admin-creds-sealed.yaml` with a real,
cluster-decryptable seal. Commit on a branch + PR (never straight to main).

### 6d. Verify (after ArgoCD syncs the real seal)

```bash
kubectl -n crossplane-system get secret db-tier-postgres-admin -o jsonpath='{.data}' | tr ',' '\n'
kubectl get providerconfig.postgresql.sql.crossplane.io db-tier-postgres
# end-to-end: a CapstoneTenant with `database: postgres` -> Database/Role/Grant MRs Ready +
# PushSecrets landing in Vault at tenants/<team>/<env>/database (SAME leaf as mysql).
kubectl get database.postgresql.sql.crossplane.io,role.postgresql.sql.crossplane.io -A
```

Egress: the SAME `crossplane-db-cnp.yaml` policy governs it (one provider-sql pod); it now
allows **TCP/5432** in addition to 3306. Confirm with `hubble observe --namespace
crossplane-system --port 5432` during the DB-tier deny-test.

---

## Cross-refs

- ADR: `artifacts/design/decisions/adr-033-auto-database-provisioning.md`
- MySQL provider + ProviderConfig + placeholder cred: `platform-services/crossplane/{providers/provider-sql.yaml,config/providerconfig-sql.yaml,creds/mysql-admin-creds-sealed.yaml}`
- Postgres ProviderConfig + placeholder cred: `platform-services/crossplane/{config/providerconfig-postgres.yaml,creds/postgres-admin-creds-sealed.yaml}`
- Egress netpol (3306 + 5432): `hardening/netpol-controlplane/crossplane-db-cnp.yaml`
- Consumer contract (DB templates read `tenants/<team>/<env>/database`, scheme by engine): ADR-033 §"Vault path contract"
