# Self-contained scaffolder — design (DRAFT, do not merge)

**Directive (human, 2026-06-24):** "Fresh scaffold should pass build-and-push first
try. Don't reference a repo to make the scaffold — the scaffold code itself contains
the blueprint. Deleting sample-app should have no bearing on us."

**Goal:** a fresh `New Capstone Project` scaffold builds + deploys **first try**, with
**zero dependency on UA-MIS/sample-app** (no `fetch:plain` of an external repo, no
contract tag to maintain, no GitHub-App access to sample-app).

---

## 1. Current architecture (the problem)

`template.yaml` builds a tenant repo from THREE sources:
1. `fetch:template ./skeleton` → the starter app + metadata (renders `${{ values.* }}`).
2. `fetch:plain  github.com/UA-MIS/sample-app/tree/v1.0.0/.devops` → the golden-path contract.
3. `fetch:plain  github.com/UA-MIS/sample-app/tree/v1.0.0/.github` → the CI workflow.

**Why this fails the "first-try" goal:**
- **External coupling:** every scaffold reaches out to UA-MIS/sample-app; the platform
  GitHub App must have read access to it; deleting/renaming sample-app breaks all scaffolds.
- **Contract-tag maintenance:** the `v1.0.0` pin (#97) must be cut + bumped per change.
- **🔴 Latent correctness bug (the real "apps don't work first try"):** the `.devops`
  tree fetched from sample-app is **hardcoded to `sample`** — `namespace: sample-dev`,
  `newName: harbor.capstone.uamishub.com/sample/sample`, host `sample.sample.dev.…`,
  `registry: harbor.…/sample`, `app: sample`, `platform.capstone/team: sample`. A fresh
  scaffold of team `acme` app `foo` gets these **verbatim** → it would build/deploy as
  `sample`, not `acme/foo`. `fetch:plain` copies bytes; it does NOT substitute. So the
  current scaffold is only correct for the sample app itself.

## 2. Proposed architecture (self-contained)

**Embed the `.devops/` and `.github/` trees INTO the skeleton** and render them through
`fetch:template`, so:
- the blueprint lives in platform-infra (still central, still reviewed) — but in the
  *scaffolder's own skeleton*, not an external repo;
- `${{ values.appName }}` / `${{ values.team }}` are substituted into the contract, so a
  fresh `acme/foo` scaffold is correct for `acme/foo` (fixes the latent bug);
- no `fetch:plain`, no sample-app dependency, no contract tag, no App-access-to-sample-app.

### 2.1 The `${{ }}` collision + the fix (load-bearing)
GitHub Actions workflows use `${{ github.sha }}` etc. — the SAME `${{ }}` nunjucks uses.
Rendering `.github/workflows/build-and-push.yaml` through `fetch:template` would corrupt it.

**Verified:** across the whole `.devops` + `.github` tree, **exactly one file** contains
`${{` — `.github/workflows/build-and-push.yaml`. The `.devops` shell scripts use `${VAR}`
(single brace, nunjucks ignores); nothing else collides.

**Fix:** `fetch:template` with broad copy-without-templating globs over the whole CI
surface (the workflow + the ci/ scripts), so nothing in those subtrees is ever
nunjucks-rendered:
```yaml
copyWithoutTemplating:        # Backstage 1.52 key; older name copyWithoutRender (dep. 1.40)
  - '**/.github/**'           # GitHub Actions ${{ }} (build-and-push.yaml) + actionlint
  - '**/.devops/ci/**'        # shell scripts (${VAR}, nunjucks-safe — belt-and-suspenders)
```
Only `build-and-push.yaml` strictly NEEDS protection (the only `${{` file), but the broad
globs ship the entire CI surface VERBATIM so a future `${{`-using edit can't silently
break. **Verified safe:** nothing under `.github/` or `.devops/ci/` uses `${{ values.* }}`
— so protecting both subtrees never suppresses a needed substitution. The workflow needs
no per-team templating anyway: it self-derives registry + app from `promotion.yaml` at
runtime (`resolve-image.sh` reads `.registry`/`.app` via yq); templatizing promotion.yaml's
two scalars makes the static workflow correct per team. **Key-name caveat:** if the
deployed 1.52 action rejects `copyWithoutTemplating`, rename to `copyWithoutRender` (same
semantics) — confirm at e2e.

### 2.2 What gets templatized (the `sample` → `${{ values.* }}` map)
Render these files (substitute by KEY/context — team==app=="sample" in the source, so
the distinction is by field, not value):

| literal in source | becomes | appears in |
|---|---|---|
| `namespace: sample-<env>` | `${{ values.team }}-<env>` | 4 overlays |
| `registry: harbor.…/sample` | `harbor.…/${{ values.team }}` | promotion.yaml |
| `app: sample` | `${{ values.appName }}` | promotion.yaml |
| `newName: harbor.…/sample/sample` | `harbor.…/${{ values.team }}/${{ values.appName }}` | 4 overlays |
| `images: - name: sample` + base `image:`/workload `name: sample` | `${{ values.appName }}` | base + overlays |
| host `sample.sample.<env>.<domain>` | `${{ values.appName }}.<env>.capstone.uamishub.com` (prod: no `<env>` segment) — team dropped, see §4 | base ingress + overlays |
| `platform.capstone/team: sample` | `${{ values.team }}` | base + overlays |
| `app.kubernetes.io/name: sample` | `${{ values.appName }}` | base + overlays |
| Secret name `sample-secret` | `${{ values.appName }}-secret` | base deployment + dev overlay |

### 2.3 Secrets — ESO + Vault (RECONCILED to ADR-030 B1; supersedes SealedSecrets)
The user chose ESO + Vault for v1 (#107 merged), so the embedded secrets contract is the
**ExternalSecret** model, not SealedSecrets. Each overlay ships three rendered files
(NO ciphertext, NO secret material in git — just names + Vault pointers):
- `secretstore.yaml` — a per-namespace `SecretStore` (`vault-tenant`) + SA (`eso-tenant`)
  authenticating to Vault via role `tenant-${{ values.team }}`, scoped to
  `secret/data/tenants/${{ values.team }}/*` ONLY (per #107's secretstore-template.yaml).
- `app-secret.externalsecret.yaml` — `APP_SECRET` ← Vault `tenants/<team>/<env>/app`
  (`deletionPolicy: Delete` so a missing value is NOT an error → M4 zero-config preserved
  alongside the base's `optional: true`).
- `harbor-pull.externalsecret.yaml` — `kubernetes.io/dockerconfigjson` templated from
  Vault `tenants/<team>/<env>/harbor-pull` (default `Retain`: required for image pull, so
  a missing value surfaces SecretSyncError to prompt onboarding).

The Vault CA reaches the tenant namespace as an in-ns ConfigMap `vault-ca` (a namespaced
SecretStore cannot cross-namespace `caProvider` the `vault`-ns cert). Values are written
to Vault by the platform onboarding step / The Process Secrets tab — NOT the student
build. (Vault-path convention coordinated with the eso-vault agent.)

### 2.4 What stays the same
- `app-metadata.yaml` — the skeleton ALREADY ships a templated one (`${{ values.* }}`); keep it.
- `.devops/secrets/README.md` — already in skeleton (A1).
- The two `publish` steps, `render-tenant`, the onboarding PR — unchanged.
- The platform domain (`capstone.uamishub.com`) is rendered (matches #103); host-DEPTH
  TLS is a SEPARATE flag (see §4).

## 3. Reconciliation with in-flight PRs
- **#97 (semver pin)** — **SUPERSEDED**: removing `fetch:plain` deletes the two `tree/v1.0.0`
  URLs entirely. If #97 already merged, this PR deletes those lines; net same end state.
  No more contract tag.
- **#103 (catalog link domain)** — **KEPT/independent**: it fixes the skeleton
  `catalog-info.yaml` link; this PR doesn't touch that. Merge #103 first or either order.
- **#102 (semester Season+Year)** — **KEPT/independent**: parameter + display/slug work,
  orthogonal to the embed. Both touch `template.yaml` but different regions (params + step
  values vs the fetch steps) — trivial merge.
- **#104 (cohort-gc draft)** — unrelated (platform-services), no interaction.

## 4. Host scheme — RECONCILED: team dropped from the host
The new tenant host drops the team segment (appName is globally unique via
`UA-MIS/<appName>`, so it's unambiguous; team stays the namespace/AppProject/RBAC key,
not the public host):
- prod (base, canonical): `${{ values.appName }}.capstone.uamishub.com`  ← chosen "cleaner"
  form over `${{ values.appName }}.prod.…` (prod = the bare public URL students share;
  fits the paid `*.capstone.uamishub.com` wildcard at ONE level).
- dev/staging/preview overlays patch in the env prefix:
  `${{ values.appName }}.{dev,staging,pr-1}.capstone.uamishub.com` (2 levels deep —
  needs `*.<env>.capstone.uamishub.com` cert depth; the user holds the paid multi-level
  cert). Dropping team REDUCES depth by one label vs the old 3–4 label scheme.

The #103 catalog-info link is reconciled to the same scheme
(`${{ values.appName }}.dev.capstone.uamishub.com`, rendered real domain).

## 5. Build-time validation
- `kustomize build` each overlay with sample values substituted → must render the same
  resources as today (parity check).
- Confirm `copyWithoutTemplating` leaves `build-and-push.yaml`'s `${{ }}` byte-identical.
- A real scaffold-render dry-run (acme/foo) → overlays show `acme-dev`, `harbor.…/acme/foo`,
  `foo.acme.dev.…` — proving the latent bug is fixed.
