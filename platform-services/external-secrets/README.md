# External Secrets Operator (ADR-030 model B1)

The External Secrets Operator reads from **HashiCorp Vault**
(`platform-services/vault/`) and materializes namespaced Kubernetes Secrets from
**`ExternalSecret` declarations** (key NAMES + `remoteRef` pointers only — **no
values**) committed to tenant repos. This is the v1 secrets model **"no secret
material in git"** (ADR-030 §0).

Deployed as the ArgoCD Application `platform-external-secrets`
(`applicationsets/external-secrets-app.yaml`, deploy method A — pinned
`external-secrets` chart `2.6.0`, appVersion `v2.6.0`). The CRDs ship **with** the
chart (`installCRDs` default true — verified by rendering). This dir ships only the
`external-secrets` **namespace**.

> ⚠ Cluster wiring (ClusterSecretStore, Vault policy/role, per-tenant SecretStores)
> is applied **out-of-band by the human** — it cannot reconcile until Vault is
> init+unsealed (it would sit `SecretSyncError`). Agents cannot apply to the cluster.

---

## Files

| File | Synced? | Purpose |
| --- | --- | --- |
| `namespace.yaml` + `kustomization.yaml` | ✅ via appset | the `external-secrets` namespace (chart installs here) |
| `clustersecretstore.yaml` | ❌ runbook | the cluster-wide `vault-backend` store (ESO -> Vault, k8s auth) |
| `secretstore-template.yaml` | ❌ template | per-tenant `SecretStore` + SA + example `ExternalSecret` (`__TEAM__`/`__ENV__`) |
| `vault-policies/eso-role.sh` | ❌ runbook | the ESO read policy + k8s-auth role (Vault side) |
| `vault-policies/tenant-role.sh` | ❌ runbook | per-tenant scoped policy + role (per-namespace isolation) |

The non-synced files hold **no secret material** (only the Vault address, mount
path, role names, and a PUBLIC CA bundle), so once Vault is permanently live they
MAY be promoted into a small GitOps app — see "Follow-on PRs" below.

---

## §1 — Architecture

```
tenant repo:  ExternalSecret (key names + remoteRef, NO values)  ──┐
                                                                   ▼
ESO controller (external-secrets ns) ──k8s-auth──► Vault (vault ns, TLS)
   reads secret/data/tenants/<team>/<env>/...                     │
   writes ───────────────────────────────────────────────────────┘
   ▼
k8s Secret in <team>-<env>  ──►  app SA reads it (standard RBAC)
```

- **Platform-wide read:** the `ClusterSecretStore` (`vault-backend`) authenticates
  as the **ESO controller SA** via the Vault role `external-secrets` (policy
  `external-secrets-ro`, read on `secret/data/tenants/*` + `platform/*`).
