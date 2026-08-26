# Migrating the `ida-llm` board onto this chart (SEC-037)

Board item **#134**. `ida-llm` is the last board still on the pre-chart pattern:
it runs in the **tenant** namespace `ida-llm-prod`, from an image the team builds
itself, holding the **platform** GitHub App private key.

This document exists because the migration is **not** the four-line file the
board item assumed. Six things differ between `ida-llm` and every chart board,
and three of them are decisions rather than steps. Read all of it before
starting.

> **The containment is already separable, and already done.**
> `UA-MIS/ida-llm#27` removes the App credential from the tenant namespace
> without moving the board. That closes the critical exposure. Everything below
> is the *migration*, which restores the three features that PR gives up. Do not
> let the migration's size delay the containment.

---

## Why this cannot wait, in one paragraph

`ua-mis-backstage` (app_id `4097147`) is installed on `repository_selection:
all` with `administration: write`, `contents: write`, `workflows: write`, and is
a branch-protection bypass on `platform-infra` main. Its private key sat in
`ida-llm-prod`, a namespace ArgoCD reconciles from `github.com/UA-MIS/ida-llm` at
`HEAD` — a repository the students own. Any pod in a namespace may mount any
Secret in it; Kubernetes has no finer grain. So an ordinary commit, or an
ordinary change to the board image the team builds, yields org-admin GitHub for
all of UA-MIS. Verified byte-identical, not inferred:

```
ida-llm-prod/ida-llm-agile-secret  GITHUB_APP_PRIVATE_KEY  sha256=8ba1cda456d71104  len=1679  PEM
agile/wizarddress-agile-shared     GITHUB_APP_PRIVATE_KEY  sha256=8ba1cda456d71104  len=1679  PEM
```

---

## What actually differs

Established against the live cluster, not the manifests.

| | chart boards (`agile`) | `ida-llm` today |
|---|---|---|
| namespace | `agile` (platform) | `ida-llm-prod` (**tenant**) |
| manifests from | `platform-infra` | `UA-MIS/ida-llm` @ `HEAD` |
| image | `platform/agile-board` (shared) | `ida-llm/ida-llm-agile:0.1.3` (**team-built**) |
| database | `agile_boards` | `ida_llm_prod` |
| schema | `<team>` → `wizarddress` | `agile` |
| host | `<team>-agile.capstone.uamishub.com` | `ida-agile.capstone.uamishub.com` |
| Dex client | shared `agile-board` | own `ida-agile` |
| `REQUIRED_GROUP` | `UA-MIS:<team>` | **unset** |
| attachments | none | MinIO in `ida-llm-prod` |
| extra secrets | — | `GITHUB_WEBHOOK_SECRET`, `GITHUB_POLL_TOKEN` |

Four of those rows are the reason this is not a rename.

### The good news

The two things that could have made migration impossible are both fine:

- **Schema is identical.** Both carry the same 17 tables. `ida-llm` is not a
  divergent fork — it is this application, one migration *ahead*
  (`004_clear_stale_branch_metadata.sql`; chart boards are at `003`).
- **Attachments are unused.** `select count(*) from agile.attachments` = **0**.
  The MinIO wiring that the chart cannot express has never stored a row, so
  dropping it costs nothing. Confirm this is still 0 before you rely on it.

### The data that must move

`ida_llm_prod.agile` on `capstone-tenant-pg`, at the time of writing:

```
work_items = 53          activity = 363           webhook_deliveries = 545
item_commits = 99        work_item_tags = 47      work_item_dependencies = 32
pull_request_links = 18  poll_state = 17          sprints = 4
comments = 3             schema_migrations = 4    board_page_revisions = 2
api_tokens = 2           board_pages = 1          board_settings = 1
idempotency_keys = 1     attachments = 0
```

**A board that comes back on an empty schema is indistinguishable from a wiped
board.** The chart sets `AGILE_DB_SCHEMA=<team>` and the app *creates that schema
on startup*, so simply adding `tenants/_boards/ida-llm.yaml` produces a working,
empty board at a new URL while the real one still runs elsewhere. Do the data
move first.

---

## Three decisions that are not mine to make

**1. The URL changes.** The chart derives host from the team slug in one helper
shared with `APP_URL` and the Dex redirect URI, deliberately, so the three cannot
disagree. `ida-llm` therefore lands on **`ida-llm-agile`**.capstone.uamishub.com,
not `ida-agile`. There is no host override, and adding one would break the
invariant that stops the single most expensive failure this app has. Either
accept the new URL, or add the old host as a second Ingress rule and redirect.

**2. `REQUIRED_GROUP` starts being enforced.** Chart boards set
`REQUIRED_GROUP: UA-MIS:<team>`; `ida-llm`'s ConfigMap has no such key. Anyone
currently signing in who is **not** a member of the `UA-MIS:ida-llm` GitHub Team
will lose access the moment this migrates. Outside collaborators are the specific
risk — they are not ingested as team members. Enumerate the board's current users
against the team roster **before** cutover.

