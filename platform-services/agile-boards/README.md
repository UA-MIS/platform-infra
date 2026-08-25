# `agile-boards` — one sprint board per team

Every capstone team gets a working sprint/story board at

    https://<team-slug>-agile.capstone.uamishub.com

signed in with their UA-MIS GitHub account, gated on their GitHub Team.
Provisioned from the New Project wizard by a checkbox that is **on by default**.

> **Not to be confused with `platform-services/agile/`**, which is the
> *maintainers'* board at `agile.uamishub.com` (PR #543). Same image, same Dex
> client, same namespace — but that one is a single hand-written instance for the
> platform team, and this is the per-team fleet. They are siblings, not rivals.

---

## The shape, in one paragraph

**One image, many instances.** `UA-MIS/agile-board` builds ONE image
(`harbor.capstone.uamishub.com/platform/agile-board`). Every board is that image
with different environment variables — no per-team copy of the code and no
per-team build, so a fix is one rebuild rather than twelve. A team's board is
declared by ONE file, `tenants/_boards/<team>.yaml`; the `agile-boards`
ApplicationSet turns each file into one ArgoCD Application rendering `chart/`.

```
tenants/_boards/<team>.yaml          the whole per-team declaration (4 lines)
        │
        ├─► applicationsets/agile-boards-appset.yaml   (git-files generator)
        │        └─► Application `agile-board-<team>` → chart/ → ns `agile`
        │
        └─► platform-services/dex/gen-board-clients.py
                 └─► redirect URIs on the EXISTING `agile-board` Dex client
```

## Why the board is keyed on the TEAM, not the project

The requirement: *one board per team; a team creating a second project reuses the
existing board.*

The obvious implementation — a field on the `CapstoneTenant` claim — is the wrong
one. A claim is keyed `<team>-<app>`, so two claims for one team would both render
board resources under the same team-keyed names, and two Crossplane reconcile
loops would fight over them every 30–60 seconds. That is the 2026-07-10
duplicate-claim incident (NetworkPolicy apply-fight → Cilium CPU pin).

Here the **filename is the team slug**. A second board is not prevented by a guard
someone had to remember to write; it is prevented by the filesystem.

