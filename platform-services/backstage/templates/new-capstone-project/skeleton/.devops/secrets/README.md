# `.devops/secrets/` — your team's secret declarations live here

This directory holds your app's **`ExternalSecret`** declarations. You do not edit
these files by hand — **The Process creates them for you** from the **Secrets** tab
on your component (the `capstone:seal-secret` action).

> **No secret material is ever stored in this repo.** These files contain only the
> **key names** and a pointer to where the value lives in **HashiCorp Vault**. The
> actual values are written to Vault by The Process and read by the **External
> Secrets Operator (ESO)** at deploy time.

## How it works (write-only, by design)

1. Open your component in The Process and go to the **Secrets** tab.
2. Pick the target environment(s) (`dev`, `staging`, `prod`), type a `KEY` and a `VALUE`.
3. The Backstage backend **writes the value to Vault** (at
   `secret/data/tenants/<team>/<env>/app` under your `KEY`) and opens a **pull
   request** that adds/updates a declaration file here:

   ```
   .devops/secrets/externalsecret-<env>.yaml
   ```

4. You review and merge the PR. ArgoCD applies the `ExternalSecret`; ESO reads the
   value from Vault and materializes a real Kubernetes `Secret` in your namespace.

> **Secrets are write-only here.** A value **cannot be read back** — Backstage never
> shows it and never commits it to git. The Secrets tab shows you the **key names and
> when each was last updated**, never the values. To change a secret, just **set it
> again** (overwrite); the value in Vault is replaced.

## Scope: one Secret per environment namespace

Each env gets one `ExternalSecret` (named `app-secrets`) targeting one Kubernetes
`Secret` (`app-secrets`) in `<team>-<env>`. All the keys you set for an env live
under the same Vault path (`tenants/<team>/<env>/app`), one Vault property per key.
A value you want in dev *and* prod is set once per env (The Process does this when
you select multiple envs) — and a value set for `dev` lives only in `<team>-dev`.
This is the platform's least-privilege secret contract: a per-tenant Vault policy
fences each team to its own subtree, and ESO reads it through the per-tenant
`SecretStore` (`vault-tenant`).

## Referencing a secret from your app

Reference the materialized `Secret` (`app-secrets`) from your workload the normal
Kubernetes way (env `valueFrom.secretKeyRef` or a mounted volume) in your
`.devops/chart` overlay. The key names match what the Secrets tab shows. Never
commit a raw `Secret` or a plaintext value to this repo.

### Wiring a secret into your workload

The starter ships with **zero required secrets** — a freshly-scaffolded app deploys
with no secrets at all. To consume a secret you set in the Secrets tab, reference the
materialized `app-secrets` Secret from your `.devops/chart` overlay via
`valueFrom.secretKeyRef` (`name: app-secrets`, `key: <the KEY you set>`). Use
`optional: true` if your app should start even when the secret is absent.

## What NOT to do

- Don't hand-edit `externalsecret-<env>.yaml` to add a value — there is no value
  field; use the Secrets tab so the value is written to Vault correctly.
- Don't delete an `externalsecret-<env>.yaml` to "rotate" — set the key again
  (overwrite) or use the Secrets tab's **Delete** to remove a key.
- Don't move these files into `.devops/chart/` or anywhere else — this directory is
  the one path The Process writes to.
