# DB-tier runbook — `ua-mis-db-1` (Debian 13, D-029)

Dedicated, off-cluster data tier (D-029): a real DB host SEPARATE from the k8s
cluster, multi-engine (Postgres + MySQL-compatible), reachable over the Tailscale
overlay. **db-1 comes up as a standalone primary with backups NOW;** Patroni 2-node
failover is a deliberate LATER sub-step (after db-2 joins post-CMOS-swap).

> **Host state (confirmed):** Debian 13.5, hostname `ua-mis-db-1`, user `ops` (sudo),
> Tailscale up (`--hostname=ua-mis-db-1`, personal tailnet). Reachable:
> `ssh ops@ua-mis-db-1`. All steps are copy-paste over that SSH session.
>
> **Trixie versions (verified):** PostgreSQL **17**, MariaDB **11.8** (Debian's
> default MySQL-compatible server). pgBackRest from the Trixie repo.

---

## 0. Pre-flight + find the Tailscale IP
```bash
ssh ops@ua-mis-db-1
ip -4 addr show tailscale0 | awk '/inet/{print $2}'   # note the 100.x TS IP -> $TSIP
tailscale ip -4                                        # same; the address DBs will bind to
sudo sysctl -w vm.swappiness=1 && echo 'vm.swappiness=1' | sudo tee /etc/sysctl.d/99-db.conf
```
> All DB services bind to the **Tailscale IP**, never 0.0.0.0 — the tailnet is the
> only network path in (the LAN side is not exposed).

## 1. PostgreSQL 17
```bash
sudo apt update && sudo apt install -y postgresql-17 postgresql-client-17
# Bind to loopback + the Tailscale IP only:
TSIP=$(tailscale ip -4 | head -1)
sudo sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost,${TSIP}'/" \
  /etc/postgresql/17/main/postgresql.conf
# Allow tailnet clients (CIDR 100.64.0.0/10) with scram auth:
echo "host all all 100.64.0.0/10 scram-sha-256" | sudo tee -a /etc/postgresql/17/main/pg_hba.conf
sudo sed -i "s/^#\?password_encryption.*/password_encryption = scram-sha-256/" \
  /etc/postgresql/17/main/postgresql.conf
sudo systemctl restart postgresql
# WAL for PITR (pgBackRest reads these settings):
sudo -u postgres psql -c "ALTER SYSTEM SET wal_level = 'replica';"
sudo -u postgres psql -c "ALTER SYSTEM SET archive_mode = 'on';"
sudo -u postgres psql -c "ALTER SYSTEM SET archive_command = 'pgbackrest --stanza=db1 archive-push %p';"
sudo systemctl restart postgresql
sudo -u postgres psql -c "SELECT version();"          # verify 17
```

## 2. MySQL-compatible engine — MariaDB 11.8 (Debian default)
> D-029 is engine-agnostic. MariaDB is the Debian-native MySQL-compatible server
> (zero extra repos) — use it unless a team specifically needs Oracle MySQL (then
> add the MySQL APT repo: https://dev.mysql.com/downloads/repo/apt/ — note it +
> skip this block). Default = MariaDB.
```bash
sudo apt install -y mariadb-server mariadb-client
TSIP=$(tailscale ip -4 | head -1)
sudo tee /etc/mysql/mariadb.conf.d/99-bind.cnf >/dev/null <<EOF
[mysqld]
bind-address = 127.0.0.1,${TSIP}
EOF
sudo systemctl restart mariadb
sudo mysql_secure_installation        # set root pw, remove anon users/test db, disallow remote root
sudo mariadb -e "SELECT VERSION();"   # verify 11.8
```

