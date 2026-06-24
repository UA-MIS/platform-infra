# ${{ values.appName }}

A UA-MIS capstone project, scaffolded by **The Process** (the developer portal) onto the
platform golden path.

## Repo layout — the `.devops/` contract

```
${{ values.appName }}/
├── app/        ←  YOU EDIT THIS.   Your application code + Dockerfile.
└── .devops/    ←  DO NOT EDIT.     Platform-managed deployment template.
```

You own `app/`. The platform owns `.devops/`. The **only** values you declare are the
four fields in `.devops/app-metadata.yaml` (already filled in for you):

```yaml
team: ${{ values.team }}
semester: ${{ values.semester }}
app-name: ${{ values.appName }}
port: ${{ values.port }}
```

Everything else — Deployment, Service, Ingress, namespaces, the ingress host, quotas,
RBAC, network policy, CI — is derived from those values by the platform.

## The golden path

| You do | The platform does |
| --- | --- |
| Open a PR | Builds a **preview** environment |
| Merge to `main` | Auto-deploys **dev** |
| Tag `vX.Y.Z` | Auto-deploys **staging** |
| Approve the gate | Promotes to **prod** (manual gate) |

Your app will be reachable at
`https://${{ values.appName }}.<env>.<platform-domain>` (prod drops the `<env>`
segment: `https://${{ values.appName }}.<platform-domain>`).

## The app (`app/`)

A standard-library-only Go service to start from:

| Route | Behavior |
| --- | --- |
| `GET /healthz` | `200 ok` — liveness/readiness probe. |
| `GET /` | `200` — proves it read `APP_SECRET` (bool + length + sha256 prefix) **without** echoing the value. |

Run the tests: `cd app && go test ./...`. Replace `main.go` with your own service.