**3. The Dex client changes.** `ida-llm` uses its own `ida-agile` static client
with its own secret (fingerprint `6a138a5a2c4bc7fe`, distinct from the shared
client's `ada345184282eadb` — verified). Migrating moves it onto the shared
`agile-board` client, which needs the new redirect URI appended by
`gen-board-clients.py` and its PR merged. Per this directory's README that is the
one human action in board provisioning, and a board whose redirect URI is missing
**deploys, passes readiness, serves its landing page, and fails only on Sign in**.

---

## Sequence

Steps 1–2 are reversible. Step 5 is the cutover.

### 0. Confirm the containment landed

```bash
kubectl -n ida-llm-prod get secret ida-llm-agile-secret -o json | jq -r '.data|keys[]'
```

Expect **no** `GITHUB_APP_*`. If they are present, merge `UA-MIS/ida-llm#27`
first — the migration does not need to be finished for the exposure to be closed,
and the exposure should not wait for the migration.

### 1. Delete the App properties from the tenant Vault subtree

The k8s-side removal stops the value being materialized. This stops it being
*re-referencable*: `tenants/ida-llm/prod/agile` is writable by the team through
the portal's Secrets tab, so anything left there can be pulled back into the
namespace by a future manifest.

```bash
vault kv patch -mount=secret tenants/ida-llm/prod/agile \
  GITHUB_APP_ID=- GITHUB_APP_INSTALLATION_ID=- GITHUB_APP_PRIVATE_KEY=-
```

Verify the other four properties survive — `SESSION_SECRET` above all, because
deleting it logs out every signed-in user with an opaque error:

```bash
vault kv get -mount=secret -format=json tenants/ida-llm/prod/agile \
  | jq -r '.data.data | keys[]'
# expect: GITHUB_POLL_TOKEN, GITHUB_WEBHOOK_SECRET, OIDC_CLIENT_SECRET, SESSION_SECRET
```

### 2. Copy the data into the shared boards database

Cross-database, so it is a dump and load rather than `ALTER SCHEMA`. Read-only
against the source; nothing here drops anything.

```bash
# Dump the live schema, rewriting it to the chart's naming on the way in.
# The app normalizes the hyphen: AGILE_DB_SCHEMA=ida-llm becomes schema ida_llm.
kubectl -n db-tier exec capstone-tenant-pg-1 -c postgres -- \
  pg_dump -U postgres -d ida_llm_prod -n agile --no-owner --no-acl \
  > /tmp/ida-llm-board.sql

sed -i 's/\bagile\./ida_llm./g; s/SCHEMA agile\b/SCHEMA ida_llm/g' /tmp/ida-llm-board.sql
grep -c 'ida_llm\.' /tmp/ida-llm-board.sql          # sanity: non-zero

kubectl -n db-tier exec -i capstone-tenant-pg-1 -c postgres -- \
  psql -U postgres -d agile_boards -v ON_ERROR_STOP=1 < /tmp/ida-llm-board.sql

kubectl -n db-tier exec capstone-tenant-pg-1 -c postgres -- \
  psql -U postgres -d agile_boards -c \
  "GRANT USAGE ON SCHEMA ida_llm TO agile_boards;
   GRANT ALL ON ALL TABLES IN SCHEMA ida_llm TO agile_boards;
   GRANT ALL ON ALL SEQUENCES IN SCHEMA ida_llm TO agile_boards;"
```

The grants matter: `agile_boards` is one Postgres role for all boards (this
directory's README states that trade explicitly), and a schema restored as
`postgres` is unreadable by it. A board that cannot read its schema reports a
**connect error**, not an empty board — loud, but only if you are watching.

Verify the row counts match the table above before continuing.

```bash
kubectl -n db-tier exec capstone-tenant-pg-1 -c postgres -- psql -U postgres \
  -d agile_boards -tA -c "select count(*) from ida_llm.work_items;"   # expect 53
```

### 3. Reconcile the migration state

The source is at `004`, chart boards at `003`. The dump carries
`schema_migrations` with it, so the restored schema declares `004` while the
platform image may only know `001`–`003`. Applying a *missing* migration is
normal; encountering an *unknown* one is not.

Confirm the platform `agile-board` image tag you will deploy contains
`004_clear_stale_branch_metadata.sql`. If it does not, that image bump lands
first — it is being handled separately and is not part of this change. Do not
hand-edit `schema_migrations` to paper over the gap.

### 4. Append the Dex redirect URI

```bash
python3 platform-services/dex/gen-board-clients.py --check
```

Add `tenants/_boards/ida-llm.yaml` (below), let the scheduled workflow open its
redirect-URI PR, and **merge it before cutover**. `make validate` guard 6 fails
on drift, so this cannot be lost silently — but it can be lost *late*, which
presents as a board that works until someone clicks Sign in.

### 5. Cut over

Create `tenants/_boards/ida-llm.yaml`:

```yaml
# Sprint board for team `ida-llm`. Migrated off the pre-chart pattern that
# held the platform GitHub App key in the tenant namespace (SEC-037, #134).
# Host is derived: ida-llm-agile.capstone.uamishub.com
team: ida-llm
repos: UA-MIS/ida-llm
title: IDA Agile
accent: "#9e1b32"
```

Then, in this order:

1. Merge that file. Watch `agile-board-ida-llm` go Ready in `agile`; confirm the
   board shows **53 work items**, not zero.
2. Only then remove `agile.yaml`, `agile-config.yaml` and
   `agile-secret.externalsecret.yaml` from `UA-MIS/ida-llm`'s prod overlay.
   **Order matters:** that ExternalSecret has `deletionPolicy: Delete`, so
   removing it deletes `ida-llm-agile-secret` and with it `SESSION_SECRET`. Doing
   this before step 1 logs out every user of a board that has nowhere to go yet.
3. Leave `ida_llm_prod.agile` in place as the rollback. Drop it only once the new
   board has been used for a sprint. Mirrors the README's stance on board
   removal: an automatic `DROP SCHEMA CASCADE` is not a power a file deletion
   should have.

### 6. Verify

```bash
# no platform credential left anywhere a tenant can reach
python3 hack/audit-tenant-credentials.py

# board is in the platform namespace with its data
kubectl -n agile get deploy ida-llm-agile
kubectl -n db-tier exec capstone-tenant-pg-1 -c postgres -- psql -U postgres \
  -d agile_boards -tA -c "select count(*) from ida_llm.work_items;"

# the exposure is actually closed: a pod a student could create cannot read it
kubectl -n ida-llm-prod run sec037-check --rm -i --restart=Never \
  --image=busybox --overrides='{"spec":{"containers":[{"name":"c",
  "image":"busybox","command":["sh","-c","echo ${GITHUB_APP_PRIVATE_KEY:-ABSENT}"],
  "envFrom":[{"secretRef":{"name":"ida-llm-agile-secret"}}]}]}}'
# expect: ABSENT
```

That last check is the one that matters. It reproduces the attack exactly —
mounting the tenant's own Secret from a pod in the tenant's own namespace — and
must print `ABSENT`.

---

## Rotation: recommended, and deliberately not done here

The key was reachable from a student-writable repository and from an image a
student team builds. **Treat it as exposed and rotate it.** There is no evidence
it *was* taken; there is also no log that would show it, which is the point.

Rotation was not performed as part of this work because the blast radius is
platform-wide and the ordering is unforgiving. The full consumer list, enumerated
by value fingerprint rather than by grep:

```
agile         agile-env                    GITHUB_APP_PRIVATE_KEY   maintainers' board
agile         alhands-agile-shared         GITHUB_APP_PRIVATE_KEY   team board
agile         capstone-demo-agile-shared   GITHUB_APP_PRIVATE_KEY   team board
agile         wizarddress-agile-shared     GITHUB_APP_PRIVATE_KEY   team board
agile         wizardtest-agile-shared      GITHUB_APP_PRIVATE_KEY   team board
backstage     backstage-process-secrets    GITHUB_APP_PRIVATE_KEY   scaffolder / onboarding
argocd        argocd-repo-creds-uamis      githubAppPrivateKey      *** ArgoCD's GitHub auth ***
ida-llm-prod  ida-llm-agile-secret         GITHUB_APP_PRIVATE_KEY   the finding
```

**`argocd-repo-creds-uamis` is the one to be careful about, and the board item
did not list it.** It is how ArgoCD authenticates to GitHub. A botched rotation
does not merely break onboarding and CI — it stops every Application in the
cluster from pulling its source, including the ones you would use to fix it.

GitHub Apps support **two active private keys simultaneously**. Use the overlap:

1. Generate a second private key in the App settings. Both are now valid.
2. Write the new key to **every** Vault path feeding the list above.
3. Let ESO refresh (or force it) and confirm each consumer is healthy on the new
   key — ArgoCD repo connectivity **first**, then Backstage scaffolding, then a
   tenant CI autobump, then each board's PR-linking.
4. Only then delete the old key in GitHub.

Do not hard-cutover. Reverse this order and onboarding, every build, every board
and all of GitOps stop at the same moment.

---

## Related exposure, not fixed here

`hack/audit-tenant-credentials.py` also flags, as path-scope notes rather than
value matches:

- `slides/lab-db-admin` ← `platform/lab-db`, carrying `MARIADB_ROOT_PASSWORD`.
  The `slides` namespace is reconciled from `UA-MIS/slidedeck` @ `main` — a
  separate repo from this one. Same *structural* shape as SEC-037 (external repo
  reconciles a namespace holding a platform admin credential), different blast
  radius and a different set of people who can push. Worth its own item.
- `lab-f26-321-test/ghcr-pull` and `lab-r26-lab1/ghcr-pull` ←
  `platform/labs-ghcr-pull`. A **shared** registry credential in namespaces
  students run pods in. Read-only pull, so far lower severity — but shared, and
  worth confirming it is scoped to pull.

Neither is the same severity as SEC-037 and neither is addressed by this change.