- **Per-tenant isolation (deliverable #5):** each tenant ns gets a **namespaced
  `SecretStore`** (`vault-tenant`) authenticating as the **tenant SA** via a Vault
  role `tenant-<team>` whose policy is scoped to `secret/data/tenants/<team>/*`
  ONLY. A tenant SA cannot read another tenant's path or the platform path.

---

## §2 — Vault policy + role for ESO (runbook step 7)

After the Vault init runbook (`vault/README.md` §D, through `vault auth enable
kubernetes`):

```bash
# Platform ESO read policy + role (binds the ESO controller SA):
kubectl -n vault exec -i vault-0 -- sh < vault-policies/eso-role.sh

# Per-tenant scoped policy + role (run per onboarded team; isolation):
kubectl -n vault exec -i vault-0 -- sh -s -- <team> <env> < vault-policies/tenant-role.sh
```

---

## §3 — Apply the ClusterSecretStore (runbook step 8)

```bash
# Fill in the caBundle (the PUBLIC CA that signed vault-server-tls; git-safe) OR
# switch to caProvider referencing the vault-server-tls Secret — see the file.
kubectl apply -f clustersecretstore.yaml

# Verify it reaches Vault (Ready/Valid):
kubectl get clustersecretstore vault-backend -o jsonpath='{.status.conditions}'
```

Per tenant (rendered from `secretstore-template.yaml` by the scaffolder / tenant PR):

```bash
sed -e 's/__TEAM__/sample/g' -e 's/__ENV__/dev/g' secretstore-template.yaml | kubectl apply -f -
```

---

## §4 — Smoke test (after a value exists in Vault)

```bash
# Put a test value in Vault (KV v2):
kubectl -n vault exec -it vault-0 -- vault kv put secret/tenants/sample/dev/app DATABASE_URL=postgres://demo
# Apply the example ExternalSecret (rendered from the template), then:
kubectl -n sample-dev get externalsecret app-secrets   # STATUS should be SecretSynced
kubectl -n sample-dev get secret app-secrets -o jsonpath='{.data.DATABASE_URL}' | base64 -d
```

---

## §5 — What needs the human's keyboard to go live (summary)

1. **Merge this PR**, then `make bootstrap-reapply` (adds the two chart repos to the
   `platform` AppProject allowlist — **verify it took**, the AppProject is
   bootstrap-managed not GitOps-reconciled).
2. **Decide the Vault unseal strategy** (`vault/README.md` §A — recommendation:
   Transit auto-unseal; ships manual day-1).
3. Run the **Vault init runbook** (`vault/README.md` §D): create `vault-server-tls`,
   sync `platform-vault`, `vault operator init`, unseal, enable KV v2 + k8s auth.
4. Run **§2** here (ESO policy/role) and **§3** (ClusterSecretStore).
5. **Sync the netpols** (manual-sync, SEC-011 gate):
   `argocd app sync platform-netpol-controlplane` — verify ESO still reaches Vault
   and Vault stays Ready (rollback by deleting the new netpols if either breaks).

---

## §6 — Per-tenant onboarding runbook (worked example: v1check)

Greens a tenant's **Degraded `vault-tenant` SecretStore** (the app-repo overlay's
`secretstore.yaml`). Two things must exist before that store can authenticate:
the **`tenant-<team>` Vault role** (operator keyboard — a Vault-admin write) and the
in-ns **`vault-ca` ConfigMap** (the public CA the namespaced store's `caProvider`
reads). `vault-onboard` does both in one shot; or split the CA off to GitOps (below).

### Fastest — one command (creates role + vault-ca):

```bash
make vault-onboard NAME=v1check ENV=dev \
  KUBECONFIG=clusters/real-talos/talos-kubeconfig KUBE_CONTEXT=admin@capstone
```

### The role-create on its own (the Vault-admin keyboard step, for transparency):

```bash
# Runs vault-policies/tenant-role.sh inside vault-0 (env-prefixed with the mounted CA
# so the in-pod vault CLI trusts the server). Creates policy `tenant-v1check-ro`
# (read on secret/data/tenants/v1check/* ONLY) + k8s-auth role `tenant-v1check`
# bound to SA eso-tenant in v1check-{dev,staging,prod,preview}, audience=vault.
kubectl --context admin@capstone -n vault exec -i vault-0 -- \
  env VAULT_CACERT=/vault/userconfig/vault-server-tls/ca.crt sh -s -- v1check dev \
  < platform-services/external-secrets/vault-policies/tenant-role.sh
```

### vault-ca as GitOps (move it off the imperative path):

`vault-onboard` applies `vault-ca` imperatively. To make it declarative instead, emit
it once (reads the **public** CA — git-safe) and commit it into the tenant dir, where
`tenants-appset` reconciles it into `v1check-dev`:

```bash
make vault-ca-manifest NAME=v1check ENV=dev KUBE_CONTEXT=admin@capstone \
  > tenants/team-v1check/vault-ca-dev.yaml
git add tenants/team-v1check/vault-ca-dev.yaml && git commit  # then PR
```

