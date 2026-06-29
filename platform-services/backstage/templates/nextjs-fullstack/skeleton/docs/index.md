# ${{ values.appName }}

${{ values.description }}

A Next.js (App Router, TypeScript) + Prisma (MySQL) + Tailwind app, scaffolded by
**The Process** onto the UA-MIS capstone platform golden path.

## Quick start

1. Clone this repo and edit `app/` (your code). Leave `.devops/` alone.
2. `cd app && npm install`.
3. Point Prisma at a local MySQL in `app/.env` (git-ignored):
   `DATABASE_URL="mysql://user:password@127.0.0.1:3306/appdb"`, then
   `npx prisma migrate dev --name init`.
4. `npm run dev` (serves on `http://localhost:${{ values.port }}`); `npm test` runs the
   unit tests.
5. Open a pull request — a **preview** environment is built automatically.
6. Merge to `main` — **dev** auto-deploys. Tag `vX.Y.Z` — **staging** auto-deploys;
   **prod** waits on the manual gate.

## Deployment targets

| Environment | URL |
| --- | --- |
| dev | `https://${{ values.appName }}.dev.<platform-domain>` |
| staging | `https://${{ values.appName }}.staging.<platform-domain>` |
| prod | `https://${{ values.appName }}.<platform-domain>` |

## The `.devops/` contract

The platform owns everything under `.devops/`. Your only knobs are the four fields in
`.devops/app-metadata.yaml` (`team`, `semester`, `app-name`, `port`).

## Database (MySQL) + secrets

The app reads `DATABASE_URL` (a MySQL connection string) from the environment via
Prisma. You do **not** put values in git — open the **Secrets** tab on your component
in The Process, add a key `DATABASE_URL` and target env(s); it writes the value to your
team's Vault path and opens a PR adding the pointer to the per-env
`app-secret.externalsecret.yaml`. Merge it and ArgoCD applies it; ESO reads the value
from Vault and materializes the Kubernetes Secret, which the `.devops` Deployment wires
into the pod as `DATABASE_URL`. Secrets are **write-only** (to change one, set it
again). After the DB is set, apply your schema with `npx prisma migrate deploy`. See
`.devops/secrets/README.md` for the full pattern.

## Switching base images / adding apt packages — read before you do

The runtime stage of `app/Dockerfile` already uses the platform's bootstrap to install
OpenSSL + ca-certificates over HTTPS. If you change a build/runtime stage to a different
Debian-family base and run `apt-get`, your CI build will fail on the platform runners
**unless** you keep that bootstrap. Two platform facts cause it:

- The CI runner's egress allows external **:443 only** (no external :80) — Debian apt
  defaults to `http://…` (:80) and is blocked, so apt sources must be rewritten to HTTPS.
- Slim Debian bases ship **no `ca-certificates`** bundle, so the first HTTPS fetch can't
  verify the cert — bootstrap with peer-verify off for that one fetch to install
  `ca-certificates`, then verify normally afterward.

The exact, proven block is in the runtime stage of `app/Dockerfile`; copy it verbatim
into any Debian-base stage that runs `apt`.

> Base images are pulled from Docker Hub today. At cohort scale this can hit Docker Hub
> rate limits; when the platform's pull-through cache is available, prefer pulling your
> base via the platform Harbor proxy (the platform team will announce the `FROM` host).
