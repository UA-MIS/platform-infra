# Harbor — self-hosted OCI registry (P2.2, §1.5, D-022)

Harbor is the platform's container registry: **per-team projects**, **Trivy
scan-on-push**, **OIDC via the shared Dex broker** (NO new GitHub OAuth app).
Replaces the Phase-1 k3d built-in registry; the `REGISTRY` variable abstracts the
swap. At `https://harbor.127-0-0-1.sslip.io` (wildcard TLS via Traefik).

- Chart: `harbor` **v1.19.1** (pinned), Helm-source Application
  `applicationsets/harbor-app.yaml` (deploy method A — see below).
- Storage: `local-path` (Phase-2). Ceph is Phase-4.
- Bundled postgres + redis (Phase-2 local). External DB is Phase-4.
- Prereqs (ns + SealedSecrets) sync via the platform-services-appset (this dir);
  the chart installs into the `harbor` namespace as a separate Application.

## ⚠ DEPLOY METHOD — pending human confirm (A vs B)
Harbor is **Helm-only** upstream. Two integration methods (sets the precedent for
all Phase-2 Helm services — Vault/Backstage/Grafana):
- **(A) Helm-source Application** (built here, orchestrator-recommended): pin the
  chart + add `https://helm.goharbor.io` to the `platform` AppProject `sourceRepos`
  allowlist (done in `bootstrap/platform-appproject.yaml` — **DO NOT MERGE that
  allowlist change until the human confirms A**; security audits it).
- **(B) kustomize helm-inflation**: render the chart from platform-infra (keeps
  `sourceRepos` = platform-infra only) + set repo-server `kustomize.buildOptions:
  --enable-helm`. The values block below is method-portable — a pivot to B reuses
  it verbatim under a `helmCharts:` kustomization.

## OIDC via Dex — two parts
1. **Already wired (this PR):** a `harbor` static client in Dex
   (`platform-services/dex/configmap.yaml`), its secret sealed in BOTH `dex-github`
   (`harbor-client-secret`) and `harbor-oidc` (`oidc-client-secret`) — same value.
   Harbor-core reaches the issuer `id.127-0-0-1.sslip.io` IN-CLUSTER via the
   existing `coredns-custom` rewrite -> Traefik -> Dex (slice-1 pattern, reused —
   no new DNS rewrite needed). Same self-signed-CA caveat as ArgoCD applies.
2. **Post-install (Harbor system-config, NOT in the chart):** set Harbor
   `auth_mode = oidc_auth` pointing at Dex. The chart does not configure auth-mode;
   it's applied via the Harbor API once core is up. Apply with:
   ```
   # admin creds from the SealedSecret:
   ADMIN=$(kubectl -n harbor get secret harbor-admin -o jsonpath='{.data.HARBOR_ADMIN_PASSWORD}' | base64 -d)
   CS=$(kubectl -n harbor get secret harbor-oidc -o jsonpath='{.data.oidc-client-secret}' | base64 -d)
   curl -sk -u "admin:$ADMIN" -X PUT https://harbor.127-0-0-1.sslip.io/api/v2.0/configurations \
     -H 'Content-Type: application/json' -d '{
       "auth_mode": "oidc_auth",
       "oidc_name": "dex",
       "oidc_endpoint": "https://id.127-0-0-1.sslip.io",
       "oidc_client_id": "harbor",
       "oidc_client_secret": "'"$CS"'",
       "oidc_scope": "openid,profile,email,groups",
       "oidc_groups_claim": "groups",
       "oidc_auto_onboard": true,
       "oidc_user_claim": "preferred_username",
       "oidc_verify_cert": false
     }'
   ```
   `oidc_verify_cert: false` mirrors ArgoCD's `skip.verify` (self-signed platform CA,
   in-cluster; Phase-3 removal when the issuer goes ACME-public). This should be a
   GitOps post-sync **Job** (a `configure-oidc` Job keyed off the SealedSecrets) so
   it's declarative + idempotent — added as a follow-up sub-step once method A/B is
   confirmed (it differs slightly per method). Documented here as the manual form.

## Per-team projects + RBAC (D-026: identifier = `<name>`)
Each team gets a Harbor **project** named `<name>` (= AppProject = GitHub Team slug
= OIDC group suffix). The OIDC `groups` claim (`UA-MIS:<name>`) maps to the Harbor
project member role. Onboarding (per project, ideally a Job/Scaffolder step):
```
# create the project (private):
curl -sk -u "admin:$ADMIN" -X POST https://harbor.127-0-0-1.sslip.io/api/v2.0/projects \
  -H 'Content-Type: application/json' -d '{"project_name":"<name>","metadata":{"public":"false","auto_scan":"true"}}'
# map the OIDC group UA-MIS:<name> -> Developer (or Maintainer) role on <name>:
curl -sk -u "admin:$ADMIN" -X POST https://harbor.127-0-0-1.sslip.io/api/v2.0/projects/<name>/members \
  -H 'Content-Type: application/json' -d '{"role_id":2,"member_group":{"group_name":"UA-MIS:<name>","group_type":3}}'
```
`group_type:3` = OIDC group. `role_id:2` = Developer (push/pull). Mirrors the
ArgoCD `role:<name>` scoping — same `<name>` slug everywhere.

## Robot accounts -> sealed imagePullSecret (per team)
CI (Kaniko, §1.3) pushes with a **per-project robot account**; team workload pulls
with a robot too. Pattern: create a project-scoped robot, capture its token, write
a `dockerconfigjson` Secret, seal it into the team's namespace overlay:
```
# create a pull robot scoped to project <name>:
curl -sk -u "admin:$ADMIN" -X POST https://harbor.127-0-0-1.sslip.io/api/v2.0/projects/<name>/robots \
  -H 'Content-Type: application/json' -d '{"name":"<name>-pull","duration":-1,"permissions":[{"kind":"project","namespace":"<name>","access":[{"resource":"repository","action":"pull"}]}]}'
# -> returns {name, secret}; build a docker config + seal into <name>-<env>:
kubectl create secret docker-registry harbor-pull \
  --docker-server=harbor.127-0-0-1.sslip.io \
  --docker-username='robot$<name>+<name>-pull' --docker-password='<secret>' \
  -n <name>-dev --dry-run=client -o yaml \
  | kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
      --format yaml --namespace <name>-dev > .../overlays/dev/harbor-pull-sealed.yaml
```
The team's Deployment references `imagePullSecrets: [{name: harbor-pull}]`.

## Trivy gate strength — SHOULD-DECIDE (flag for the human, D-022)
Trivy is **enabled** + projects set `auto_scan:true` (scan-on-push). The question
is whether a HIGH/CRITICAL finding **BLOCKS** pull/deploy or only **WARNS**:
- **Default shipped here = scan + WARN** (scan runs, results visible, nothing
  blocked) — safest for a teaching platform (students aren't blocked mid-demo by a
  base-image CVE they can't fix).
- **Block mode** = set the project's "Prevent vulnerable images from running"
  (severity threshold). Recommend enabling for `prod`-tagged pulls later, not for
  dev/preview. **Human decision** on threshold + which envs.

## Validation (post-merge + post-method-confirm)
- Harbor UI reachable over TLS at https://harbor.127-0-0-1.sslip.io; `admin` login
  with the sealed password.
- After the OIDC post-install: "LOGIN VIA OIDC PROVIDER" works (UA-MIS member).
- `docker login harbor.127-0-0-1.sslip.io` + push a test image; Trivy scan appears.
- Per-team project isolation: a `<name>` member sees only project `<name>`.
