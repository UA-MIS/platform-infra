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
| `vm/appproject-vm.yaml` | the VM-tier tenancy fence — a SEPARATE AppProject `team-404-vm` whitelisting the VM kinds + the cloud-init `Secret`; destinations only `team-404-vm-*`; `clusterResourceWhitelist: []`. |
| `vm/applicationset-vm.yaml` | the VM env ApplicationSet — single-env (prod) App that syncs the app repo's VM chart into `team-404-vm-prod`. **The piece that actually deploys the VM.** |
| `vm/namespaces/vm-prod.yaml` | `team-404-vm-prod` Namespace at PSA `baseline` + VM-sized quota/limitrange + 4 NetworkPolicies + VM-aware Role/RoleBinding (console/VNC + power). |
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

Replace three tokens everywhere — `team-404` (team slug, a DNS label), `team-404`
(the app repo name — `UA-MIS/<appName>`, NOT `<team>-app`), and `2026-fall`
(cohort, e.g. `2026-fall`). Substitute `team-404` BEFORE `team-404` so a
`team-404`-prefixed appName isn't half-replaced:

```bash
TEAM=acme APPNAME=acme SEMESTER=2026-fall
cp -r tenants/_template-vm tenants/team-$TEAM
grep -rl 'team-404\|team-404\|2026-fall' tenants/team-$TEAM \
  | xargs sed -i "s/team-404/$APPNAME/g; s/team-404/$TEAM/g; s/2026-fall/$SEMESTER/g"
git add tenants/team-$TEAM && git commit -m "onboard VM team $TEAM ($SEMESTER)"
```

(The scaffolder `New Capstone VM` template does exactly this via
`capstone:render-tenant`, then opens the onboarding PR.)

## Tokens

| Token | Meaning | Example |
| --- | --- | --- |
| `team-404` | team slug — the VM AppProject name + `team-404-vm-*` namespace prefix + OIDC/RBAC group `team-404-developers` (D-026) | `acme` |
| `team-404` | the app repo name — `UA-MIS/<appName>` (repo == appName, #101); the VM ApplicationSet + AppProject source point here | `acme` |
| `2026-fall` | cohort label — the universal GC/report selector | `2026-fall` |

## The team's web console ships CLOSED — one thing to do per tenant

A VM tenant's browser shell (`<team>-console.uamishub.com`, ttyd in the guest) is
**not published by onboarding**. The tenant chart creates the console *Service*
(ClusterIP, in-cluster only) but deliberately leaves out the *Ingress*, which lives
in an opt-in kustomize component that ships commented out in the tenant repo's
`.devops/chart/overlays/prod/kustomization.yaml`.

This is a security default, not an oversight. The console hostname rides the shared
`*.uamishub.com` tunnel rule, so it needs no tunnel change and goes live the instant
the Ingress exists — and anyone past Cloudflare Access lands in a shell that can
`sudo`. **Access is the only wall in front of it.** Publishing before the Access
application exists is an unauthenticated root shell on the public internet, and it
already happened once on the first VM tenant.

To turn a team's console on, in this order:

1. **Create the Cloudflare Access application first** — Zero Trust → Access →
   Applications → Add → Self-hosted; domain `<team>-console.uamishub.com`; policy
   **Allow**, scoped to that team's emails. Never Bypass, never Service Auth
   (Cloudflare does not support either on browser-rendered apps, and Bypass here is
   an open shell).
2. Uncomment the `components:` block in the tenant repo's prod overlay and merge.
3. **Verify from outside the cluster.** This is the check that matters:

   ```bash
   curl -sSI https://<team>-console.uamishub.com/ | head -1
   #  HTTP/2 302  -> correct: Cloudflare Access is in front of it
   #  HTTP/2 200  -> STOP: the shell is open to the internet
   #  HTTP/2 502  -> Ingress is up but ttyd is not (see the guest's cloud-init)
   ```

Until step 2 the team still has SSH, and the console still works in-cluster — only
the public route is withheld.

> **This is a guardrail, not an interlock.** Nothing verifies that the Access app
> exists before the component is enabled; a person can still do step 2 before step 1.
> What it buys is that the unsafe state no longer happens *automatically* to every
> scaffolded tenant — it takes a deliberate, reviewable commit. The real interlock is
> extending the `cf-vm-access` reconciler (ADR-038) to provision the Access app and
> the Ingress together; the console Service already carries the
> `platform.capstone/access: console` label and `console-access-emails` annotation
> for exactly that.

## Prerequisites (ADR-032 — blocking for RUN, not for onboarding)

KubeVirt + CDI must be installed (platform ArgoCD apps) and the KVM-on-Talos +
SEC-011 VM-tier deny-test prerequisites cleared before a rendered VM actually runs.
The manifests validate + the onboarding PR merges independently of that.
