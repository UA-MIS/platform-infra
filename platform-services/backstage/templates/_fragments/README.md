# `_fragments/` — composable language fragments for the unified "New Project" wizard

This directory is the **fragment library** behind the single `new-project` scaffolder
wizard (`../new-project/template.yaml`). Instead of N×M pre-baked stack templates, the
wizard assembles a project at scaffold time from **one fragment per language/framework**
plus **one shared `.devops`/`.github` contract** (`_contract/`). See
`artifacts/design/decisions/adr-034-unified-project-wizard.md` for the full design.

## Layout

```
_fragments/
  _contract/            # the ONE shared platform contract (.devops + .github + catalog-info
                        # + mkdocs + docs). Rendered ONCE per project. NOT copied per fragment.
  frontend/<id>/        # category dirs: frontend | backend | static | fullstack | mobile
    fragment.yaml       #   metadata (the contract — read by the compose engine + the wizard)
    skeleton/           #   the starter app code + Dockerfile (build context = this dir root)
  backend/<id>/...
  static/<id>/...
  mobile/<id>/...       # mobile = build-artifact (.ipa/.apk); no Dockerfile, no k8s workload
```

## The fragment contract (`fragment.yaml`)

| field | meaning |
| --- | --- |
| `apiVersion` | `platform.capstone/fragment.v1` |
| `id` | unique kebab id within the category; equals the dir name |
| `displayName` | human label shown in the wizard |
| `category` | `frontend` \| `backend` \| `static` \| `fullstack` \| `mobile` |
| `language` / `framework` | e.g. `typescript`/`react`; `framework: none` = bare starter |
| `slots` | which wizard slots it can fill: `single`, `frontend`, `backend`, `mobile` |
| `defaultPort` | container port (PORT env + Service/Ingress target); wizard default |
| `ingressPath` | path when composed as a NON-root component (backends `/api`; frontends `/`) |
| `needsDB` | does it read `DATABASE_URL`? Drives the wizard's DB question + the chart wiring |
| `buildType` | `container` \| `static` \| `mobile-artifact` (mobile-artifact = no Deployment) |
| `dockerfile` | Dockerfile path within `skeleton/` (mobile: empty; use `buildWorkflow`) |
| `healthPath` | the probe path the container serves (`/healthz`) |
| `notes` | free text for humans + fan-out builders |

## Wiring conventions (load-bearing — fan-out builders MUST follow)

- **Frontend → backend:** a frontend fragment calls its backend over the SAME origin via a
  relative `/api/...` URL (never a hardcoded host). The ingress routes `/` → frontend,
  `/api` → backend.
- **Backend must expose:** a DB-independent `GET /healthz` (200) and its API under `/api/...`,
  and must read `DATABASE_URL` (a `mysql://` URI), degrading cleanly (503) when unset.
- **Ports:** every container listens on the `PORT` env (the chart sets it from the
  component's `port`). Default 8080.
- **No `.devops/`/`.github/` in a fragment:** the contract is shared from `_contract/`.
- **Fragment code IS nunjucks-rendered** at compose time (it may use `${{ values.appName }}`,
  `${{ values.description }}`, `${{ values.port }}`). Shell `${VAR}` and JS `${x}` are safe
  (only the `${{ ... }}` form is substituted).

## Adding a fragment (the fan-out)

1. `mkdir -p _fragments/<category>/<id>/skeleton` and drop your starter app + Dockerfile.
2. Write `_fragments/<category>/<id>/fragment.yaml` per the table above.
3. Regenerate the wizard choice lists: `node _tools/gen-wizard-enums.mjs` (updates the enums
   in `../new-project/template.yaml` from the fragment set).
No engine code changes — the compose engine reads `fragment.yaml` at scaffold time.
