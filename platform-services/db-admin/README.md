# db-admin — platform-operator DB console

A second Adminer instance, distinct from the per-team consoles, giving the platform
operator (`UA-MIS:labmx`) a single web SQL console over every **non-tenant**
platform database: the CNPG (`capstone-pg`) roles Backstage/Harbor/
`crossplane_provisioner` use, and the in-cluster MariaDB (`capstone-mariadb`) root +
`crossplane-provisioner` logins. Full design: `artifacts/research/tenant-db-access.md`
§5.

- Host: `https://db-admin.capstone.uamishub.com`
- Gate: the SAME shared oauth2-proxy as every team console
  (`platform-services/db-console-auth/`), but this route's `Middleware`
  (`middleware.yaml`) restricts to `?allowed_groups=UA-MIS:labmx` — disjoint from
  every `UA-MIS:<team>` gate, so no student's own team membership ever grants
  access here.
- Credentials: `ADMINER_PLUGIN_SERVER_LIST` (dropdown + "Auto Sign-In", never a typed
  password) pre-seeded from `secret/platform/db/{cnpg,mariadb}/*` via the SAME
  platform `vault-backend` ClusterSecretStore `platform-services/db-tier/
  externalsecrets.yaml` already reads from — no new Vault policy needed.

## Operator activation

This dir's Application (`platform-svc-db-admin`) syncs cleanly as soon as it merges
— it depends on nothing new:
- The Vault values it reads (`platform/db/cnpg/*`, `platform/db/mariadb/*`) are the
  SAME ones `docs/operator/in-cluster-db-tier-runbook.md` §2 already has the operator
  write for the DB tier itself — if that runbook step is done, this console's
  ExternalSecret resolves immediately; if not, it sits `SecretSyncError` (same safe
  failure mode as every other consumer of that tree) until it is.
- The shared oauth2-proxy + Dex `db-console` client activation is
  `platform-services/db-console-auth/README.md` — shared with the tenant consoles,
  do that once.
- `platform-services/db-tier/netpol.yaml`'s `allow-ingress-db-admin` rule (this PR)
  must be merged/synced for the console pod to actually reach `capstone-pg-rw`/
  `capstone-mariadb`.

## Validate

```bash
kubectl -n db-admin get pods
curl -sk https://db-admin.capstone.uamishub.com/ -o /dev/null -w '%{http_code}\n'
# -> 302/401 (oauth2-proxy gate) until a UA-MIS:labmx member is signed in
```
