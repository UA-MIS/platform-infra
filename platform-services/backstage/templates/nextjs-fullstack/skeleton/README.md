# ${{ values.appName }}

${{ values.description }}

A **Next.js full-stack** capstone app (App Router + TypeScript, Prisma ORM on MySQL,
Tailwind CSS), scaffolded by **The Process** (the developer portal) onto the platform
golden path. Cohort: **${{ values.semesterDisplay }}**.

## Repo layout — the `.devops/` contract

```
${{ values.appName }}/
├── app/        ←  YOU EDIT THIS.   Your Next.js app + Dockerfile.
└── .devops/    ←  DO NOT EDIT.     Platform-managed deployment template.
```

You own `app/`. The platform owns `.devops/`. The **only** values you declare are the
four fields in `.devops/app-metadata.yaml` (already filled in for you):

```yaml
team: ${{ values.team }}
semester: ${{ values.semester }}   # cohort slug (${{ values.semesterDisplay }})
app-name: ${{ values.appName }}
port: ${{ values.port }}
```

Everything else — Deployment, Service, Ingress, namespaces, the ingress host, quotas,
RBAC, network policy, CI — is derived from those values by the platform.

## The app (`app/`)

A standard Next.js App Router project:

```
app/
├── Dockerfile                 multi-stage, standalone, non-root (platform-ready)
├── package.json               scripts: dev / build / start / lint / test
├── next.config.mjs            output: 'standalone'
├── prisma/schema.prisma       MySQL datasource + a sample `Note` model
├── src/
│   ├── lib/prisma.ts          shared PrismaClient (singleton)
│   ├── lib/notes.ts           pure input helpers (unit-tested)
│   └── app/
│       ├── page.tsx           home (static)
│       ├── notes/page.tsx     reads notes from MySQL via Prisma
│       ├── api/notes/route.ts GET/POST JSON API backed by Prisma
│       └── healthz/route.ts   GET /healthz -> 200 (the k8s probe target)
└── tests/notes.test.ts        Vitest unit tests
```

### Run it locally

```bash
cd app
npm install
# point Prisma at a local MySQL (this file is git-ignored — never commit it):
echo 'DATABASE_URL="mysql://user:password@127.0.0.1:3306/appdb"' > .env
npx prisma migrate dev --name init   # create the table from schema.prisma
npm run dev                          # http://localhost:${{ values.port }}
npm test                             # run the unit tests
```

## Database — MySQL via `DATABASE_URL` (set it in the Secrets tab)

The app reads its MySQL connection string from the `DATABASE_URL` env var (via Prisma).
**Never commit a connection string.** On the platform, the value is delivered by the
External Secrets Operator from Vault:

1. Open this component in The Process and go to the **Secrets** tab.
2. Add a key named **`DATABASE_URL`** (value = your MySQL URL) for each env you use
   (`dev`, `staging`, `prod`). The Process writes it to your team's Vault path and
   opens a PR adding the pointer to `.devops/chart/overlays/<env>/app-secret.externalsecret.yaml`.
3. Merge that PR — ArgoCD applies it, ESO materializes the Secret, and the
   `.devops` Deployment already wires `DATABASE_URL` into the pod from it.
4. Apply your schema to the database once: `npx prisma migrate deploy` (run it against
   the env's database). Until a DB is set, the app still deploys — the notes pages just
   report "database not reachable".

See `.devops/secrets/README.md` for the full secrets pattern (it is write-only by
design).

## The golden path

| You do | The platform does |
| --- | --- |
| Open a PR | Builds a **preview** environment |
| Merge to `main` | Auto-deploys **dev** |
| Tag `vX.Y.Z` | Auto-deploys **staging** |
| Approve the gate | Promotes to **prod** (manual gate) |

Your app will be reachable at `https://${{ values.appName }}.<env>.<platform-domain>`
(prod drops the `<env>` segment: `https://${{ values.appName }}.<platform-domain>`).

## The Dockerfile (`app/Dockerfile`)

A known-good multi-stage build: install deps → `next build` (standalone) → a minimal,
**non-root** Debian-slim runtime that runs `node server.js` on `PORT`
(default `${{ values.port }}`). It also installs OpenSSL (for the Prisma query engine)
using the platform's apt-over-:443 bootstrap — read the note at the top of
`docs/index.md` before switching base images or adding `apt` packages.
