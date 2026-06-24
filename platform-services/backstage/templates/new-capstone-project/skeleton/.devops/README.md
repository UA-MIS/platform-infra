# `.devops/` — Platform-managed. Do not edit.

**This directory is owned by the platform team and is immutable to students.**
It is seeded from the platform template repo. Editing it will be reverted (and,
from Phase 2, blocked by branch protection + `CODEOWNERS` review on `/.devops/**`
plus a drift check against the pinned template version — see architecture §1.3).

If you think something here needs to change, open an issue with the platform team
instead of editing these files.

## What lives here

| Path | Purpose |
| --- | --- |
| `app-metadata.yaml` | The **only** file you (the student) set values in: `team`, `semester`, `app-name`, `port`. Everything below derives from it. |
| `chart/base/` | Kustomize base: `Deployment`, `Service`, `Ingress`, `ServiceAccount`. Environment-agnostic. |
| `chart/overlays/{dev,staging,prod,preview}/` | Per-environment diffs: image tag seam, replicas, ingress host, env label, and (dev/staging/prod) a per-namespace `SealedSecret`. |
| `promotion.yaml` | **The single configured place** (§4.1): trigger→env→tag-convention→overlay→gate. The CI scripts read only this. |
| `ci/build-and-push.sh` | Build `app/` and push to the k3d registry; tag computed from `promotion.yaml`. |
| `ci/bump-image.sh` | Image-bump seam: write the new tag into the env overlay's `images[].newTag` and (with `COMMIT=1`) commit it — the GitOps signal. |
| `ci/RUNBOOK.md` | The full local loop: edit app → build → push → bump → ArgoCD syncs. |

## The image-tag seam (§4.1)

Each overlay's `kustomization.yaml` has an `images:` block:

```yaml
images:
  - name: sample
    newName: k3d-registry.localhost:5000/sample
    newTag: dev          # <-- the seam the CI image-bump rewrites
```

GitOps deploys whatever tag is written here. The CI step (T8) rewrites `newTag`
per `promotion.yaml`: `dev`=main digest, `staging`=semver tag, `prod`=gated tag,
`preview`=`pull-<sha>`. Nothing else moves the deployed version.

## Secrets — Sealed Secrets (§5.3, D-006)

`APP_SECRET` is delivered to the app via a `SealedSecret` committed in each env
overlay. The sealed-secrets controller decrypts it **in-namespace** into a
`Secret` named `sample-secret` (key `app-secret`), which the Deployment envs into
`APP_SECRET`. The app proves it read the secret on `/` without leaking the value.

### ⚠ The committed SealedSecrets are PLACEHOLDERS

`chart/overlays/*/sealedsecret.yaml` ship with a non-functional placeholder
ciphertext so the chart renders. **They must be regenerated with `kubeseal`
against the live controller before the secret will decrypt.**

### Sealing workflow (Phase 1)

`SealedSecret`s are **per-namespace strict scope** (the controller default,
D-008): a secret sealed for `sample-dev` decrypts **only** in `sample-dev`. Seal
once per target namespace (`sample-dev`, `sample-staging`, `sample-prod`).

Prereqs: the sealed-secrets controller must be installed (platform task T4) and
`kubeseal` on your PATH.

```sh
# 1. Create the plaintext Secret locally (never commit this).
kubectl create secret generic sample-secret \
  --namespace sample-dev \
  --from-literal=app-secret='<your-dev-secret-value>' \
  --dry-run=client -o yaml > /tmp/sample-secret-dev.yaml

# 2. Seal it against the cluster controller's public cert (strict scope).
kubeseal --controller-namespace sealed-secrets \
  --format yaml < /tmp/sample-secret-dev.yaml \
  > chart/overlays/dev/sealedsecret.yaml

# 3. Repeat for staging, prod, AND preview, changing --namespace and the output
#    path. Then commit the regenerated SealedSecret files. Delete the /tmp plaintext.
```

The **preview** overlay ships a `SealedSecret` too (sealed for the Phase-1
stand-in namespace `sample-pr-1`). It is **required**: the base Deployment's
`APP_SECRET` references Secret `sample-secret`, so without a matching per-namespace
SealedSecret the preview pods never start (finding SEC-004). For the Phase-1 D-009
git-branch proof, regenerate `chart/overlays/preview/sealedsecret.yaml` for
`sample-pr-1` exactly like dev/staging/prod (`--namespace sample-pr-1`).

> **Phase-2 dynamic-namespace wrinkle (flagged, not solved here).** Per-namespace
> strict scope means a preview seal is valid only in the one namespace it was
> sealed for. With the live ArgoCD PR generator each PR gets its own
> `sample-pr-<number>` namespace, so a single committed `sample-pr-1` seal will not
> decrypt in `sample-pr-2`, `-pr-3`, … Phase 2 must either (a) seal the preview
> secret with **namespace-wide** scope (the `sealedsecrets.bitnami.com/namespace-wide`
> annotation, so any `sample-pr-*` namespace can decrypt it), or (b) add a per-PR
> seal step to the preview pipeline that seals for the actual PR namespace at sync
> time. Deferred to Phase 2 — Phase 1 uses the single `sample-pr-1` stand-in.

## Validating a render locally

```sh
for env in dev staging prod preview; do
  kubectl kustomize chart/overlays/$env >/dev/null && echo "$env OK"
done
```
