# ArgoCD install notes (Phase 1) + Phase-3 HA seam

## What we install (Phase 1)
- Source: upstream `manifests/install.yaml` pinned to **v3.4.3**, applied via
  `kustomization.yaml` into the `argocd` namespace.
- **Single-replica** (non-HA). Phase 1 runs on a laptop; one of each component
  is sufficient. The applicationset controller IS included (it ships in the
  upstream install) — required for the env/preview ApplicationSets (T7).
- `server.insecure: "true"` — the API/UI server speaks HTTP; TLS terminates at
  Traefik using the wildcard cert from cert-manager (T4). Do NOT expose the
  server with its own self-signed cert; the ingress owns TLS.

## Accessing ArgoCD (Phase 1)
- Initial admin password: `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`
- UI/CLI via the Traefik ingress once T4 wires `argocd.<PLATFORM_DOMAIN>`, or
  `kubectl -n argocd port-forward svc/argocd-server 8080:80` before then.

## Phase-3 HA migration seam (NOT built now)
When moving to the real cluster, swap the `resources:` base from
`manifests/install.yaml` to `manifests/ha/install.yaml` (same repo, same tag)
for the multi-replica/Redis-HA topology, and add resource requests/limits +
PodDisruptionBudgets. Everything else (root-app, appsets, AppProjects) is
unchanged — they are CRs ArgoCD reconciles regardless of its own replica count.
