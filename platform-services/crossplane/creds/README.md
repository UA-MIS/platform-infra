# Crossplane provider credentials — ⚠ SECURITY: one-time SRE review + reseal

These three `SealedSecret`s carry the four Crossplane providers' admin credentials
(provider-kubernetes uses in-cluster `InjectedIdentity`, so it needs no secret —
see `config/providerconfig-kubernetes.yaml`). They are the **only** privileged
credentials in the whole onboarding stack and they live **only** in
`crossplane-system` (never in Backstage, never with humans), per ADR-031 §6.

> **⚠ SECURITY FLAG (for the one-time SRE review, ADR-031 constraint #4).** The
> ciphertext committed here is a **PLACEHOLDER** (the same pattern as PR #120's
> ArgoCD repo-creds). It will NOT decrypt. Before go-live the operator must reseal
> each with the REAL scoped credential against the live cluster's sealed-secrets
> controller. **Until then the providers will sit unauthenticated (not reconciling)
> — which is the safe failure mode.** Agents cannot reach the cluster to seal; this
> is the operator's keyboard (matches the platform's "agents can't do cluster
> writes" classifier gate).

## What each one is (and the least-privilege scope to grant)

| File | Secret (crossplane-system) | Credential — scope to grant (NOT admin) |
| --- | --- | --- |
| `github-app-creds-sealed.yaml` | `github-provider-creds` | the EXISTING `ua-mis-backstage` GitHub App (App ID 4097147, install 141394298). JSON: `{"app_auth":[{"id":"4097147","installation_id":"141394298","pem_file":"<PEM \n-escaped>"}],"owner":"UA-MIS"}` |
| `harbor-provisioner-creds-sealed.yaml` | `harbor-provider-creds` | a Harbor PROVISIONER ROBOT — project + robot + member admin ONLY (derive from harbor-admin; do NOT use harbor-admin itself). JSON: `{"url":"https://harbor-core.harbor.svc","username":"robot$provisioner","password":"<token>"}` |
| `vault-provisioner-creds-sealed.yaml` | `vault-provider-creds` | a Vault token with a `tenant-provisioner` policy: write `sys/policies/acl/tenant-*` + `auth/kubernetes/role/tenant-*` ONLY. JSON: `{"token":"<token>","address":"https://vault.vault.svc.cluster.local:8200"}` |

## Resealing the real values (operator, at go-live)

```bash
# Example: GitHub App creds. Build the JSON, seal it for crossplane-system, replace the stub.
PEM=$(awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' ua-mis-backstage.pem)   # \n-escape the key
cat > /tmp/gh.json <<EOF
{"app_auth":[{"id":"4097147","installation_id":"141394298","pem_file":"${PEM}"}],"owner":"UA-MIS"}
EOF
kubectl create secret generic github-provider-creds \
  --namespace crossplane-system --from-file=credentials=/tmp/gh.json \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace sealed-secrets --controller-name sealed-secrets \
    --format yaml > platform-services/crossplane/creds/github-app-creds-sealed.yaml
rm -f /tmp/gh.json
# Repeat for harbor-provider-creds and vault-provider-creds with their scoped values.
```

The `tenant-provisioner` Vault policy (run once, alongside the ESO/tenant policies
in `platform-services/external-secrets/vault-policies/`):

```hcl
# secret/data/tenants/* is read by ESO; the PROVISIONER only manages policy + k8s roles.
path "sys/policies/acl/tenant-*"        { capabilities = ["create","update","read","delete"] }
path "auth/kubernetes/role/tenant-*"    { capabilities = ["create","update","read","delete"] }
```
