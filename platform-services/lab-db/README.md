# lab-db — per-student lab databases for the slides app

The platform side of the `with_database` labs in **UA-MIS/slidedeck**
(`slides.uamishub.com`). Deployed into the **existing** namespace `slides` as
ArgoCD Application `platform-svc-lab-db` (the `platform-services/*` directory
generator).

## Design: browser-only

Students never get a database client. Access is:

```
browser --TLS--> slides.uamishub.com  (Entra sign-in, the app's own session)
                        |
                        |  express + http-proxy-middleware, path /db-console
                        v
              lab-adminer.slides.svc.cluster.local:8080     (ClusterIP, no Ingress)
                        |
                        v
              lab-mariadb.slides.svc.cluster.local:3306     (ClusterIP, no NodePort)
```

There is **no public 3306**, no `LoadBalancer`/`NodePort`, no Ingress on Adminer,
and no oauth2-proxy/Dex middleware in front of it — **the app is the gate**. The
NetworkPolicies make that structural rather than merely conventional: the only
pod allowed to open a connection to the console is the slidedeck app pod.

The app also talks to MariaDB directly, as `labadmin`, to run its own provisioning
SQL (`server/labdb.js`: `CREATE DATABASE` / `CREATE USER` / `GRANT ALL ON <db>.*`
per student, plus password rotation).

## What is here

| File | What |
|---|---|
| `externalsecret.yaml` | Vault `secret/platform/lab-db` → Secret `lab-db-admin` |
| `initdb-configmap.yaml` | first-boot SQL that creates `labadmin`@`%` |
| `mariadb.yaml` | dedicated MariaDB StatefulSet (5Gi `ceph-block` PVC) + ClusterIP Service |
| `adminer.yaml` | Adminer Deployment + ClusterIP Service, `ADMINER_DEFAULT_SERVER` prefilled |
| `netpol.yaml` | the three-policy matrix (see the file header) |

**Not here, on purpose:** the `slides` Namespace (owned by the `slidedeck`
Application, which syncs `deploy/` from the app repo) and any Ingress.

## Dedicated instance, never db-tier Galera

Lab databases are high-churn and student-writable. This is a **single-replica,
single-purpose** MariaDB whose worst case is "the sandboxes are gone"; durability
comes from Ceph RBD replica-3 under the PVC. The db-tier Galera cluster
(Backstage / Harbor / Crossplane) is deliberately out of reach — `lab-mariadb` has
no egress beyond DNS, and nothing in `db-tier`'s own ingress policy admits this
namespace.

## Accounts

| Account | Reachable from | Used by |
|---|---|---|
| `root`@`localhost` | inside the pod only (`MARIADB_ROOT_HOST=localhost` suppresses the image's `root`@`%`) | nobody; maintenance |
| `labadmin`@`%` | in-cluster TCP | **the app** — this is the identity in `LAB_DB_ADMIN_URL` |
| `<slug>_<user>`@`%` | in-cluster TCP | one per student, `ALL PRIVILEGES` on that student's database only, created by the app |

`root` and `labadmin` share the one password Vault holds for this instance; that
costs nothing because `root` has no network-reachable grant.

## Vault keys

Read by this directory — `secret/platform/lab-db` (already populated):

- `ADMIN_USER` = `labadmin`
- `ADMIN_PASSWORD`

Written by the operator on `secret/platform/slidedeck` (consumed by the app via
the existing `slidedeck-env` ExternalSecret, **not** by this directory):

- `LAB_DB_ADMIN_URL` = `mysql://labadmin:<ADMIN_PASSWORD>@lab-mariadb.slides.svc.cluster.local:3306`
- `LAB_DB_HOST_PUBLIC` = `lab-mariadb.slides.svc.cluster.local:3306`
- `LAB_DB_CONSOLE_URL` = `http://lab-adminer.slides.svc.cluster.local:8080`

## Rotating the admin password

`ADMIN_PASSWORD` lives in **two** places and the initdb script only ever runs
against an empty datadir, so rotation is a three-step operation:

1. `ALTER USER 'labadmin'@'%' IDENTIFIED BY '<new>'` on the running instance.
2. Write the new value to `secret/platform/lab-db` (`ADMIN_PASSWORD`).
3. Write the **same** value into `LAB_DB_ADMIN_URL` on `secret/platform/slidedeck`
   — this is a separate Vault object and does **not** follow automatically.

Skipping step 3 leaves the app unable to provision (`ER_ACCESS_DENIED`) while
everything still reports healthy. Student database passwords are unaffected; those
are rotated in-app.

## Image pins

Both images are pinned by **digest** alongside their tag. The tag is kept because
Kyverno `disallow-latest-tag` is `Enforce` and `slides` is not in its exclude list;
the digest is there because a floating tag is exactly what shipped Adminer 5.4.4 to
half the fleet and 403'd every platform console (#419).

Bumping either means resolving the new digest first, e.g.
`skopeo inspect docker://docker.io/library/adminer:5`.

## The Adminer server-string regex

Adminer ≥ 5.4.3 (GHSA-r4x9-5m63-3vxw) validates the submitted server string and
answers **"Invalid server."** if the host part falls outside a narrow character
class — `^[-a-z0-9.:]*$` in 5.4.3/5.4.4, relaxed to a `[^-\w.:/]` negative class in
5.5.1. `lab-mariadb.slides.svc.cluster.local:3306` satisfies both, and the port is
inside the 1024–65535 range the same code path also enforces.

**If you ever rename the Service or move the namespace**, keep the result to
lowercase letters, digits, dots and hyphens. An underscore anywhere in the Service
or namespace name breaks every login on this console under 5.4.x.

## Acceptance (from the app repo's `RUNBOOK-DEPLOY.md`)

1. Create a `with_database` lab; claim it as a test student → the credentials
   panel appears with a database name, user, password and
   `lab-mariadb.slides.svc.cluster.local:3306` as the host.
2. Open `/db-console`, sign in with those credentials → Adminer loads with the
   Server field already filled in; **no "Invalid server."**
3. The student sees **only** their own database in the sidebar.
4. Rotate the password from the lab page → the old one stops working, the new one
   works.
