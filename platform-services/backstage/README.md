# Backstage "The Process" — the UA-MIS capstone developer portal (P5)

> **Trust the Process.**

The Process is the platform's **developer portal**: a software **catalog**, **TechDocs**, and
the headline IDP feature — **Scaffolder golden-path templates** that create a new team
app repo pre-wired to the platform contract. Human SSO is via the **shared Dex broker**
(same as ArgoCD/Harbor). At `https://process.<PLATFORM_DOMAIN>` (interim:
`https://process.capstone.uamishub.com`).

- Chart: `backstage` **2.8.2** (OCI: `oci://ghcr.io/backstage/charts`), pinned,
  Helm-source Application `applicationsets/backstage-process-app.yaml` (deploy method A —
  same precedent as Harbor/ARC/Rook/metrics-server, D-022/D-028).
- Storage: bundled Postgres (Bitnami subchart) on **`ceph-block`** (Phase-4 Rook RBD,
  replica-3, the cluster default SC). External DB (`ua-mis-db-1` PG17) is a later optimization.
- Prereqs (namespace + SealedSecrets) sync via the platform-services-appset (this dir,
  `platform-svc-backstage`); the chart installs into the `backstage` namespace as a
  SEPARATE Application — same split as Harbor.

> ## ⚠ STATUS: AHEAD-OF-NEED PREP — NOT DEPLOYED
> This is a reviewable scaffold built while the cluster is mid-heal (Cilium swap). It
> **renders + reviews** but is intentionally **not synced**: the Application carries
> `platform.capstone/deploy-status: prep-do-not-deploy` and its `syncPolicy.automated`
> block is **commented out**. The Process goes live only after the **To go live** checklist
> below. Nothing here touches the cluster until a human enables it.

---

## Layout

```
platform-services/backstage/
├── namespace.yaml                 # backstage namespace
├── sealedsecret-oidc.yaml         # OIDC client + backend key + DB pw (PLACEHOLDER — re-seal)
├── sealedsecret-postgresql.yaml   # bundled Postgres creds, Bitnami keys (PLACEHOLDER — re-seal)
├── kustomization.yaml             # the platform-svc-backstage prereq bundle
├── catalog/
│   ├── all.yaml                   # catalog ROOT Location (templates + seed entities)
│   └── org.yaml                   # seed platform Group/User (real ones from GitHub org at go-live)
└── templates/
    └── new-capstone-project/
        ├── template.yaml          # the "New Capstone Project" Scaffolder template
        └── skeleton/              # what a new team repo is scaffolded from
            ├── app/               # starter Go service (main.go + tests + go.mod + Dockerfile)
            ├── .devops/app-metadata.yaml   # the 4 declared fields
            ├── catalog-info.yaml  # registers the new component
            ├── mkdocs.yml + docs/ # TechDocs
            ├── README.md
            └── .gitignore

applicationsets/backstage-process-app.yaml   # the Backstage Helm Application (chart 2.8.2)
bootstrap/platform-appproject.yaml           # sourceRepos += ghcr.io/backstage/charts (INSTALL-OWNED)
platform-services/dex/configmap.yaml         # the `process` Dex static client
platform-services/dex/deployment.yaml        # PROCESS_CLIENT_SECRET env (optional until re-sealed)
```

---

## The custom image (the load-bearing prereq)

Backstage is **not** a configure-and-run server. You scaffold your **own** app, wire the
plugins you need, build a container, and run THAT. The chart's default image
`ghcr.io/backstage/backstage:latest` is a demo and has **neither** our Dex OIDC auth
provider **nor** The Process Scaffolder/catalog wiring. So `image` in the Application points
at a Harbor-hosted image we must build (`harbor.<domain>/library/backstage-process`, tag is a
PLACEHOLDER `v0.1.0` until built).

### Build it (one time, then on plugin changes)

