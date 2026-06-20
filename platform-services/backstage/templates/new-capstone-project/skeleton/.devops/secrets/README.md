# `.devops/secrets/` — your team's sealed secrets live here

This directory is the home for your app's **SealedSecrets**. You do not edit these
files by hand and you do not run `kubeseal` yourself — **The Process creates them for
you** from the **Secrets** tab on your component (the `capstone:seal-secret` action).

## How it works (write-only, by design)

1. Open your component in The Process and go to the **Secrets** tab.
2. Pick the target environment(s) (`dev`, `staging`, `prod`), type a `KEY` and a `VALUE`.
3. The Backstage backend **seals** the value against the platform's Sealed-Secrets
   controller and opens a **pull request** that adds/updates a file here:

   ```
   .devops/secrets/<key>.sealedsecret.yaml
   ```

4. You review and merge the PR. ArgoCD applies the SealedSecret; the controller
   decrypts it into a real Kubernetes `Secret` in your namespace.

> **Secrets are write-only here.** A sealed value **cannot be read back** — Backstage
> never holds the private key. The Secrets tab shows you the **key names and when each
> was last updated**, never the values. To change a secret, just **set it again**
> (overwrite); the next PR re-seals it.

## Scope: one SealedSecret per environment namespace

SealedSecrets are sealed with **strict scope** (namespace + name): a secret sealed for
`<team>-dev` decrypts **only** in `<team>-dev`. So a value you want in dev *and* prod is
sealed once per env (The Process does this when you select multiple envs). This is the
platform's least-privilege secret contract — a leaked dev secret cannot be applied to
prod.

## Referencing a secret from your app

Reference the materialized `Secret` from your workload the normal Kubernetes way
(env `valueFrom.secretKeyRef` or a mounted volume) in your `.devops/chart` overlay.
The `Secret` name matches what the Secrets tab shows. Never commit a raw `Secret` or a
plaintext value to this repo — the tenant AppProject does not even permit raw `Secret`
objects (only `SealedSecret`), so a plaintext secret would be rejected on sync.

## What NOT to do

- Don't run `kubeseal` locally and commit the output here — use the Secrets tab so the
  seal is done against the live controller and the per-env scope is correct.
- Don't delete a `*.sealedsecret.yaml` to "rotate" — set the key again (overwrite).
- Don't move these files into `.devops/chart/` or anywhere else — this directory is the
  one path The Process writes to.
