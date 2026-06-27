# Team assembly log

Coordination + shared-contract record for the in-flight tracks. Each track posts the
contracts it OWNS here so the other tracks build against a single, stable definition.

---

## CONTRACT: Multi-component model (Track 6 — multi-component monorepo) — v1

**Owner / sole definer:** Track 6 (multi-component). One-way authority: this section is
the single source of truth for the component model. Other tracks CONSUME it; they do not
redefine it. Adjudicate via the bytes here, not prose elsewhere.

**Problem:** many capstone teams have a webapp = SEPARATE backend + frontend apps. A
tenant repo MUST support N deployable components in ONE repo (no forced split into two
repos). Ease-of-use is the north star.

### The file: `.devops/components.yaml`

```yaml
apiVersion: platform.capstone/v1
# Declares the deployable components in this app repo. SINGLE source of truth for:
#   - the CI build matrix (one image built + pushed per component), read by
#     .devops/ci/resolve-components.sh and consumed by the build workflow;
#   - the kustomize chart (one Deployment + one Service per component + one Ingress
#     routing each component's `path`), rendered at scaffold time from this list.
components:
  - name: frontend          # DNS-1123 label. Component id: selector label + image suffix.
    kind: frontend          # frontend | backend. The frontend component owns the "/" root.
    context: frontend       # build-context dir, repo-relative (the dir holding the Dockerfile).
    dockerfile: Dockerfile  # Dockerfile path, RELATIVE TO `context`.
    image: myapp-frontend   # image REPO within the team's Harbor project.
                            #   full ref = <promotion.registry>/<image>:<tag>
                            #            = harbor.../<team>/myapp-frontend:<tag>
    port: 8080              # container port (PORT env + Service port + Ingress target).
    path: /                 # ingress path routed to this component.
  - name: backend
    kind: backend
    context: backend
    dockerfile: Dockerfile
    image: myapp-backend
    port: 8080
    path: /api
```

### Field reference

| field        | required | meaning |
|--------------|----------|---------|
| `name`       | yes | DNS-1123 label. Becomes `app.kubernetes.io/component` (per-component selector) and the workload-name suffix `<appName>-<name>`. |
| `kind`       | yes | `frontend` \| `backend`. Semantic hint; the frontend owns the `/` ingress root, backends take sub-paths (`/api`). |
| `context`    | yes | Build-context dir, repo-relative. |
| `dockerfile` | yes | Dockerfile path relative to `context`. |
| `image`      | yes | Image REPO name within the team Harbor project. Full ref = `<promotion.registry>/<image>:<tag>`. Convention: `<appName>-<name>`. |
| `port`       | yes | Container port (PORT env + Service `targetPort` + Ingress backend port). |
| `path`       | yes | Ingress path routed to this component (longest-prefix wins; `/api` before `/`). |

### BACK-COMPAT rule (load-bearing — v1check must keep working unchanged)

`components.yaml` is **OPTIONAL**. A repo WITHOUT it is a single-component app (the default
golden path, e.g. `v1check`). Every consumer MUST synthesize ONE implicit component when the
file is absent:

```
{ name: app, kind: backend, context: app, dockerfile: Dockerfile, image: <appName>, port: <app-metadata.port>, path: / }
```

So existing single-component repos build/deploy **byte-for-byte unchanged** (image stays
`<registry>/<appName>:<tag>`, one Deployment/Service/Ingress). Single-component stays the
DEFAULT; multi-component is an opt-in scaffold variant.

### Tag is shared across components

ONE git event → ONE tag for ALL components (they live in one repo, one commit). The tag is
computed by the EXISTING `.devops/ci/resolve-image.sh` (UNCHANGED — promotion.yaml stays the
trigger→env→tag source of truth). Per-component full image = `<registry>/<component.image>:<TAG>`.

### `promotion.yaml` vs `components.yaml` (complementary, no overlap)

- `promotion.yaml` owns: registry, trigger→env→tag mapping, overlay paths, gates. UNCHANGED.
  (The top-level `app:` is now only used for the single-component fallback; multi reads
  per-component `image` from components.yaml.)
- `components.yaml` owns: the per-component build context + image repo + port + ingress path.

---

## CONSUMERS — what each track must do

### Track 1 (reusable-ci) — CONSUME this, build the matrix

`.devops/ci/resolve-components.sh` (Track 6 ships it) emits a **JSON matrix array** on stdout
(for GitHub Actions `fromJSON`), reading components.yaml (or the single fallback) + the
resolved TAG from resolve-image.sh:

```json
[
  {"name":"frontend","context":"frontend","dockerfile":"Dockerfile","image":"harbor.../<team>/myapp-frontend:<TAG>","push":"true"},
  {"name":"backend","context":"backend","dockerfile":"Dockerfile","image":"harbor.../<team>/myapp-backend:<TAG>","push":"true"}
]
```

The reusable workflow should:
1. resolve once (env + TAG + push decision) via `resolve-image.sh`;
2. emit the matrix via `resolve-components.sh` and `strategy.matrix.include = fromJSON(...)`;
3. Kaniko-build each component with `--context=dir://$WORKSPACE/<context>`
   `--dockerfile=<dockerfile>` `--destination=<image>` (push per `push`);
4. bump: on push-to-main, run `COMMIT=1 bump-image.sh dev <TAG>` ONCE — Track 6's
   `bump-image.sh` now sets `newTag` on **every** component's `images[]` entry (reads
   components.yaml; single-component falls back to the `<appName>` entry).

**Heads-up / related finding:** the current single-component `bump-image.sh` hardcodes
`yq '... select(.name == "sample") ...'`, but rendered overlays use `name: <appName>`. In a
non-`sample` tenant that selector matches nothing → the dev bump is a silent no-op. Track 6's
generalized `bump-image.sh` fixes this for both single + multi (selects by the resolved image
names, not the literal `sample`). Please adopt it (or the same fix) in the reusable workflow.

### Track 5 (crossplane) — NO change needed, confirmation only

A multi-component app now pushes/pulls **N image repos** inside the team's ONE Harbor project
(`myapp-frontend`, `myapp-backend`, …). Harbor robots are **project-scoped**, so:
- the PUSH robot (`harbor-push`) covers every repo in the project — no per-repo robot;
- the per-env PULL robot (`harbor-pull`) covers every repo in the project — no change.

Crossplane onboarding (project + OIDC mapping + robots) needs **no modification**; just keep
robot scope at project level (already the case). Confirming so the contract is explicit.

---

## Track 6 deliverables (this branch: `feat/multi-component-monorepo`)

- `.devops/components.yaml` schema (above) + `skeleton-multi/` scaffold variant
  (`backend/` + `frontend/` dirs, each a Dockerfile + minimal app).
- Kustomize chart: N Deployments + N Services + one path-routing Ingress (`/`→frontend,
  `/api`→backend), per-env overlays preserved.
- `.devops/ci/resolve-components.sh` (matrix emitter) + generalized `bump-image.sh` + tests.
- `template.yaml`: additive `layout` param (`single` default | `frontend-backend`) + a
  guarded second `fetch:template` step → `./skeleton-multi`. Single path untouched.
