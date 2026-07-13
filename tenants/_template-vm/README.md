# tenants/_template-vm — the VM-tenant blueprint (KubeVirt `layout: vm`, ADR-032)

Copy this directory to onboard a team that deploys a **real virtual machine** as an
app (a whole legacy/desktop/appliance stack lifted into one self-contained VM,
because it can't/won't be containerized). It is the VM analogue of
`tenants/_template/` — a **separate** blueprint on purpose (see "Why a separate
blueprint" below).

The `tenants-appset` git generator (`applicationsets/tenants-appset.yaml`) detects
the rendered `tenants/team-<name>/` directory and ArgoCD reconciles the team's VM
AppProject, `<team>-vm-prod` namespace (quota/limitrange/netpol/RBAC), and the VM
ApplicationSet. **No imperative `kubectl`, no cluster-admin action** — merging the
onboarding PR is the grant (D-049).

> **Underscore-prefixed = not a live tenant.** Like `tenants/_template` and
> `tenants/_claims`, `tenants/_template-vm` is EXCLUDED from the `tenants`
> ApplicationSet (the `tenants/_*` exclude). It becomes live only when it is copied
> (by the scaffolder `capstone:render-tenant` action, or by hand) into a real
> `tenants/team-<x>/`.

## What's here

| File | Purpose |
| --- | --- |
| `vm/appproject-vm.yaml` | the VM-tier tenancy fence — a SEPARATE AppProject `__TEAM__-vm` whitelisting the VM kinds + the cloud-init `Secret`; destinations only `__TEAM__-vm-*`; `clusterResourceWhitelist: []`. |
| `vm/applicationset-vm.yaml` | the VM env ApplicationSet — single-env (prod) App that syncs the app repo's VM chart into `__TEAM__-vm-prod`. **The piece that actually deploys the VM.** |
| `vm/namespaces/vm-prod.yaml` | `__TEAM__-vm-prod` Namespace at PSA `baseline` + VM-sized quota/limitrange + 4 NetworkPolicies + VM-aware Role/RoleBinding (console/VNC + power). |
| `vm/README.md` | the security rationale for the tier (PSA `baseline`, the fence, sizing). |

## Why a separate blueprint (not `tenants/_template` + a `vm/` subtree)

`capstone:render-tenant` copies the **entire** blueprint tree it is pointed at, then
substitutes tokens — it is intentionally layout-agnostic (one code path, D-M4-2).
So the blueprint a VM tenant is rendered from must contain **only** the VM tier:

- A VM tenant has **no** container overlays, so it must NOT get the container
  `applicationset-envs.yaml` / `applicationset-preview.yaml`. Those render a
  dev/staging/prod matrix against the app repo's `promotion.yaml`; a `layout: vm`
  promotion.yaml has only `environments.prod`, so the container envs appset
  render-fails and the tenant goes `Synced/Degraded` (the #376 bug, first half).
- Conversely a container tenant must NOT get a `vm/` subtree (a baseline-PSA
  namespace + VM AppProject it never uses). Keeping `vm/` inside `tenants/_template`
  would leak it into every container tenant `render-tenant` copies.

Pointing the `vm-app` template's `render-tenant` step at **this** blueprint
(`templateUrl: .../tenants/_template-vm`) — and the container templates at
`.../tenants/_template` — keeps `capstone:render-tenant` **unchanged** (no `layout`
input, **no Backstage image rebuild**; the `templateUrl` is a git-served template
input, not compiled code). This is option (b) of the render-layout fix.

## Onboarding a VM team (the one-liner)

Replace three tokens everywhere — `__TEAM__` (team slug, a DNS label), `__APPNAME__`
(the app repo name — `UA-MIS/<appName>`, NOT `<team>-app`), and `__SEMESTER__`
(cohort, e.g. `2026-fall`). Substitute `__APPNAME__` BEFORE `__TEAM__` so a
`__TEAM__`-prefixed appName isn't half-replaced:

```bash
TEAM=acme APPNAME=acme SEMESTER=2026-fall
cp -r tenants/_template-vm tenants/team-$TEAM
grep -rl '__APPNAME__\|__TEAM__\|__SEMESTER__' tenants/team-$TEAM \
  | xargs sed -i "s/__APPNAME__/$APPNAME/g; s/__TEAM__/$TEAM/g; s/__SEMESTER__/$SEMESTER/g"
git add tenants/team-$TEAM && git commit -m "onboard VM team $TEAM ($SEMESTER)"
```

(The scaffolder `New Capstone VM` template does exactly this via
`capstone:render-tenant`, then opens the onboarding PR.)

## Tokens

| Token | Meaning | Example |
| --- | --- | --- |
| `__TEAM__` | team slug — the VM AppProject name + `__TEAM__-vm-*` namespace prefix + OIDC/RBAC group `__TEAM__-developers` (D-026) | `acme` |
| `__APPNAME__` | the app repo name — `UA-MIS/<appName>` (repo == appName, #101); the VM ApplicationSet + AppProject source point here | `acme` |
| `__SEMESTER__` | cohort label — the universal GC/report selector | `2026-fall` |

## Prerequisites (ADR-032 — blocking for RUN, not for onboarding)

KubeVirt + CDI must be installed (platform ArgoCD apps) and the KVM-on-Talos +
SEC-011 VM-tier deny-test prerequisites cleared before a rendered VM actually runs.
The manifests validate + the onboarding PR merges independently of that.
