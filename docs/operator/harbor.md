# Harbor (registry)

Harbor is the platform's self-hosted OCI registry: per-team projects, Trivy
scan-on-push, OIDC login via the shared Dex broker. It lives at
`https://harbor.capstone.uamishub.com` (wildcard TLS via Traefik).

- Chart `harbor` v1.19.1 (pinned), Helm-source Application
  `applicationsets/harbor-app.yaml` → `harbor` namespace.
- Storage on `ceph-block` (Rook RBD, replica-3). Bundled postgres + redis.
- Source of truth: `platform-services/harbor/README.md` and
  `platform-services/harbor-onboarding/README.md`.

> The `harbor` chart repo (`https://helm.goharbor.io`) is in the **install-owned**
> `platform` AppProject `sourceRepos`. After any `bootstrap/` change, run
> `make bootstrap-reapply` and verify — see [ArgoCD & GitOps](argocd-gitops.md).

---

## Identity & access

- **Admin** — the `harbor-admin` SealedSecret in the `harbor` namespace:
  ```bash
  kubectl -n harbor get secret harbor-admin -o jsonpath='{.data.HARBOR_ADMIN_PASSWORD}' | base64 -d
  ```
- **Team members** — log in via "LOGIN VIA OIDC PROVIDER" (Dex → GitHub UA-MIS
  membership). `oidc_auto_onboard:true` means a member carrying the `UA-MIS:<team>`
  group claim is auto-created and sees **only** their own project. Auth mode
  (`oidc_auth`) is set post-install via the Harbor API, not the chart — see the
  `auth_mode` PUT in `platform-services/harbor/README.md`.

---

## Projects + robots (the per-team model)

Every team gets a Harbor **project** named `<team>` (= AppProject = GitHub Team
slug = OIDC group suffix `UA-MIS:<team>` = namespace prefix — one slug everywhere,
D-026). Within a project there are **two robot accounts**:

| Robot | Scope | Who uses it | Provisioned by |
| --- | --- | --- | --- |
| **pull** (`<team>-pull`) | `pull` on `repository` in project `<team>` only | the team's workload pods (`imagePullSecrets: [harbor-pull]`) | `make harbor-robot` |
| **CI push** (`<team>-ci-push`) | `pull`+`push` on `repository` in project `<team>` only | Kaniko in the team's ARC runner | `make harbor-push-robot` |

Both are **least-privilege, project-scoped** — a robot can never reach another
team's project (the registry-side tenant fence). Harbor requires `pull` alongside
`push` (you cannot push without pull), so the CI robot carries both.

### Onboarding a team into Harbor

```bash
# 1) Create the private auto-scan project + map the OIDC group -> Developer (idempotent;
#    409 "already exists" is treated as success). Runs as an in-cluster Job in the
#    harbor ns so admin creds never leave the cluster.
make harbor-onboard NAME=<team> KUBE_CONTEXT=admin@capstone

# 2) Mint the workload PULL robot -> SealedSecret on stdout. Redirect into the team's
#    namespace overlay and commit (the token is Harbor-generated and one-time, so it
#    cannot be declarative).
make harbor-robot NAME=<team> ENV=dev KUBE_CONTEXT=admin@capstone > harbor-pull-sealed.yaml

# 3) Mint the CI PUSH robot -> SealedSecret into the runner namespace.
make harbor-push-robot NAME=<team> RUNNER_NS=arc-runners \
  PUSH_SECRET_NAME=harbor-push-<team> KUBE_CONTEXT=admin@capstone > harbor-push-sealed.yaml
```

`make harbor-robot`/`harbor-push-robot` mint the robot via an in-cluster Job that
calls the Harbor API, parse the `{name,secret}`, build a `docker-registry` Secret,
and `kubeseal` it (strict to the target namespace). Re-running regenerates the
token (it is not idempotent — re-seal and commit the new ciphertext).

> **CI push consumption = Option C (container hook).** In ARC `containerMode:
> kubernetes` the build runs in its own job-step pod, so a secret on the runner pod
> is invisible. `arc-hook-template` merges `harbor-push` into the build container at
> `/kaniko/.docker/config.json` — see `platform-services/arc/README.md` (and the
> ARC page in the developer docs).

> **⚠ Shared `harbor-push` is last-write-wins** (retro #4). One shared
> `harbor-push` secret on the single org-wide `ua-mis-kaniko` scale set means only
> one team's push cred is live at a time. The **per-team** model (one scale set per
> team, `harbor-push-<team>`, `runs-on: <team>-kaniko`) is in
> `platform-services/arc/per-team/README.md`, and is what Crossplane onboarding
> renders declaratively — see [Crossplane onboarding](crossplane-onboarding.md).

---

## The unified robots API (Harbor v2.15)

Harbor v2.15 **removed** the legacy per-project endpoint
`POST /api/v2.0/projects/<name>/robots` (it returns `NOT_FOUND` even when the
project exists). All robot creation now goes through the **unified** endpoint with
`level: project` and the project named in `permissions[].namespace`:

```bash
# what the make targets POST (admin-authed, in-cluster against harbor-core.harbor.svc):
curl -sS -u "admin:$HARBOR_ADMIN_PASSWORD" \
  -X POST http://harbor-core.harbor.svc:80/api/v2.0/robots \
  -d '{"name":"<team>-pull","duration":-1,"level":"project",
       "permissions":[{"kind":"project","namespace":"<team>",
         "access":[{"resource":"repository","action":"pull"}]}]}'
```

The returned robot `name` is **prefixed** `<project>+<name>` (e.g.
`robot$<team>+<team>-pull`) — that prefixed form is the docker username. The make
targets parse `{name,secret}` straight from the response.

---

## Trivy scan gate

Projects are created with `auto_scan:true` (scan-on-push). The shipped default is
**scan + WARN** (results visible, nothing blocked) — safest for a teaching
platform. To enforce, set the project's "Prevent vulnerable images from running"
threshold (recommend `prod` pulls only, not dev/preview). That is a human
decision, project-by-project.

---

## Day-2 checks

```bash
kubectl -n harbor get pods                       # core/jobservice/registry/trivy/db/redis Running
kubectl -n argocd get app platform-harbor        # Synced/Healthy
# UI + a test push (over the public host); confirm a Trivy scan appears.
docker login harbor.capstone.uamishub.com
```

The `PodCrashLoopOrImagePullBackOff` and (via kube-state-metrics) general alerts
in [Observability](observability.md) cover Harbor pod failures.