> ⚠ Commit the **real** CA, never a placeholder. The tenant App `selfHeal`s, so a
> placeholder/empty `data.ca.crt` in git would let ArgoCD overwrite a good
> imperatively-created ConfigMap (empty CA → store stays Degraded). With the real CA,
> selfHeal is a feature — it keeps the stable public cert correct. (Agents are
> classifier-gated from prod secret reads, so the operator runs `vault-ca-manifest`.)

### Verify it cleared:

```bash
kubectl --context admin@capstone -n v1check-dev get secretstore vault-tenant \
  -o jsonpath='{.status.conditions}'   # expect Ready/Valid
kubectl --context admin@capstone -n v1check-dev get externalsecret   # SecretSynced
```

---

## §7 — Robot-cred → ESO (retiring SealedSecret-robots-in-git)

Two Harbor robot creds still ship as **SealedSecrets in git**, which the v1 secrets
model (§0, "no secret material in git") aims to retire:

| Secret | Where | Today | Retire to |
|---|---|---|---|
| `harbor-pull` | `tenants/team-<team>/` (`<team>-<env>`) | SealedSecret (`make harbor-robot`) | ExternalSecret → `tenants/<team>/<env>/harbor-pull` |
| `harbor-push-<team>` | `arc-runners` (per-team CI) | SealedSecret (`make harbor-push-robot`) | ExternalSecret → `tenants/<team>/ci/harbor-push` |
| `arc-github-app` | `arc-runners` | SealedSecret (human) | ExternalSecret → `platform/arc/github-app` (unblocks per-team-ns A2, see `../arc/per-team/README.md`) |

**Mechanism.** ESO can materialize a `kubernetes.io/dockerconfigjson` imagePullSecret
from Vault via `target.template` — the robot `{name,secret}` live in Vault as KV-v2
fields and ESO templates them into `.dockerconfigjson`. So the robot mint output goes
to Vault (`vault kv put` / a `PushSecret`) instead of `kubeseal`, and the in-ns
SealedSecret file is replaced by an ExternalSecret (names + remoteRef only).

**Safe now (post Vault-live):** the **`harbor-pull`** migration is the low-risk first
move — the per-tenant `vault-tenant` SecretStore (§6) already exists, so an
ExternalSecret in the app overlay can pull the robot cred from `tenants/<team>/<env>/
harbor-pull` and produce the dockerconfigjson. Do it per team behind a verify (pull a
real image) and keep the SealedSecret until the ESO-materialized pull secret is proven,
then delete it (single-owner — precedent #123). **`arc-github-app` → ESO** is also safe
now and is the thing that makes per-team-ns runner isolation (A2) declarative.

**Needs track-5 (Crossplane) for zero-touch:** robot **minting** is still the
imperative `make harbor-*-robot` + a manual `vault kv put`. Track-5's mint-Job /
Composition should mint the robot and **write it straight to Vault**, so ESO consumes
it with no human seal/paste — that's the fully declarative end-state. Until then the
operator runs the mint once per team and pipes to `vault kv put` instead of `kubeseal`.

**Do not break working:** `harbor-pull` SealedSecrets stay the live path until ESO+Vault
are permanently live AND the per-tenant store is proven per team. No flag-day.

---

## Follow-on PRs (OUT OF SCOPE here — noted per orchestrator scope discipline)

This PR is **platform infra only (ESO + Vault up)**. Separate PRs:

- **Tenant contract:** the `.devops/secrets/` skeleton + overlay refs change from
  `SealedSecret` → `ExternalSecret` (renders `secretstore-template.yaml` per
  `<team>-<env>`); the M4 scaffolder template changes (ADR-030 §6, m4-dev).
- **Secrets-UX #105 backend rework:** `sealCore`'s "seal-and-commit-ciphertext"
  becomes "write the value to Vault (`vault kv put` / `PushSecret`) + commit an
  `ExternalSecret` declaration." The route + authz spine + frontend are reused
  verbatim (ADR-030 §5, m3-dev).
- **GitOps-promote the store wiring:** once Vault is permanently live, move
  `clustersecretstore.yaml` (+ rendered per-tenant SecretStores) into a small
  auto-synced app (they hold no secret material).
