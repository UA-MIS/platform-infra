# Dex — platform OIDC broker (P2.1, §1.1, D-017)

Dex is the platform's **sole OIDC broker**. Identity = **GitHub org membership in
`UA-MIS`**. One connector (GitHub), org-gated at the connector level: Dex only
issues a token to UA-MIS members and surfaces their **GitHub Teams as the OIDC
`groups` claim**. ArgoCD (and, later, Backstage/Grafana/Harbor) register as
static OIDC clients and federate here — one GitHub OAuth app, unified SSO.

- Issuer / ingress: `https://id.127-0-0-1.sslip.io` (wildcard TLS via Traefik).
- Storage: Kubernetes CRDs (`storage.type: kubernetes`) — stateless, no DB.
- Image: `ghcr.io/dexidp/dex:v2.45.1` (pinned).
- Managed by the `platform-services-appset` (one Application per dir).

## Group claim format

`loadAllGroups: true` + `teamNameField: slug` => groups look like
`UA-MIS:<team-slug>` plus the bare org `UA-MIS`. ArgoCD RBAC (see
`bootstrap/argocd-install/kustomization.yaml`, the `argocd-rbac-cm` patch) binds:

| GitHub Team / org | OIDC group | ArgoCD role |
| --- | --- | --- |
| `capstone-admin` Team | `UA-MIS:capstone-admin` | `role:admin` |
| any UA-MIS member | `UA-MIS` | `role:readonly` (baseline) |
| `team-<name>` Team | `UA-MIS:team-<name>` | `role:team-<name>` (scoped to its AppProject) |

Local `admin` (argocd-secret) stays as **break-glass** — untouched by SSO.

---

## ⚠️ HUMAN STEP — register the GitHub OAuth app (one-time, self-service)

Dex's GitHub connector needs an OAuth app in the **UA-MIS org**. The org admin
registers it himself — **no UA-IT, no ticket**.

1. Go to: **GitHub → your org `UA-MIS` → Settings → Developer settings →
   OAuth Apps → New OAuth App**
   (URL: `https://github.com/organizations/UA-MIS/settings/applications`)
2. Fill in:
   - **Application name:** `Capstone IDP — Dex`
   - **Homepage URL:** `https://id.127-0-0-1.sslip.io`
   - **Authorization callback URL:** `https://id.127-0-0-1.sslip.io/callback`
     (this MUST match Dex's `redirectURI` exactly)
3. Click **Register application**.
4. Copy the **Client ID**.
5. Click **Generate a new client secret**, copy the **Client secret** (shown once).

> Scope note: org+team membership reads use the `read:org` scope; Dex requests it
> during the OAuth grant, so nothing extra to configure on the app itself. No app
> "permissions" page to set — it's a classic OAuth App.

**Return to the platform team:** the **Client ID** + **Client secret**. Then run
the re-seal below.

---

## Re-seal the GitHub credentials (after the human returns Client ID + secret)

The committed `sealedsecret.yaml` currently holds **placeholder** GitHub creds
(the broker starts but GitHub login fails until this is done). The
`argocd-client-secret` key is already real (platform-generated) — preserve it.

```bash
# from platform-infra/, cluster up, sealed-secrets controller running:

# 1. Recover the existing argocd static-client secret (already live), so we keep
#    Dex and ArgoCD in sync:
ARGOCD_CLIENT_SECRET=$(kubectl -n dex get secret dex-github \
  -o jsonpath='{.data.argocd-client-secret}' | base64 -d)

# 2. Rebuild the plaintext Secret with the REAL GitHub values:
cat > /tmp/dex-secret.yaml <<EOF
apiVersion: v1
kind: Secret
metadata: { name: dex-github, namespace: dex }
type: Opaque
stringData:
  client-id: "<PASTE GITHUB CLIENT ID>"
  client-secret: "<PASTE GITHUB CLIENT SECRET>"
  argocd-client-secret: "${ARGOCD_CLIENT_SECRET}"
EOF

# 3. Re-seal (scoped to the dex namespace) and overwrite the committed file:
make seal SECRET=/tmp/dex-secret.yaml NS=dex \
  > platform-services/dex/sealedsecret.yaml

# 4. Commit on a branch + PR (main is protected). ArgoCD syncs the new
#    SealedSecret; the controller decrypts it; then restart Dex to reload config:
kubectl -n dex rollout restart deploy/dex
```

> If `dex-github` doesn't exist yet (first install), skip step 1 and instead reuse
> the `argocd-client-secret` value from the matching `argocd-dex-client`
> SealedSecret, or regenerate BOTH together (Dex's `argocd` staticClient secret
> and the argocd-config `oidc.dex.clientSecret` must be identical).

## Validate

```bash
# Dex healthy:
kubectl -n dex get pods
curl -sk https://id.127-0-0-1.sslip.io/.well-known/openid-configuration | jq .issuer
# -> "https://id.127-0-0-1.sslip.io"

# ArgoCD UI: open https://argocd.127-0-0-1.sslip.io -> "LOG IN VIA Dex (GitHub)".
# A UA-MIS member lands with their mapped role; a non-member is rejected at GitHub/Dex.
```