(Independently, the scaffolder's `preflight` permits only one claim per team per
*semester*, so the only way to reach the board step twice is a new semester —
where refreshing the board's tracked repo is the behaviour you want.)

## Why boards live in `agile` and not in `<team>-prod`

1. **Ingress hijack.** The tenant AppProject whitelists `networking.k8s.io/Ingress`
   in a team's own namespaces. A student could commit an Ingress claiming
   *another* team's board host; two Ingresses for one host is ambiguous,
   first-write-wins routing, and the prize is another team's OAuth authorization
   code. Students have no RBAC in `agile`.
2. **Shared credentials.** Every board consumes the same Dex client secret and the
   same GitHub App private key. Those must not land in a namespace whose occupants
   can schedule pods.
3. **Blast radius.** Nothing here touches a tenant namespace, the claim, or the
   Composition — so a team that declines a board is provisioned by exactly the
   code path that exists today.

### Why `agile` specifically, and not a namespace of our own

Because it already carries the two things a board needs and a new namespace would
have had to re-create:

- the **`harbor-pull`** secret for the shared image. `kubeseal` is
  namespace-strict, so a second namespace means a second sealing operation.
- an ingress rule in `platform-services/db-tier/netpol.yaml` naming it on **5432**.
  db-tier runs its own default-deny; a board in an unnamed namespace has its
  Postgres connection blackholed and reports a connect **timeout**. That is not a
  prediction — an earlier revision of this feature used its own namespace and hit
  exactly that.

What is **not** inherited is the network fence: `platform-services/agile/netpol.yaml`
is scoped `podSelector: {app: agile}`, so it selects that one pod. There is no
cluster-wide default-deny here, so a board pod with no policy selecting it would be
**unfenced**. Each board therefore ships its own NetworkPolicy
(`chart/templates/netpol.yaml`). Do not delete it in a tidy-up.

## Layout

| Path | Contents |
|---|---|
| `chart/` | the per-board Helm chart, rendered once per team |

The parent directory is **excluded** from `platform-services-appset` — it holds
only a chart, with no root `kustomization.yaml` (the `lab-hosting/` precedent).

---

## One-time platform setup

Done **once, ever** — not per team. Adding the twelfth team costs one four-line
file and zero credential operations.

### 1. The shared boards database

Boards share one database on the existing `capstone-tenant-pg` CNPG cluster and
are separated by **schema** (`AGILE_DB_SCHEMA=<team>`), which the app creates
itself during its in-process startup migration.

```bash
kubectl -n db-tier exec capstone-tenant-pg-1 -c postgres -- psql -U postgres -c \
  "CREATE ROLE agile_boards LOGIN PASSWORD '<generated>';"
kubectl -n db-tier exec capstone-tenant-pg-1 -c postgres -- psql -U postgres -c \
  "CREATE DATABASE agile_boards OWNER agile_boards;"
```

Separate from the maintainers' board's own database on purpose: a migration
problem on one fleet should not be a migration problem on the other.

> **Isolation, stated plainly.** One database means one Postgres role, so the
> boundary between two teams' boards is the application's schema scoping, not a
> database grant. Proportionate here — every board runs the same platform-built
> image, students never receive the DSN, and the data is sprint items. Tightening
> it to a role per team is a `provider-sql` `Role`+`Grant` per board; deliberately
> **not** taken, because provider-sql rotation and finalizer wedges are a
> documented teardown hazard and this is the golden path.

### 2. The Vault object every board reads

One KV object at `platform/agile-board`, read by `chart/templates/shared-secret.yaml`
through the cluster-scoped `vault-backend` store (its `external-secrets-ro` policy
already grants `secret/data/platform/*`).

Under `platform/` and **not** `tenants/<team>/` on purpose: the tenant subtree is
writable by students through the portal's Secrets tab, and a shared client secret
must not sit where one team can break every other team's board.

```bash
vault kv put secret/platform/agile-board \
  OIDC_CLIENT_SECRET="<the value already sealed as dex-github/agile-board-client-secret>" \
  DATABASE_URL="postgres://agile_boards:<pw>@capstone-tenant-pg-rw.db-tier.svc.cluster.local:5432/agile_boards?sslmode=prefer" \
  GITHUB_APP_ID="4097147" \
  GITHUB_APP_INSTALLATION_ID="141394298" \
  GITHUB_APP_PRIVATE_KEY="$(base64 -w0 < app.private-key.pem)"
```

⚠ `OIDC_CLIENT_SECRET` must be **the value already sealed for the `agile-board`
client**, not a fresh one — the maintainers' board and every team board share that
client. Minting a new value silently breaks sign-in on all of them.

The **GitHub App is why this scales**: one org-wide App serves every board, so
there are no per-team PATs and no per-team GitHub OAuth apps. Without it the
assignee picker, "Start work" branch creation and PR backlinks report themselves
unavailable — loudly, naming the variables.

### 3. Dex

Nothing to do. The `agile-board` static client and its `AGILE_BOARD_CLIENT_SECRET`
env already exist. Team boards are additional **redirect URIs** on that same
client, appended by the generator.

---

## Adding a team (what actually happens)

1. A student ticks **Sprint board for your team** in the wizard (default on).
2. The scaffolder commits `tenants/_boards/<team>.yaml` to `platform-infra` main.
3. ArgoCD renders `agile-board-<team>` into `agile`. The board comes up.
4. `.github/workflows/dex-board-clients.yaml` notices within ~10 minutes and opens
   a PR adding the redirect URI. **Merge it.**
5. ArgoCD syncs the ConfigMap; Stakater Reloader rolls Dex automatically.

Step 4 is the one human action, and it exists because **Dex has no wildcard
redirect URIs**. It is a click, not a procedure: the fix arrives pre-written, and
`make validate` fails on drift so it cannot be lost silently.

> **Why not push that fix straight to main?** It would need a branch-protection
> bypass credential in CI. This repo already considered and rejected that trade
> for this exact kind of convenience (FIX-10 — automating the topic-strip "would
> require ... a real widening of the trust boundary for a convenience win"). The
> workflow uses only the default `GITHUB_TOKEN`, which can open a PR and no more.

### The failure this ordering protects against

A board whose redirect URI is missing from Dex **deploys, passes readiness, and
serves its landing page** — then fails when a student clicks Sign in, with an
opaque OIDC error. It looks like a working board until someone tries to use it.
That is why the drift check blocks `make validate`, why the workflow also runs on
a schedule, and why `APP_URL`, the Ingress host and the redirect URI all derive
from one helper rather than being written three times.

## Removing a team's board

```bash
git rm tenants/_boards/<team>.yaml
```

ArgoCD prunes the Application and everything it owns; the next sync-workflow run
opens a PR removing the redirect URI. **The board's Postgres schema is NOT
dropped** — deliberately, mirroring D-082 on tenant Vault KV: it is inert once the
board is gone, and an automatic `DROP SCHEMA CASCADE` is not a power this platform
should hand to a file deletion.

## Operating

```bash
kubectl -n agile get deploy,ingress -l app.kubernetes.io/name=agile-board
kubectl -n argocd get app | grep agile-board
python3 platform-services/dex/gen-board-clients.py --check    # drift?
kubectl -n agile logs deploy/<team>-agile                     # names any missing credential
```

The app fails **loudly** about missing credentials rather than degrading silently
— a startup log line names the variables. Trust it.
