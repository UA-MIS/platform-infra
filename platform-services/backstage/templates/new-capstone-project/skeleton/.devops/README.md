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
| `chart/overlays/{dev,staging,prod,preview}/` | Per-environment diffs: image tag seam, replicas, ingress host, env label, the per-namespace ESO `SecretStore` + app-secret `ExternalSecret`, and the `harbor-pull` SealedSecret (v1; ESO reserved for post-v1). |
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

## Secrets — External Secrets Operator + Vault (ADR-030 B1)

Secrets are delivered by the **External Secrets Operator (ESO)** reading from
**HashiCorp Vault** — the v1 "no secret material in git" model. Each env overlay
ships, alongside its workload:

- a per-namespace **`SecretStore`** (`vault-tenant`) + **ServiceAccount** (`eso-tenant`)
  in `secretstore.yaml`, scoped to this team's Vault path
  `secret/data/tenants/<team>/*` ONLY (least privilege — a tenant SA cannot read
  another team's secrets or the platform path);
- an **`ExternalSecret`** (`app-secret.externalsecret.yaml`) that points `APP_SECRET`
  at Vault key `APP_SECRET` under `secret/tenants/<team>/<env>/app` and materializes
  the in-namespace `Secret` `sample-secret` (key `app-secret`), which the Deployment
  envs into `APP_SECRET`. The app proves it read the secret on `/` without leaking it.

The image-pull cred (`harbor-pull`) is **NOT** on ESO in v1 — it stays a SealedSecret
(see the dedicated section below).

No value is ever committed here — the committed manifests carry only **key names +
Vault pointers**. Values are written to Vault by the platform (onboarding) or by The
Process "Secrets" tab; ESO syncs them into real `Secret`s.

### harbor-pull image-pull cred (v1: SealedSecret, ESO reserved)

In v1 the `harbor-pull` `kubernetes.io/dockerconfigjson` Secret is a **SealedSecret**:
the platform mints a Harbor pull robot at onboarding (`make harbor-robot`) and the
per-namespace SealedSecret is committed at `overlays/<env>/harbor-pull.sealedsecret.yaml`.
The ciphertext shipped in the skeleton is a non-functional **placeholder** so the chart
renders; the operator regenerates it with the real robot cred (`kubeseal`, per-namespace
strict scope) at onboarding. It is NOT on ESO in v1 because a real ESO `harbor-pull` needs
onboarding to write the robot creds to Vault first (the `make-harbor-robot` migration is
on HOLD) — an ExternalSecret pointed at an unpopulated Vault path would be broken. A
post-v1 ESO flip is **RESERVED** at Vault path
`secret/data/tenants/<team>/<env>/harbor-pull` (key `.dockerconfigjson`); flipping later
= add the ExternalSecret + have onboarding write the robot creds to that path
(ADR-030 follow-on, coordinated with eso-vault).

### Where the values come from (out-of-band, NOT the student build)

ESO can only sync once Vault has the value AND the per-tenant Vault role exists. The
platform onboarding step (per the tenant-PR checklist) does both:

```sh
# Per-tenant Vault policy + role (binds the eso-tenant SA; scoped to this team's path):
kubectl -n vault exec -i vault-0 -- sh -s -- <team> <env> \
  < platform-services/external-secrets/vault-policies/tenant-role.sh

# Land the Vault CA in each tenant namespace (ConfigMap vault-ca, key ca.crt) so the
# namespaced SecretStore can verify Vault's TLS (a namespaced SecretStore cannot read
# the vault-server-tls Secret across namespaces). Owned by the ESO/Vault onboarding.
```

`app-secret` is **zero-config**: `APP_SECRET` is `optional: true` in the base and the
ExternalSecret uses `deletionPolicy: Delete`, so a fresh app with nothing in Vault
deploys fine (it reports `secret loaded: false`). (`harbor-pull` is delivered out-of-band
as a SealedSecret in v1 — see the harbor-pull section above — so it has no ESO value step
here.)

### Preview / dynamic namespaces

ESO removes the Phase-1 SealedSecret strict-scope wrinkle: each per-PR namespace gets
its own `SecretStore` + `ExternalSecret` that resolve from Vault **by path**, with no
ciphertext cryptographically bound to one namespace. The live ArgoCD PR generator
templates `sample-pr-<number>`; the per-PR namespace's `eso-tenant` SA must be bound to
the tenant Vault role (same role, any of the team's namespaces).

## Validating a render locally

```sh
for env in dev staging prod preview; do
  kubectl kustomize chart/overlays/$env >/dev/null && echo "$env OK"
done
```