```bash
# 1. Scaffold the Backstage app (Node 20+, Yarn). Creates ./process.
npx @backstage/create-app@latest --path process
cd process

# 2. Add the plugins The Process needs (backend = "new" backend system):
#    - OIDC auth provider (Dex) + a sign-in resolver
yarn --cwd packages/backend add @backstage/plugin-auth-backend \
  @backstage/plugin-auth-backend-module-oidc-provider
#    - Scaffolder + GitHub actions (publish:github, fetch:*) + catalog GitHub org ingestion
yarn --cwd packages/backend add @backstage/plugin-scaffolder-backend \
  @backstage/plugin-scaffolder-backend-module-github \
  @backstage/plugin-catalog-backend-module-github-org \
  @backstage/plugin-techdocs-backend
#    (register each module in packages/backend/src/index.ts — see Backstage docs.)

# 3. Wire app-config.yaml: the auth.providers.oidc block (metadataUrl = the Dex
#    issuer), backend.auth.keys, the catalog GitHub org provider, integrations.github.
#    (The Helm values in applicationsets/backstage-process-app.yaml are MERGED on top, so
#    keep the env-substituted ${VAR} names identical: AUTH_OIDC_CLIENT_ID/SECRET,
#    BACKEND_SECRET, POSTGRES_PASSWORD, GITHUB_TOKEN.)

# 4. Build the image and push to Harbor (library project):
yarn install --immutable
yarn tsc
yarn build:backend
docker build . -f packages/backend/Dockerfile \
  -t harbor.<PLATFORM_DOMAIN>/library/backstage-process:v0.1.0
docker login harbor.<PLATFORM_DOMAIN>          # or a robot account
docker push harbor.<PLATFORM_DOMAIN>/library/backstage-process:v0.1.0
```

Then bump `backstage.image.tag` in `applicationsets/backstage-process-app.yaml` to the
real built tag. (Building INSIDE the platform — a Kaniko job on the ARC runners pushing
to Harbor — is the eventual story; bootstrap it manually the first time.)

---

## To go live (checklist)

Do these **in order**, after the cluster heal + the Phase-3 domain cutover:

1. **Domain cutover.** This scaffold uses the interim `capstone.uamishub.com` literal
   everywhere (the repo-wide convention — same as Dex/Harbor/ArgoCD today). At the
   Phase-3 cutover, the platform-wide find-replace `capstone.uamishub.com` ->
   `capstone.uamishub.com` (D-036) updates The Process's host to `process.capstone.uamishub.com`
   in lockstep with every other service. Files to update for The Process specifically:
   - `applicationsets/backstage-process-app.yaml` (ingress `host`, `baseUrl`, `cors`,
     `metadataUrl`, the Harbor image registry).
   - `platform-services/dex/configmap.yaml` (the `process` static-client `redirectURIs`).

