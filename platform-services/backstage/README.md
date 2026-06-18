# Backstage "Relay" — the UA-MIS capstone developer portal (P5)

Relay is the platform's **developer portal**: a software **catalog**, **TechDocs**, and
the headline IDP feature — **Scaffolder golden-path templates** that create a new team
app repo pre-wired to the platform contract. Human SSO is via the **shared Dex broker**
(same as ArgoCD/Harbor). At `https://relay.<PLATFORM_DOMAIN>` (interim:
`https://relay.127-0-0-1.sslip.io`).

- Chart: `backstage` **2.8.2** (OCI: `oci://ghcr.io/backstage/charts`), pinned,
  Helm-source Application `applicationsets/backstage-relay-app.yaml` (deploy method A —
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
> block is **commented out**. Relay goes live only after the **To go live** checklist
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

applicationsets/backstage-relay-app.yaml     # the Backstage Helm Application (chart 2.8.2)
bootstrap/platform-appproject.yaml           # sourceRepos += ghcr.io/backstage/charts (INSTALL-OWNED)
platform-services/dex/configmap.yaml         # the `relay` Dex static client
platform-services/dex/deployment.yaml        # RELAY_CLIENT_SECRET env (optional until re-sealed)
```

---

## The custom image (the load-bearing prereq)

Backstage is **not** a configure-and-run server. You scaffold your **own** app, wire the
plugins you need, build a container, and run THAT. The chart's default image
`ghcr.io/backstage/backstage:latest` is a demo and has **neither** our Dex OIDC auth
provider **nor** the Relay Scaffolder/catalog wiring. So `image` in the Application points
at a Harbor-hosted image we must build (`harbor.<domain>/library/backstage-relay`, tag is a
PLACEHOLDER `v0.1.0` until built).

### Build it (one time, then on plugin changes)

```bash
# 1. Scaffold the Backstage app (Node 20+, Yarn). Creates ./relay.
npx @backstage/create-app@latest --path relay
cd relay

# 2. Add the plugins Relay needs (backend = "new" backend system):
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
#    (The Helm values in applicationsets/backstage-relay-app.yaml are MERGED on top, so
#    keep the env-substituted ${VAR} names identical: AUTH_OIDC_CLIENT_ID/SECRET,
#    BACKEND_SECRET, POSTGRES_PASSWORD, GITHUB_TOKEN.)

# 4. Build the image and push to Harbor (library project):
yarn install --immutable
yarn tsc
yarn build:backend
docker build . -f packages/backend/Dockerfile \
  -t harbor.<PLATFORM_DOMAIN>/library/backstage-relay:v0.1.0
docker login harbor.<PLATFORM_DOMAIN>          # or a robot account
docker push harbor.<PLATFORM_DOMAIN>/library/backstage-relay:v0.1.0
```

Then bump `backstage.image.tag` in `applicationsets/backstage-relay-app.yaml` to the
real built tag. (Building INSIDE the platform — a Kaniko job on the ARC runners pushing
to Harbor — is the eventual story; bootstrap it manually the first time.)

---

## To go live (checklist)

Do these **in order**, after the cluster heal + the Phase-3 domain cutover:

1. **Domain cutover.** This scaffold uses the interim `127-0-0-1.sslip.io` literal
   everywhere (the repo-wide convention — same as Dex/Harbor/ArgoCD today). At the
   Phase-3 cutover, the platform-wide find-replace `127-0-0-1.sslip.io` ->
   `capstone.uamishub.com` (D-036) updates Relay's host to `relay.capstone.uamishub.com`
   in lockstep with every other service. Files to update for Relay specifically:
   - `applicationsets/backstage-relay-app.yaml` (ingress `host`, `baseUrl`, `cors`,
     `metadataUrl`, the Harbor image registry).
   - `platform-services/dex/configmap.yaml` (the `relay` static-client `redirectURIs`).

2. **Add the `relay` client secret to Dex.** Generate a secret, seal it into BOTH places
   (same value — exactly like Harbor's pairing), then drop the `optional: true` on the
   `RELAY_CLIENT_SECRET` env in `platform-services/dex/deployment.yaml`:
   ```bash
   RELAY_CS=$(openssl rand -base64 32)
   # (a) add key `relay-client-secret` to the dex-github SealedSecret. Re-seal the whole
   #     secret with all existing keys + this new one (see platform-services/dex/README.md).
   # (b) seal AUTH_OIDC_CLIENT_SECRET=$RELAY_CS into backstage-relay-secrets (step 3).
   ```

3. **Re-seal the Backstage secrets** (replace the PLACEHOLDERs). The current
   `sealedsecret-oidc.yaml` / `sealedsecret-postgresql.yaml` hold inert base64 of
   "PLACEHOLDER" (annotated `platform.capstone/placeholder: "true"`). Re-seal with real
   values per the headers in those files. Keep `password` (postgresql) ==
   `POSTGRES_PASSWORD` (relay-secrets), and `AUTH_OIDC_CLIENT_SECRET` == the Dex
   `relay-client-secret`. Add a `GITHUB_TOKEN` key (repo + admin:org on UA-MIS) for the
   Scaffolder's `publish:github` + catalog org ingestion.
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
   and remove the `prep-do-not-deploy` annotation. ArgoCD then syncs Relay.

8. **Verify** (see below).

---

## The golden-path Scaffolder template

`templates/new-capstone-project/template.yaml` is the headline feature. A student fills
**four fields** (`appName`, `team`, `semester`, `port`) + picks the repo location, and Relay:

1. **`fetch:template`** renders `skeleton/` — a starter Go `app/`, the 4-field
   `.devops/app-metadata.yaml`, `catalog-info.yaml`, and TechDocs.
2. **`fetch:plain`** overlays the **canonical, immutable** `.devops/` contract (CI
   workflow, `chart/` base+overlays, `promotion.yaml`, `ci/` scripts) copied verbatim
   from the reference golden-path repo — so every team gets the SAME platform contract.
3. **`publish:github`** creates `UA-MIS/<app-name>` (private, branch-protected: PRs into
   `main`, no direct pushes — mirrors the live platform policy).
4. **`catalog:register`** registers the new component so it appears in the Relay catalog.

The result is a repo identical in shape to `team-sample-app`: the student edits only
`app/` + the four `app-metadata.yaml` fields; everything else is platform-managed. The
scaffolded `app/` ships with passing `go test` so CI is green on the first PR.

### Follow-up: full two-sided onboarding (not yet automated)

Creating the **repo** is half of onboarding. The **platform side** still needs:
- the tenant manifests `tenants/team-<name>/` (from `tenants/_template/`, `__TEAM__`/
  `__SEMESTER__` sed-replace) — namespaces, AppProject, RBAC, quotas, the env
  ApplicationSets. This is a **commit to platform-infra** (PR-gated), so it can't be a
  silent Scaffolder write.
- the Harbor project + OIDC group mapping: `make harbor-onboard NAME=<name>`.

The clean next iteration is a second Scaffolder step that opens a **pull request to
platform-infra** adding `tenants/team-<name>/` (action `publish:github:pull-request`) plus
a documented `make harbor-onboard`. Tracked as a follow-up; the repo-creation half is the
solid, reviewable skeleton delivered here.

---

## SSO via Dex

Same broker as ArgoCD/Harbor (NO new GitHub OAuth app). The `relay` static client is
added in `platform-services/dex/configmap.yaml`; its secret is env-injected into both Dex
(`RELAY_CLIENT_SECRET`) and Backstage (`AUTH_OIDC_CLIENT_SECRET`). Backstage fetches Dex
discovery server-side at the issuer `id.<domain>` (in-cluster via the `coredns-custom`
rewrite -> Traefik -> Dex, the slice-1 pattern, reused — no new DNS rewrite). The OIDC
auth provider + sign-in resolver must be **wired in the custom image's backend** (the demo
image doesn't ship it); the `auth.providers.oidc` block in the Application's values drives
that wired provider. Org gating is enforced UPSTREAM at Dex (UA-MIS-only, SEC-007).

---

## Validation (post-go-live)

- Relay UI reachable over TLS at `https://relay.<domain>`; "Sign in" via Dex works for a
  UA-MIS member; a non-member is rejected at Dex.
- The Backstage pod is `Running`; the Postgres StatefulSet is bound on `ceph-block`.
- The **catalog** shows the "New Capstone Project" template under "Create".
- Running the template creates `UA-MIS/<app-name>`, the repo has `app/` + `.devops/`, its
  first PR builds a preview, and the new component appears in the catalog with TechDocs.
- No SealedSecret carries `platform.capstone/placeholder: "true"` (step 3 audit).

## Notes / known caveats

- Chart 2.8.2 bundles Bitnami postgresql 12.10.0, which renders the
  `bitnamilegacy/postgresql` image. Fine for the proof; pin/mirror to Harbor (or move to
  the external `ua-mis-db-1` PG17) as a hardening follow-up.
- `automountServiceAccountToken`, NetworkPolicy isolation for the `backstage` namespace,
  and a PodDisruptionBudget are deferred to a security pass (the chart exposes
  `networkPolicy.enabled` + `backstage.pdb` when wanted) — flagged, not blocking for prep.