## 3. pgBackRest — base + WAL/PITR backups
```bash
sudo apt install -y pgbackrest
# Backup target: LOCAL for now (D-029: off-box/Ceph-RGW later). Placeholder repo dir:
sudo install -d -o postgres -g postgres /var/lib/pgbackrest
sudo tee /etc/pgbackrest/pgbackrest.conf >/dev/null <<'EOF'
[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
start-fast=y
[db1]
pg1-path=/var/lib/postgresql/17/main
EOF
# (archive_command in step 1 already points at stanza db1.)
sudo -u postgres pgbackrest --stanza=db1 stanza-create
sudo -u postgres pgbackrest --stanza=db1 --type=full backup
sudo -u postgres pgbackrest --stanza=db1 check          # verify archive + backup OK
```
> LATER: re-point `repo1-path` → an off-box target (Ceph RGW / S3) once the cluster's
> object store is up — D-029 wants backups OFF the DB host. Schedule full+diff via a
> systemd timer or cron then.

## 4. Hardening — firewall (DB ports only from the tailnet) + SSH
```bash
sudo apt install -y nftables
sudo tee /etc/nftables.conf >/dev/null <<'EOF'
#!/usr/sbin/nft -f
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    iif "tailscale0" accept                 # all tailnet traffic (SSH + DB) over the overlay
    # Defense-in-depth: DB ports ONLY from the tailnet CIDR even on other ifaces:
    ip saddr 100.64.0.0/10 tcp dport { 5432, 3306 } accept
    tcp dport 22 ct state new accept        # SSH (key-only, see below) — tighten to tailnet later
  }
  chain forward { type filter hook forward priority 0; policy drop; }
  chain output  { type filter hook output priority 0; policy accept; }
}
EOF
sudo systemctl enable --now nftables && sudo nft -f /etc/nftables.conf
# SSH: once your `ops` SSH KEY is confirmed working, disable root + password auth:
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```
> ⚠ Confirm `ssh ops@ua-mis-db-1` works with a KEY before disabling password auth
> (don't lock yourself out). Once the LAN side is fully unused, tighten `dport 22`
> to `iif "tailscale0"` only.

## 5. Keyless connection model (D-029) — forward reference
The immediate goal here is a healthy, reachable Postgres + MariaDB on the tailnet.
The team-facing flow (later, not blocking db-1 bring-up):
1. Onboarding provisions, per team `<name>`: a **database** + a **role** (least-priv,
   that team's DB only) — same `<name>` slug as everywhere (D-026).
2. The connection string (host=`ua-mis-db-1` tailnet IP, db/role per team, generated
   password) is written to **Vault** (`secret/teams/<name>/db/*`).
3. **ESO (External Secrets Operator)** in the cluster reads it via an **ExternalSecret**
   → materialises a k8s Secret in the team's namespace → the app consumes it.
So apps never hold a static DB cred in git; rotation = update Vault, ESO re-syncs.
(Provisioning automation + the Vault/ESO wiring are Phase-2 slice-4 / a DB-onboarding
target — this runbook just stands the engines up.)

## Verify (db-1 healthy + reachable over Tailscale)
From another tailnet host:
```bash
psql "host=ua-mis-db-1 port=5432 user=postgres" -c "SELECT 1;"   # after setting a postgres pw
mariadb -h ua-mis-db-1 -u root -p -e "SELECT 1;"
```
**GATE: Postgres 17 + MariaDB 11.8 both answer over the Tailscale IP, pgBackRest
`check` passes, firewall drops non-tailnet DB access.** Patroni/db-2 failover is the
NEXT sub-step (below), deliberately deferred.

---

## LATER — Patroni 2-node failover (after db-2 joins, post-CMOS-swap)
db-1 runs **standalone primary + pgBackRest** until db-2 exists. When db-2 is up:
- Install `patroni` + `etcd` (or reuse an etcd/consul DCS) on both; Patroni manages
  Postgres as a primary/standby pair with automatic failover + a VIP/HAProxy or the
  tailnet for the client endpoint.
- Convert db-1's standalone Postgres into the Patroni-managed primary (Patroni
  bootstraps from the existing cluster or a pgBackRest restore); db-2 joins as
  streaming standby.
- pgBackRest stays the backup/PITR layer underneath Patroni.
Spec'd as a follow-up; do NOT attempt with only db-1 (no quorum, no failover peer).