2. **Add the `process` client secret to Dex.** Generate a secret, seal it into BOTH places
   (same value — exactly like Harbor's pairing), then drop the `optional: true` on the
   `PROCESS_CLIENT_SECRET` env in `platform-services/dex/deployment.yaml`:
   ```bash
   PROCESS_CS=$(openssl rand -base64 32)
   # (a) add key `process-client-secret` to the dex-github SealedSecret. Re-seal the whole
   #     secret with all existing keys + this new one (see platform-services/dex/README.md).
   # (b) seal AUTH_OIDC_CLIENT_SECRET=$PROCESS_CS into backstage-process-secrets (step 3).
   ```

3. **Re-seal the Backstage secrets** (replace the PLACEHOLDERs). The current
   `sealedsecret-oidc.yaml` / `sealedsecret-postgresql.yaml` hold inert base64 of
   "PLACEHOLDER" (annotated `platform.capstone/placeholder: "true"`). Re-seal with real
   values per the headers in those files. Keep `password` (postgresql) ==
   `POSTGRES_PASSWORD` (process-secrets), and `AUTH_OIDC_CLIENT_SECRET` == the Dex
   `process-client-secret`.

   **M2 (GitHub-org visibility) — seal the GitHub App credential.** M2 authenticates as the
   `ua-mis-backstage` GitHub App (NOT a PAT) for org ingestion. The App's non-secret IDs
   (App ID `4097147`, Client ID `Iv23liRQ6d2I2mibDMbY`, Installation `141394298`) are
   INLINED in config; only the two SECRET values are sealed into `backstage-process-secrets`:
   - **`GITHUB_APP_PRIVATE_KEY`** — the full contents of the App `.pem` private key (multi-
     line; seal as-is, do not strip newlines).
   - **`GITHUB_APP_CLIENT_SECRET`** — the App client secret.

   These MUST be sealed **before** the M2 image deploys: M2 removes the M1 sign-in fallback,
   so if ingestion can't run (missing/wrong credential) NO ONE can sign in, including admins
   (plan R1). Break-glass: roll `backstage.image.tag` back to the M1 SHA `87c9dc3a8fb8`.
   ```bash
   # audit that no placeholders remain before enabling sync:
   kubectl get sealedsecret -A -o json | jq -r \
     '.items[] | select(.metadata.annotations["platform.capstone/placeholder"]=="true") | .metadata.name'
   ```

4. **Build + push the custom image** (above) and bump the tag in the Application. Create
   the Harbor `harbor-pull` robot imagePullSecret in the `backstage` namespace (same
   robot pattern as team workloads — see `platform-services/harbor/README.md`).

5. **Allowlist the chart repo.** `ghcr.io/backstage/charts` is added to the `platform`
   AppProject `sourceRepos` in `bootstrap/platform-appproject.yaml`, but that file is
   **INSTALL-OWNED** (not GitOps-reconciled) — re-apply after merge or the Application
   `InvalidSpecError`s "repo not permitted":
   ```bash
   make bootstrap-reapply TARGET=real-talos KUBE_CONTEXT=admin@capstone \
     KUBECONFIG=clusters/real-talos/talos-kubeconfig
   ```

6. **Confirm the catalog `targets`** in `catalog/all.yaml` resolve (the template
   `template.yaml` path + `catalog/org.yaml`), and the Scaffolder's `fetch:plain` source
   in `templates/new-capstone-project/template.yaml` points at the canonical `.devops/`
   reference (currently `UA-MIS/team-sample-app/tree/main/.devops` — pin a tag/sha).

7. **Enable auto-sync.** Uncomment the `syncPolicy.automated` block in the Application
   and remove the `prep-do-not-deploy` annotation. ArgoCD then syncs The Process.

8. **Verify** (see below).

---

## The golden-path Scaffolder template

`templates/new-capstone-project/template.yaml` is the headline feature. A student fills
**four fields** (`appName`, `team`, `semester`, `port`) + picks the repo location, and The
Process runs a **two-sided** flow (D-049): the repo side is automatic (the student owns it);
the platform side is a **review-gated PR** (a reviewer grants it by merging).

**Repo side (automatic):**
1. **`fetch:template`** renders `skeleton/` — a starter Go `app/`, the 4-field
   `.devops/app-metadata.yaml`, `catalog-info.yaml`, TechDocs, and a `.devops/secrets/`
   home (the landing path for the Secrets tab; see below).
2. **`fetch:plain`** overlays the **canonical, immutable** `.devops/` contract (CI
   workflow, `chart/` base+overlays, `promotion.yaml`, `ci/` scripts) from the reference
   golden-path repo — so every team gets the SAME platform contract. **Pinned to the
   `v1` tag** on `UA-MIS/sample-app` (`/tree/v1/.devops`) so scaffolds are reproducible
   and a push to the contract repo's `main` can't silently change every future tenant.
3. **`publish:github`** creates `UA-MIS/<app-name>` (private, branch-protected: PRs into
   `main`, no direct pushes — mirrors the live platform policy).
4. **`catalog:register`** registers the new component so it appears in The Process catalog.

**Platform side (review-gated — the D-049 grant path):**
5. **`capstone:render-tenant`** renders `tenants/team-<name>/` from the single canonical
   `tenants/_template/` blueprint (custom action — the blueprint uses literal
   `__TEAM__`/`__SEMESTER__` tokens that the built-in nunjucks `fetch:template` can't
   render; D-M4-2 renders the one source, no fork).
6. **`publish:github:pull-request`** opens a PR to `UA-MIS/platform-infra` adding those
   tenant manifests, with an **operator onboarding checklist** as the PR body (the
   `make harbor-onboard`/`harbor-push-robot`/`harbor-robot` commands — every one shown
   with `TARGET=real-talos`, lesson #1). The PR is opened with the **platform GitHub App
   token** so any signed-in UA-MIS member can open it without platform-infra write rights;
   **the merge is the gate.** On merge, `tenants-appset` reconciles the team's namespaces
   and ApplicationSets.

The repo result is identical in shape to `sample-app`: the student edits only `app/` +
the four `app-metadata.yaml` fields; everything else is platform-managed. The scaffolded
`app/` ships with passing `go test` so CI is green on the first PR, and the first PR builds
a **preview** image (Kaniko `--no-push`); merge to `main` pushes the dev image.

### Secrets (the `.devops/secrets/` home)

Every scaffolded repo ships an empty `.devops/secrets/` with a README. A team adds a secret
from the **Secrets** tab on its Component (the `capstone:seal-secret` action, M3), which
seals the value and opens a PR adding `.devops/secrets/<key>.sealedsecret.yaml` (per-env
strict scope) + wiring it into the env overlay. Write-only by design — sealed values can't
be read back. The skeleton ships the home so the pattern is already in place the first time
a team uses the UI.

### Operator onboarding (the imperative half — post-merge)

Robot tokens are Harbor-generated, one-time, and not declarative, so after the platform PR
merges an operator runs the Harbor provisioning (the exact commands are in the PR body):

```bash
export KUBECONFIG=clusters/real-talos/talos-kubeconfig
make harbor-onboard     NAME=<name> TARGET=real-talos KUBE_CONTEXT=admin@capstone
make harbor-push-robot  NAME=<name> TARGET=real-talos KUBE_CONTEXT=admin@capstone  # -> sealed harbor-push (guarded)
make harbor-robot       NAME=<name> ENV=<dev|staging|prod> TARGET=real-talos …     # -> sealed harbor-pull per env
```

`TARGET=real-talos` is mandatory on every command (omitting it seals the k3d-default
registry host → docker auth mismatch → push/pull 403; the `_check-harbor-target` Makefile
guard is the backstop). Each seal is written through a non-empty guard
(`> tmp && test -s tmp && grep -q 'kind: SealedSecret' tmp && mv tmp final`) so a
duplicate-robot 409 can never commit an empty secret. Full robot-mint automation (a
merge-triggered action) is a planned fast-follow (D-M4-1) — kept off the Backstage backend
so Harbor-admin/seal-controller creds stay out of the portal's trust domain.

---

## SSO via Dex

Same broker as ArgoCD/Harbor (NO new GitHub OAuth app). The `process` static client is
added in `platform-services/dex/configmap.yaml`; its secret is env-injected into both Dex
(`PROCESS_CLIENT_SECRET`) and Backstage (`AUTH_OIDC_CLIENT_SECRET`). Backstage fetches Dex
discovery server-side at the issuer `id.<domain>` (in-cluster via the `coredns-custom`
rewrite -> Traefik -> Dex, the slice-1 pattern, reused — no new DNS rewrite). The OIDC
auth provider + sign-in resolver must be **wired in the custom image's backend** (the demo
image doesn't ship it); the `auth.providers.oidc` block in the Application's values drives
that wired provider. Org gating is enforced UPSTREAM at Dex (UA-MIS-only, SEC-007).

---

## Validation (post-go-live)

- The Process UI reachable over TLS at `https://process.<domain>`; "Sign in" via Dex works for a
  UA-MIS member; a non-member is rejected at Dex.
- The Backstage pod is `Running`; the Postgres StatefulSet is bound on `ceph-block`.
- The **catalog** shows the "New Capstone Project" template under "Create".
- Running the template creates `UA-MIS/<app-name>`, the repo has `app/` + `.devops/`, its
  first PR builds a preview, and the new component appears in the catalog with TechDocs.
- No SealedSecret carries `platform.capstone/placeholder: "true"` (step 3 audit).

**M2 (GitHub-org per-team visibility) acceptance** — after ingestion runs (≤ the schedule):
- The catalog shows real UA-MIS Groups (one per GitHub team, slug = `<team>`) + Users; the
  seed `guest`/`guests` placeholders are gone.
- A member of exactly one team sees ONLY that team's owned Components; another team's member
  sees a disjoint set; a `labmx` admin sees everything (admin override).
- **Backend-boundary check (the security-meaningful test):** the filtering is enforced
  server-side, not UI-hidden. Run the checked-in script with a signed-in user's token:
  ```bash
  BACKSTAGE_TOKEN=<token> EXPECT_TEAM=<your-team-slug> \
    ./scripts/m2-acceptance-backend-filter.sh
  ```
  It fails if `GET /api/catalog/entities` returns any component owned by a team the caller
  is not on (a silent ALLOW-all regression — e.g. `permission.enabled` unset).

## Notes / known caveats

- Chart 2.8.2 bundles Bitnami postgresql 12.10.0, which renders the
  `bitnamilegacy/postgresql` image. Fine for the proof; pin/mirror to Harbor (or move to
  the external `ua-mis-db-1` PG17) as a hardening follow-up.
- `automountServiceAccountToken`, NetworkPolicy isolation for the `backstage` namespace,
  and a PodDisruptionBudget are deferred to a security pass (the chart exposes
  `networkPolicy.enabled` + `backstage.pdb` when wanted) — flagged, not blocking for prep.
