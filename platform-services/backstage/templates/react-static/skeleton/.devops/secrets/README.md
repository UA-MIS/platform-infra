# `.devops/secrets/` — how your team's secrets work (docs)

This directory documents the secrets flow. You do not put any values in git and you do
not edit secret manifests by hand — **The Process manages them for you** from the
**Secrets** tab on your component. The values live in your team's HashiCorp Vault path;
the repo holds only **key names + Vault pointers**, never the value.

> **Where the manifest actually lives:** the `ExternalSecret` that ESO reads is
> `.devops/chart/overlays/<env>/app-secret.externalsecret.yaml` (inside the kustomize
> overlay — a manifest under `.devops/secrets/` would escape the chart root and fail
> ArgoCD's kustomize build). This dir is the human-facing doc home, not where the
> referenced manifests sit.

## How it works (write-only, by design)

1. Open your component in The Process and go to the **Secrets** tab.
2. Pick the target environment(s) (`dev`, `staging`, `prod`), type a `KEY` and a `VALUE`.
3. The Backstage backend **writes the value into Vault** (under your team's path
   `secret/tenants/<team>/<env>/app`) and opens a **pull request** that adds/updates a
   `data[]` entry (key name + Vault pointer, no value) in the per-env
   `app-secret.externalsecret.yaml`.
4. You review and merge the PR. ArgoCD applies the `ExternalSecret`; the External
   Secrets Operator (ESO) reads the value from Vault and materializes a real Kubernetes
   `Secret` in your namespace.

> **Secrets are write-only here.** The committed file holds only the **key name and a
> Vault pointer** — never the value. The Secrets tab shows you the **key names and when
> each was last updated**, never the values. To change a secret, just **set it again**
> (overwrite); The Process rewrites the value in Vault and the next ESO refresh updates
> the materialized `Secret`.

## Scope: one Vault path per environment, fenced per team

Each environment namespace (`<team>-dev`, `<team>-staging`, `<team>-prod`) has its own
namespaced **`SecretStore`** (`vault-tenant`) that authenticates to Vault as a
team-scoped ServiceAccount (`eso-tenant`). That SA's Vault role is scoped to
`secret/data/tenants/<team>/*` **only** — your app cannot read another team's secrets or
the platform's. A value you want in dev *and* prod is written once per env (The Process
does this when you select multiple envs). This is the platform's least-privilege secret
contract — a leaked dev value cannot be used to read prod.

## Referencing a secret from your app

Reference the materialized `Secret` from your workload the normal Kubernetes way
(env `valueFrom.secretKeyRef` or a mounted volume) in your `.devops/chart` overlay.
The `Secret` name matches what the Secrets tab shows. Never commit a raw `Secret` or a
plaintext value to this repo — the tenant AppProject does not even permit raw `Secret`
objects (only ESO `ExternalSecret`/`SecretStore`), so a plaintext secret would be
rejected on sync.

### The starter's `APP_SECRET` wiring (read this if your app stays "secret loaded: false")

The starter ships with **zero required secrets** — a freshly-scaffolded app deploys with
nothing in Vault at all (the app-secret `ExternalSecret` uses `deletionPolicy: Delete`,
so a missing Vault value is **not** an error — it simply creates no `Secret`). The Go
starter does, however, *optionally* read one env var, `APP_SECRET`, which
`.devops/chart/base/deployment.yaml` wires from a Kubernetes Secret named
**`sample-secret`**, key **`app-secret`** (with `optional: true`, so a missing secret
never blocks startup — the app just reports `secret loaded: false`).

The per-env `app-secret.externalsecret.yaml` already points `APP_SECRET` at Vault key
`APP_SECRET` under `secret/tenants/<team>/<env>/app`. So `APP_SECRET` auto-populates as
soon as you set a value named **`APP_SECRET`** for that env in the Secrets tab. If you
set a *differently-named* key (e.g. `DATABASE_URL`), you get a Secret named after that
key and `APP_SECRET` stays empty — to wire it, edit
`.devops/chart/base/deployment.yaml`'s `secretKeyRef` to point at the Secret/key you set.

Most teams just add their own env vars in the chart pointing at the secrets they set,
and ignore the starter's `APP_SECRET` demo entirely.

## What NOT to do

- Don't put a value in any manifest — they are **pointers only**. Use the Secrets tab
  so the value is written to Vault and the per-team/per-env scope is correct.
- Don't remove a `data[]` entry to "rotate" a key — set it again (overwrite).
- Don't hand-edit `app-secret.externalsecret.yaml` in the overlays — the Secrets tab is
  the one writer; manual edits will conflict with its next PR.
- Don't move the ExternalSecret out of `.devops/chart/overlays/<env>/` — a manifest under
  `.devops/secrets/` (or any path that escapes `chart/`) fails ArgoCD's kustomize build.
