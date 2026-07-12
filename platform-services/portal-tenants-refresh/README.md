# portal-tenants-refresh

Publishes the **"Live on the platform"** list rendered on the public apex portal
(`capstone.uamishub.com` → `platform-services/portal/site/index.html`).

## Why

The apex page used to hardcode a single `<a class="app-card">` for one app, so it
never reflected new tenants. This service makes that list **dynamic**: the page
fetches a small same-origin JSON and renders one card per live tenant.

## How it works

```
live PROD Ingresses (label platform.capstone/env=prod)
        │  (Job / CronJob: kubectl + jq)
        ▼
portal-tenants ConfigMap  (namespace: portal, data.tenants.json = [{name,url}, ...])
        │  (mounted non-subPath at /usr/share/nginx/html/data)
        ▼
portal nginx serves  /data/tenants.json   ── fetched by index.html JS ──►  app-cards
```

- **Source of truth = live prod Ingresses.** Every tenant's prod front door is an
  Ingress labelled `platform.capstone/env=prod` with host `<app>.capstone.uamishub.com`.
  This captures both Crossplane-onboarded tenants and legacy/VM apps, needs no host
  derivation, and self-heals on teardown. `db-console`/adminer Ingresses lack the
  `env` label and are excluded; dev/staging/preview carry other env values and are
  excluded. See `configmap.yaml` for the script.
- **Only public data is published** — app name + already-public prod URL. The apex
  page is served **pre-sign-in**, so nothing internal is ever emitted. The page's JS
  additionally hard-validates each URL against `^https://…\.capstone\.uamishub\.com/?$`.
- **`portal-tenants` ConfigMap is controller-owned** — it is created/updated only by
  these Jobs and is deliberately NOT part of any kustomize/ArgoCD app, so there is no
  GitOps self-heal fight over its `.data`. The portal Deployment mounts it
  `optional: true`, so pods start fine before the first run.

## Objects

| File | Object | Namespace |
|------|--------|-----------|
| `serviceaccount.yaml` | ServiceAccount `portal-tenants-refresh` | crossplane-system |
| `rbac.yaml` | ClusterRole/Binding (get/list Ingresses) + Role/Binding (write the one ConfigMap) | crossplane-system / portal |
| `configmap.yaml` | the refresh script | crossplane-system |
| `cronjob.yaml` | CronJob, every 10 min — steady-state freshness | crossplane-system |
| `seed-job.yaml` | PostSync hook Job — immediate populate on each sync | crossplane-system |

The refresher runs in **crossplane-system** (not `portal`) so it inherits that
namespace's apiserver egress; the `portal` namespace is intentionally default-deny /
DNS-only egress. Same placement rationale and image (`alpine/k8s`) as the sibling
`crossplane-mr-prune` CronJob.

## Operational note

Editing `portal/site/index.html` (subPath-mounted, stable ConfigMap name) requires a
one-time `kubectl rollout restart deploy/portal -n portal` to take effect — this is
existing portal behaviour, not new. **Ongoing tenant changes need NO restart**: they
only change `/data/tenants.json` (non-subPath mount), which the portal picks up live.
