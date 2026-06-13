# platform-services (Phase 1)

ArgoCD-managed cluster services, fanned in by `platform-services-appset` (T3):
each subdirectory becomes one Application in the privileged `platform` AppProject.
All three are pinned and self-contained; ordering within cert-manager is handled
by ArgoCD sync waves.

| Service | What it installs | Namespace | Interface (§5) |
| --- | --- | --- | --- |
| `cert-manager/` | cert-manager v1.20.2 + self-signed CA issuer chain + wildcard `Certificate` for `*.${PLATFORM_DOMAIN}` | `cert-manager` (install), `kube-system` (wildcard secret) | exposes `ClusterIssuer` `platform-ca-issuer` + the wildcard TLS secret `wildcard-platform-tls`; consumed by Traefik (§5.1) |
| `traefik/` | configures the **bundled** k3s/k3d Traefik (D-010): default `TLSStore` + `HelmChartConfig` | `kube-system` | serves `*.${PLATFORM_DOMAIN}` on host :80/:443 using the wildcard secret; consumed by every team `Ingress` (§5.2) |
| `sealed-secrets/` | Sealed Secrets controller v0.37.0 | `kube-system` | exposes the `SealedSecret` CRD + controller cert (for `kubeseal`); decrypts to in-namespace `Secret` (§5.3, D-006) |

## How TLS flows (Phase 1, no ACME)

```
cert-manager selfsigned-bootstrap (ClusterIssuer)
      └─ signs ─> platform-ca (CA Certificate, secret platform-ca-keypair)
              └─ platform-ca-issuer (ClusterIssuer, ca: platform-ca-keypair)
                      └─ signs ─> wildcard-platform-tls (*.${PLATFORM_DOMAIN})
                                    secret in kube-system
                                          └─ Traefik default TLSStore serves it
```

A team `Ingress` for `sample.sample.127.0.0.1.sslip.io` with TLS enabled is
served the wildcard cert automatically — no per-Ingress secret needed.

**Phase-3 swap:** replace `platform-ca-issuer` with an ACME DNS-01 ClusterIssuer
(Cloudflare). The wildcard Certificate's `issuerRef.name` is unchanged, so nothing
downstream moves — an issuer change, not an app change (§5.1, §6).

## Sealing a secret (D-006, D-008 per-namespace scope)

```bash
# from platform-infra/, with the cluster up and sealed-secrets controller running:
kubectl -n <team>-<env> create secret generic sample-secret \
  --from-literal=app-secret=... --dry-run=client -o yaml > /tmp/s.yaml
make seal SECRET=/tmp/s.yaml NS=<team>-<env> > .../overlays/<env>/sealedsecret.yaml
```

The SealedSecret only decrypts in the namespace it was sealed for (strict scope).
