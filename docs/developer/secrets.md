# Secrets

Your app needs an API key, a database password, a third-party token. The platform's rule is
simple and absolute:

> **Secret *names* live in git. Secret *values* never do.**

You declare *that* your app needs a secret called `APP_SECRET` in your repo. You put the
*value* into Vault (through a friendly UI). At runtime the platform fetches the value from
Vault and hands it to your pod as an environment variable. The value is never committed,
never in a YAML file, never in a build log.

## The pieces (you only touch the first one)

| Piece | What it is | Who manages it |
| --- | --- | --- |
| **Secrets UI** (in The Process / Backstage) | Where you type a secret's value | **You** |
| **Vault** | The encrypted vault that stores values | Platform |
| **External Secrets Operator (ESO)** | Syncs a Vault value into a Kubernetes Secret | Platform |
| **`ExternalSecret`** in your `.devops/` overlay | Declares "fetch key X from Vault into Secret Y" (name + pointer, no value) | Platform-managed; you add entries via the UI |

## Adding a secret (the happy path)

1. Open **The Process** → your component → the **Secrets** tab.
2. Choose the **environment** (dev / staging / prod) and add a secret as a **name + value**
   (e.g. name `APP_SECRET`, value `s3cr3t…`).
3. Save. The Secrets tab writes the value into Vault at your team's path (below) and appends
   the secret's **name** to your app's `ExternalSecret` declaration.
4. Within the refresh interval (about a minute) ESO syncs it into a real Kubernetes Secret in
   your namespace, and your pod picks it up as an environment variable.

That's it — no kubectl, no encryption commands, no editing YAML by hand.

## Where your secrets live: the Vault path

Every team has a private path in Vault. The convention is:

```
tenants/<team>/<env>/app
```

with each secret stored as a **property (key)** under that path. For example, team `acme`'s
`APP_SECRET` for dev lives at:

```
tenants/acme/dev/app    property: APP_SECRET
```

Your team's `eso-tenant` service account is scoped to `tenants/<team>/*` **only** — you cannot
read another team's secrets, and another team cannot read yours. The platform path is off
limits to tenants entirely.

## What this looks like in your repo (FYI — platform-managed)

Each environment overlay carries two small platform-managed files. You don't edit them by
hand (the Secrets UI does), but it helps to recognize them:

- **`secretstore.yaml`** — a per-namespace `SecretStore` named `vault-tenant` plus the
  `eso-tenant` service account, authenticating to Vault scoped to your team's path.
- **`app-secret.externalsecret.yaml`** — the declaration that maps a Vault key into a
  Kubernetes Secret. It contains **only the name and the pointer** — never a value:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: <appName>-secret
  namespace: <team>-dev
spec:
  refreshInterval: "1h"
  secretStoreRef:
    name: vault-tenant
    kind: SecretStore
  target:
    name: <appName>-secret          # the k8s Secret your Deployment consumes
    creationPolicy: Owner
    deletionPolicy: Delete          # a missing Vault key is NOT an error (see below)
  data:
    - secretKey: app-secret
      remoteRef:
        key: tenants/<team>/dev/app # the Vault path
        property: APP_SECRET        # the key under it
```

The Deployment envs that Secret into your app (e.g. `APP_SECRET`). The flow end-to-end:

```
Secrets UI ─► Vault (tenants/<team>/<env>/app) ─► ESO ─► k8s Secret ─► your pod's env var
```

## Zero-config: a brand-new app just works

A freshly scaffolded app deploys **even with nothing in Vault**. The base marks `APP_SECRET`
`optional: true` and the `ExternalSecret` uses `deletionPolicy: Delete`, so a missing value is
not an error — the app simply starts and reports `secret loaded: false`. Add the value in the
Secrets tab whenever you need it; the Secret appears on the next refresh. You are never forced
to populate secrets before your first deploy.

## Per-environment secrets

Secrets are **per environment**. `tenants/<team>/dev/app` and `tenants/<team>/prod/app` are
separate — your dev API key and your prod API key are different values at different paths. Set
each environment's secrets in the Secrets tab by selecting that environment. Preview (per-PR)
namespaces resolve from Vault by path too, so a preview gets the same dev-class secrets without
any per-PR setup.

## Image-pull credentials (you don't manage these)

The credential that lets your pods pull private images from Harbor (`harbor-pull`) is **not**
something you set. The platform mints a Harbor pull robot at onboarding and delivers it to your
namespaces. Your pods pull from your private Harbor project automatically. (Today this is a
sealed secret managed by the operator; it's invisible to you either way.)

## Rules of thumb

- **Never** put a real secret value in any file in your repo — not in `.devops/`, not in
  `app/`, not in a `.env` you commit. Use the Secrets tab.
- A secret is referenced by **name** in git and resolved by **value** at runtime.
- Different environment = different value = set it per environment.
- If a secret isn't showing up: confirm you added it to the **right environment**, wait one
  refresh cycle, then check that the `ExternalSecret` in that namespace reports healthy (ask
  the platform team if it shows a sync error — that usually means the Vault path/role for your
  team needs an onboarding step, not something you can fix from your repo).
