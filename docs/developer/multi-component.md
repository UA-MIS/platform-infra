# Multi-component apps (frontend + backend)

Most capstone apps are a single service. But a lot of web apps are really **two** services in
one repo: a **frontend** and a **backend**. The platform supports that directly — one repo, two
(or more) Deployments, two images, one Ingress that routes `/` to the frontend and `/api` to
the backend — without splitting into separate repos.

## Choosing the layout at scaffold time

When you create a project in The Process, the **App layout** field offers:

- **Single component (one app — default)** — one `app/` directory, one Dockerfile, one
  Deployment. This is the golden path; pick it unless you specifically need a split frontend/
  backend.
- **Frontend + backend (two components, one repo)** — generates `frontend/` and `backend/`
  directories (each with its own Dockerfile and starter app) plus a `.devops/components.yaml`
  describing both, and a chart that renders one Deployment + one Service per component and a
  single path-routing Ingress (`/` → frontend, `/api` → backend).

You can't "convert" later by re-scaffolding, but you *can* add components to a multi-component
repo by editing files (see [Adding a component](#adding-a-component)).

## The contract: `.devops/components.yaml`

In a multi-component repo, `.devops/components.yaml` is the **single source of truth** for what
gets built and deployed. It drives two consumers at once:

- the **CI build matrix** — one image is built per component; and
- the **kustomize chart** — one Deployment + one Service per component, plus the Ingress paths.

```yaml
apiVersion: platform.capstone/v1
components:
  - name: frontend            # DNS-1123 label: selector + workload-name suffix
    kind: frontend            # frontend | backend (frontend owns the "/" ingress root)
    context: frontend         # build-context dir (repo-relative)
    dockerfile: Dockerfile    # Dockerfile path, relative to `context`
    image: <appName>-frontend # image repo in your Harbor project
    port: 8080                # container port (PORT env + Service + Ingress backend)
    path: /                   # Ingress path routed here (longest-prefix wins)
  - name: backend
    kind: backend
    context: backend
    dockerfile: Dockerfile
    image: <appName>-backend
    port: 8080
    path: /api
```

Each component becomes its own image in your team's Harbor project, named
`<appName>-<component>` (e.g. `acme-shop-frontend`, `acme-shop-backend`). All components in a
build share **one tag** (the git event's tag), so a release moves the whole app together.

### Field reference

| Field | Meaning |
| --- | --- |
| `name` | Component name; a DNS-1123 label. Becomes the workload-name suffix and the `app.kubernetes.io/component` selector. |
| `kind` | `frontend` or `backend`. The `frontend` conventionally owns the `/` Ingress root. |
| `context` | Build-context directory, relative to the repo root. |
| `dockerfile` | Dockerfile path, relative to `context`. |
| `image` | Image repo within your Harbor project. Convention: `<appName>-<name>`. |
| `port` | Container port — wired to the `PORT` env, the Service `targetPort`, and the Ingress backend port. |
| `path` | Ingress path routed to this component (longest-prefix wins, so `/api` beats `/`). |

## How a request is routed

One Ingress fronts the whole app on a single hostname. It routes by **longest-prefix path**:

```
https://<appName>.dev.capstone.uamishub.com/        ─► frontend  (path: /)
https://<appName>.dev.capstone.uamishub.com/api/... ─► backend   (path: /api)
```

So your frontend calls its backend at a relative `/api/...` URL — same host, no CORS, no second
domain to manage.

## How CI handles multiple components

The pipeline (see [CI/CD](cicd.md)) reads `components.yaml` and builds a **matrix** — one
Kaniko build per component, each pushing its own image, all sharing the one resolved tag. On a
merge to `main`, the dev-overlay bump rewrites **every** component's tag in a single commit, so
ArgoCD rolls all components of the app together. One PR/merge/tag = the whole app moves as a
unit.

## Single-component apps need no `components.yaml`

A single-component app has **no** `components.yaml` at all. The platform treats its absence as
one implicit component:

```yaml
{ name: app, context: app, image: <appName>, port: <metadata port>, path: / }
```

so single-component repos are simpler and unchanged. `components.yaml` exists **only** in the
frontend-backend scaffold variant.

## Adding a component

`components.yaml` and the chart are **both** static, rendered YAML — kustomize does not loop
over `components.yaml` at deploy time. So adding or removing a component (e.g. a third worker
service) means editing **both**:

1. Add the entry to `.devops/components.yaml` (new `name`, `context`, `dockerfile`, `image`,
   `port`, `path`).
2. Add the matching workload to the chart — a Deployment + Service in
   `.devops/chart/base/deployments.yaml` / `services.yaml`, and an Ingress path in
   `ingress.yaml`.
3. Create the component's source directory with its Dockerfile.

For the common backend+frontend case the scaffold already did both for you. For more than two
components, scaffold **frontend-backend** first and then extend as above. Because the chart is
platform-managed, coordinate non-trivial chart edits with the platform team (open an issue) —
keeping `components.yaml` and the chart in sync is the one place a multi-component repo can
drift.

## Validate your render locally

Before you push, you can confirm the chart still renders for every environment:

```sh
cd .devops
for env in dev staging prod preview; do
  kubectl kustomize chart/overlays/$env >/dev/null && echo "$env OK"
done
```

If all four print `OK`, your manifests build.
