# The Process — Backstage app source (M1)

The custom Backstage monorepo for the UA-MIS capstone developer portal ("The Process"),
committed under `platform-infra/platform-services/backstage/app/` (ADR-029, **D-045**).
This is the source that builds the custom image the portal Application
(`applicationsets/backstage-process-app.yaml`) runs — the demo `ghcr.io/backstage/backstage`
image has neither the Dex OIDC provider nor (later) the platform's templates/permissions.

- Backstage release: **1.52.0** (see `backstage.json`); yarn **4.13.0** (berry, vendored at
  `.yarn/releases/`); new frontend system (`@backstage/frontend-defaults`).
- Generated with `@backstage/create-app`, then trimmed to M1 scope.

## M1 scope (deliberately minimal)

M1 is the human's "see it work" checkpoint: a custom image that **deploys, renders the
portal, and completes a GitHub-via-Dex login** at `https://process.capstone.uamishub.com`.
M1 is **only** that. NOT built yet (later milestones, ADR-029 §7):

- M2 — GitHub-org catalog ingestion + the per-team permission policy (D-048).
- M3 — the `capstone:seal-secret` action + secrets UI (D-047).
- M4 — Scaffolder `.devops/secrets/` skeleton + the PR-to-platform-infra onboarding step.

## What M1 adds on top of the stock create-app output

- **`packages/backend/src/modules/authOidcProcess.ts`** — a custom `auth` backend module
  registering the `oidc` provider against the shared Dex broker, with a Dex-aware sign-in
  resolver: `preferred_username` (the GitHub login Dex emits) → a `User` entity, with a
  catalog fallback (`dangerousEntityRefFallback`) so a Dex-authenticated (== UA-MIS-org
  gated, SEC-007) member can sign in **before** real GitHub-org catalog ingestion lands in
  M2. Wired in `packages/backend/src/index.ts` (replaces the guest provider). Custom because
  the stock OIDC module only ships email-based config resolvers; Dex identifies by login.
- **`packages/app/src/modules/signIn/index.tsx`** — the frontend `SignInPage` + OAuth2
  `oidc` API for the new frontend system (the new system has no default sign-in page).
  Wired in `packages/app/src/App.tsx`.
- **`app-config.production.yaml`** — the baked production config: host/baseUrl/cors for
  `process.capstone.uamishub.com`, the bundled-Postgres connection, the backend signing key,
  and the `auth.providers.oidc.production` block (metadataUrl = the Dex issuer; clientId /
  clientSecret / backend key via env). **No `signIn.resolvers` list** here on purpose — a
  code-defined resolver only takes effect when app-config carries none (config wins).
- **`packages/backend/Dockerfile`** — replaced with a **multi-stage, Kaniko-friendly** build
  (see the hand-to-devops notes below).

## Build it

```bash
# vendored yarn berry — no global yarn needed
node .yarn/releases/yarn-4.13.0.cjs install --immutable
node .yarn/releases/yarn-4.13.0.cjs tsc
node .yarn/releases/yarn-4.13.0.cjs build:backend
# image (multi-stage; context = THIS dir):
docker build -f packages/backend/Dockerfile -t harbor.capstone.uamishub.com/backstage/backstage-process:<tag> .
```

## Hand-to-devops contract (M1)

DevOps owns build/Harbor/deploy; this dir owns app source + baked config. The seam:

- **Build context** = this dir (`platform-services/backstage/app`); **Dockerfile** =
  `packages/backend/Dockerfile`. It is **multi-stage** and builds from source inside the
  image (`yarn install && yarn tsc && yarn build:backend` happen in-build), so the Kaniko
  step is a **single self-contained invocation** — no host pre-build step needed. Kaniko
  notes: no `RUN --mount=type=cache` (unsupported); base image `node:24-trixie-slim`; the
  build runs `apt-get install python3 g++ build-essential libsqlite3-dev` (isolated-vm +
  better-sqlite3 native deps). `.dockerignore` is tuned for multi-stage (keeps
  `packages/*/src` — the build needs them).
- **Image target** = `harbor.capstone.uamishub.com/backstage/backstage-process:<short-sha>`
  (the dedicated `backstage` Harbor project, ADR §3). The Application's image block + tag
  bump are devops-owned.
- **Required env vars** the deployment must inject (from the `backstage-process-secrets`
  SealedSecret — devops-owned; same value as the Dex side, different var names):
  | env var | meaning | source |
  | --- | --- | --- |
  | `AUTH_OIDC_CLIENT_ID` | OIDC client id = `process` | seal as `process` |
  | `AUTH_OIDC_CLIENT_SECRET` | = Dex `PROCESS_CLIENT_SECRET` (SAME value) | generated secret |
  | `BACKEND_SECRET` | backend signing + session key | `openssl rand -base64 32` |
  | `POSTGRES_PASSWORD` | bundled Postgres password | match the postgresql SealedSecret |
  | `GITHUB_TOKEN` | M2/M4 only; absent at M1 is fine (config evals to undefined) | — |
- **app-config merge**: the Application's helm `appConfig` block is merged ON TOP of the
  baked `app-config.production.yaml`. The baked config is complete/self-sufficient; the helm
  block is belt-and-suspenders. One reconciliation needed: the helm `auth.providers.oidc`
  block must **drop its `signIn.resolvers` list** (the p5 draft has
  `preferredUsernameMatchingUserEntityName`, which is not a real config resolver and would
  override the code resolver). Keep metadataUrl/clientId/clientSecret/prompt.
