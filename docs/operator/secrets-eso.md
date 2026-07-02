# Secrets & External Secrets Operator

The External Secrets Operator (ESO) reads from [Vault](vault-and-dr.md) and
materializes namespaced Kubernetes Secrets from **`ExternalSecret` declarations**
(key *names* + `remoteRef` pointers only — **no values**) committed to tenant
repos. This is the v1 secrets model: **no secret material in git** (ADR-030).

- Deployed as `platform-external-secrets` (`applicationsets/external-secrets-app.yaml`,
  chart `external-secrets` 2.6.0; CRDs ship with the chart).
- Source of truth: `platform-services/external-secrets/README.md`.

> Bootstrap secrets (Dex, Harbor OIDC, ARC GitHub App, harbor robots) still use
> **Sealed Secrets** — encrypted in git, decrypted in-cluster. ESO is for **runtime
> tenant secrets**. The two coexist; see `docs/OPERATIONS-AND-HANDOFF.md` §4.5.

---

## The store model

```
tenant repo:  ExternalSecret (key names + remoteRef, NO values)  ──┐
                                                                   ▼
ESO controller (external-secrets ns) ──k8s-auth──► Vault (vault ns, TLS)
   reads secret/data/tenants/<team>/<env>/app                     │
   writes ───────────────────────────────────────────────────────┘
   ▼
k8s Secret in <team>-<env>  ──►  app SA reads it (standard RBAC)
```

- **`ClusterSecretStore` `vault-backend`** — platform-wide read, authenticates as
  the **ESO controller SA** via Vault role `external-secrets` (policy
  `external-secrets-ro`, read on `secret/data/tenants/*` + `platform/*`). File:
  `platform-services/external-secrets/clustersecretstore.yaml` (runbook-applied,
  holds no secret material).
- **per-tenant `SecretStore` `vault-tenant`** — namespaced, authenticates as the
  **tenant SA** via Vault role `tenant-<team>`, scoped to
  `secret/data/tenants/<team>/*` **only**. A tenant SA cannot read another
  tenant's path or the platform path. Rendered from `secretstore-template.yaml`.

**The tenant Vault path is `tenants/<team>/<env>/app`** — literal `app` leaf,
property-keyed. The Secrets-UX tab appends `data[]` entries to the shipped
ExternalSecret.

> ⚠ **kustomize load-restrictor:** tenant secrets manifests MUST live in the env
> **overlay**, not under `.devops/secrets/` — the load restrictor rejects the
> cross-dir reference otherwise.

---

## Onboarding a tenant for secrets: `make vault-onboard`

Two things must exist before a tenant's `vault-tenant` SecretStore can
authenticate: the **`tenant-<team>` Vault role** (a Vault-admin write) and the
in-namespace **`vault-ca` ConfigMap** (the public CA the namespaced store's
`caProvider` reads — a namespaced store can't cross-namespace reference the
`vault-server-tls` Secret in `vault`). `vault-onboard` does both in one shot:

```bash
make vault-onboard NAME=<team> ENV=dev \
  KUBECONFIG=clusters/real-talos/clusterconfig/talos-kubeconfig KUBE_CONTEXT=admin@capstone
```

This runs `vault-policies/tenant-role.sh` inside `vault-0` (env-prefixed with the
mounted CA so the in-pod CLI trusts the server), creating policy `tenant-<team>-ro`
(read on `secret/data/tenants/<team>/*` only) + k8s-auth role `tenant-<team>` bound
to SA `eso-tenant` in `<team>-{dev,staging,prod,preview}` (audience `vault`), and
applies the `vault-ca` ConfigMap.

### `vault-ca` as GitOps (preferred — move it off the imperative path)

```bash
make vault-ca-manifest NAME=<team> ENV=dev KUBE_CONTEXT=admin@capstone \
  > tenants/team-<team>/vault-ca-dev.yaml
# then branch + commit + PR — tenants-appset reconciles it into <team>-dev
```

> ⚠ Commit the **real** CA, never a placeholder. The tenant app `selfHeal`s, so an
> empty `data.ca.crt` in git would let ArgoCD overwrite a good imperatively-created
> ConfigMap → store stays Degraded. With the real (public, git-safe) CA, selfHeal
> is a feature.

### Platform/per-tenant Vault role scripts (the Vault-admin keyboard)

Run inside the Vault pod, logged in as root. **Pipe a file — fish has no heredoc.**

```bash
# Platform ESO read role (once):
kubectl -n vault exec -i vault-0 -- sh < platform-services/external-secrets/vault-policies/eso-role.sh
# Per-tenant scoped role (per team; what vault-onboard wraps):
kubectl -n vault exec -i vault-0 -- sh -s -- <team> <env> \
  < platform-services/external-secrets/vault-policies/tenant-role.sh
```

---

## ⚠ The stale-reconcile gotcha (read this)

**After any vault-0 restart, pod delete, or migration, ESO may show
`InvalidProviderConfig` (stale)** — the provider cached a connection that no longer
resolves. The fix is to restart the ESO controller:

```bash
kubectl -n external-secrets rollout restart deploy external-secrets
```

This is the single most common Vault-adjacent operator action. Do it whenever an
ExternalSecret/SecretStore is unexpectedly `Ready=False` right after Vault came
back. The `ExternalSecretSyncError` / `SecretStoreNotReady` /
`ClusterSecretStoreNotReady` alerts ([Observability](observability.md)) surface it.

---

## Verify

```bash
kubectl get clustersecretstore vault-backend -o jsonpath='{.status.conditions}'   # Ready/Valid
kubectl -n <team>-<env> get secretstore vault-tenant -o jsonpath='{.status.conditions}'  # Ready/Valid
kubectl -n <team>-<env> get externalsecret      # STATUS SecretSynced
```

---

## Robot creds → ESO (the in-flight migration)

Two Harbor robot creds still ship as SealedSecrets in git and are being migrated to
ESO (`platform-services/external-secrets/README.md` §7):

| Secret | Today | Migrating to |
| --- | --- | --- |
| `harbor-pull` | SealedSecret in `tenants/team-<team>/` | ExternalSecret → `tenants/<team>/<env>/harbor-pull` |
| `harbor-push-<team>` | SealedSecret in `arc-runners` | ExternalSecret → `tenants/<team>/ci/harbor-push` |
| `arc-github-app` | SealedSecret (human) | ExternalSecret → `platform/arc/github-app` |

ESO can materialize a `dockerconfigjson` imagePullSecret from Vault via
`target.template`. **Do not break working:** keep each SealedSecret as the live
path until the ESO-materialized secret is proven per team, then delete it
(single-owner). Zero-touch robot **minting straight into Vault** is what
[Crossplane onboarding](crossplane-onboarding.md) delivers.

> Open follow-up: `hardening/netpol-controlplane/vault-netpol.yaml` is wired, but a
> dedicated **vault-netpol for the ESO↔Vault path was never committed** (gap noted
> in #107). Track it before relying on netpol enforcement for that path.
