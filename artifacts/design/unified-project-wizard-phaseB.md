# Unified "New Project" wizard — Phase B design + implementation plan

**Status:** design-only (branch `arc/unified-wizard-design`, do NOT merge). Companion to
**ADR-035** (decisions) and **ADR-034** (the compose engine + fragment contract this builds on).

**One-line goal:** finish the single "New Project" wizard so it is the *only* app/stack entry
point, provisions the whole tenant zero-touch (repo + Harbor + Vault + namespaces + DB) from
ONE form submit, and produces a GREEN-on-first-CI repo for **every** path including
bring-your-own-code. The VM template (`vm-app`) stays a separate button.

---

## 1. Where we are (verified, 2026-07-02)

- `templates/new-project/template.yaml` — the unified fragment-composed wizard EXISTS (ADR-034
  Phase A) but is **unregistered** and uses the **imperative** platform-side path.
- `capstone:compose-project` engine — **live in the module**; reads `fragment.yaml` at runtime.
- **~24 fragments** exist under `_fragments/` (backend×12, frontend×4, fullstack×2, mobile×4,
  static×2) + the shared `_fragments/_contract/` with #184's DATABASE_URL ExternalSecret overlays.
- `capstone:emit-tenant-claim` — live; #186 added its `database` input + wired the zerotouch
  template. Writes `tenants/_claims/<team>-<app>.yaml`.
- `capstone:commit-to-main` — **does not exist yet** (sibling agent building it). Only the
  1-click PR path (`publish:github:pull-request`) exists today.
- `catalog/all.yaml` registers 8 templates: 2 capstone (imperative + zerotouch) + 5 stack +
  `vm-app`. `new-project` is absent.
- **Repo-ownership collision** (ADR-035 §D2): the `CapstoneTenant` Composition creates a GitHub
  repo from `capstone-app-template`, colliding with the scaffolder's `publish:github` push of
  composed fragment code. Must be resolved before zero-touch is trusted.

## 2. Target wizard (form is already correct; only the STEPS change)

The Phase-A form (`spec.parameters`) already implements the user's vision exactly:
`projectType (web|mobile)` → web: `layout (single|frontend-backend)` → pick fragment(s) from
the full library → `database (host-mysql|host-postgres|bring-your-own|none)` → app/team/
season/year/port. **No form change needed** except adding the blank fragment to the
`singleFragment` enum (§4) and (optional) reordering fields so team/app come first.

### 2.1 The step change (the core of Phase B)

Replace `new-project` steps 4–6 (harbor-onboard + render-tenant + tenant-pr) with:

```yaml
    # 4) Emit the ONE CapstoneTenant claim (zero-touch onboarding seam, ADR-031/035).
    - id: emit-claim
      name: Emit tenant claim (CapstoneTenant XR)
      action: capstone:emit-tenant-claim
      input:
        team: ${{ parameters.team }}
        appName: ${{ parameters.appName }}
        semester: ${{ parameters.year }}-${{ parameters.season | lower }}
        port: ${{ parameters.port }}
        database: ${{ steps['compose'].output.database }}   # resolved mysql|none (ADR-035 §D3)
        # previewEnabled omitted -> false (security-gated); domain omitted -> default
        targetPath: ./claim

    # 5) Land the claim on platform-infra main (true zero-touch; PR fallback until action ships).
    - id: commit-claim
      name: Land tenant claim on platform-infra
      action: capstone:commit-to-main            # FALLBACK: publish:github:pull-request (1-click)
      input:
        repoUrl: github.com?owner=UA-MIS&repo=platform-infra
        branch: main
        sourcePath: ./claim
        commitMessage: "onboard tenant: ${{ parameters.team }}-${{ parameters.appName }}"
```

`steps['compose'].output.database` is the engine-resolved `mysql|none` (ADR-035 §D3). If the
compose action does not already expose that output, adding it is a one-line engine change
(reads the same value it writes to `app-metadata.yaml`) — batch into the image rebuild (§5,
Phase 2). Steps 1–3 (compose, publish:github, register) are unchanged; `publish:github` remains
the sole repo creator (ADR-035 §D2).

### 2.2 Fallback step (until `commit-to-main` is in the image)

```yaml
    - id: commit-claim
      name: Land tenant claim on platform-infra (1-click merge)
      action: publish:github:pull-request
      input:
        repoUrl: github.com?owner=UA-MIS&repo=platform-infra
        branchName: claim-${{ parameters.team }}-${{ parameters.appName }}
        targetBranchName: main
        title: "onboard tenant: ${{ parameters.team }}-${{ parameters.appName }}"
        sourcePath: ./claim
        token: ${{ secrets.GITHUB_TOKEN }}
```

Swapping fallback → `capstone:commit-to-main` is a single-step edit (design keeps them
interchangeable — same `sourcePath`).

## 3. Fragment → skeleton → XR data flow (unchanged from ADR-034, restated for implementers)

```
wizard form  ──►  capstone:compose-project ──►  repo tree in workspace
   (fragment ids,      │  reads each fragment.yaml (port/path/needsDB/buildType)
    database, app,     │  renders fragment skeleton(s) into app/ | frontend/+backend/ | backend/+mobile/
    team, semester)    │  renders _contract/ ONCE (chart+overlays+CI+catalog-info), incl. DATABASE_URL ES
                       │  writes .devops/components.yaml + app-metadata.yaml (database=mysql|none)
                       └─ output: database (mysql|none)  ◄── feeds emit-claim (§2.1)
   publish:github  ──►  creates UA-MIS/<app>, pushes the tree, protects main, grants team
   emit-tenant-claim ─► tenants/_claims/<team>-<app>.yaml  (spec.database = mysql|none)
   commit-to-main  ──►  claim on platform-infra main  ──►  Crossplane Composition fans out:
                          Harbor project + robots, Vault path + ESO, k8s namespaces + AppProject,
                          and (if database=mysql) per-env MySQL + DATABASE_URL secret at
                          tenants/<team>/<env>/database  ──►  the repo's DATABASE_URL ES resolves.
```

## 4. Blank / bring-your-own-code fragment (ADR-035 §D4)

New fragment `_fragments/blank/bring-your-own/`:

```
_fragments/blank/bring-your-own/
  fragment.yaml            # category: blank, framework: none, slots:[single], needsDB:false,
                           # buildType:container, healthPath:/healthz, defaultPort:8080
  skeleton/
    Dockerfile             # tiny multi-stage: build+run a placeholder that listens on $PORT,
                           #   serves GET /healthz->200 and GET / -> "replace me" page
    README.md              # "Your code goes here. Edit the Dockerfile. Keep /healthz 200,
                           #   listen on $PORT, don't touch .devops/."  (renders ${{ values.appName }})
    <placeholder app>      # e.g. a static index.html served by nginx, OR a 20-line http responder
```

Then `python3 _fragments/_tools/gen-wizard-enums.py` and paste the regenerated
`singleFragment` enum/enumNames into `new-project/template.yaml` (adds `blank/bring-your-own`
→ "Blank / bring-your-own-code (starter placeholder + Dockerfile)"). No engine or image change.

**Green guarantee:** the placeholder builds and passes `/healthz`, so the student's first CI
run (and first deploy) is green *before* they write a line — then they replace it incrementally.

## 5. Green-out-of-box strategy (every path, enforced)

1. **Every fragment ships a real Dockerfile** (mobile: a build workflow instead) and a
   DB-independent `GET /healthz` (backends) — already the fragment contract (ADR-034).
2. **The blank path** ships a working placeholder (§4), not an empty repo.
3. **DB-optional apps degrade cleanly:** backends read `DATABASE_URL` and return a clear 503
   (not a crash) when unset, so probes stay green pre-provision.
4. **CI assertion (new):** extend `_fragments/_tools/dry-render.py` into a CI check that, for
   **every** fragment, (a) asserts a `Dockerfile` (or `buildWorkflow`) exists, (b) composes a
   sample repo + runs `kubectl kustomize` on all 4 overlays, (c) optionally `docker build`s the
   Dockerfile. Gate it in the platform-infra CI so a green-breaking fragment can't merge. This
   is the durable guarantee behind "green out of the box."

## 6. Migration — retire the legacy templates (ADR-035 §D5)

**Cutover is a single reversible edit to `catalog/all.yaml`:**

- **Remove** targets: `new-capstone-project-zerotouch`, `new-capstone-project`,
  `python-fastapi-api`, `nextjs-fullstack`, `react-express`, `dotnet-aspnet-api`,
  `react-static`.
- **Add** target: `.../templates/new-project/template.yaml`.
- **Keep**: `vm-app` (separate "New VM" button), `org.yaml`.

Order (safe): (1) register `new-project` alongside the legacy set and prove it green e2e; (2)
in the SAME or a follow-up PR, remove the 7 legacy targets. Deregistering leaves the template
dirs on disk (reversible); a later housekeeping PR may `git rm` the retired dirs +
`harbor-onboard.ts`/`render-tenant.ts` if no other consumer remains (verify first — they are
still referenced by the imperative path until cutover).

## 7. Phased implementation plan (discrete PRs for implementer agents)

Ordered; brackets show dependencies. Each is one implementer's PR.

- **PR-A — Blank/BYO fragment** *(no deps, no image rebuild)*. Add
  `_fragments/blank/bring-your-own/` (fragment.yaml + skeleton + Dockerfile + README), regen +
  paste wizard enums. Validate with `dry-render.py`. **Owner: developer.**
- **PR-B — Green-out-of-box CI check** *(no deps)*. Promote `dry-render.py` to a CI gate that
  asserts Dockerfile-exists + kustomize-builds for every fragment (incl. blank). **Owner: developer.**
- **PR-C — Compose engine `database` output** *(image rebuild)*. Ensure
  `capstone:compose-project` outputs the resolved `mysql|none`. Unit test. **Owner: developer.**
  *(Small; fold into the batched rebuild PR-E if preferred.)*
- **PR-D — Composition repo-ownership change** *(Crossplane track; HUMAN APPROVAL, ADR-035 §D2)*.
  Drop the Composition's GitHub repo-create MRs (`Repository` + template bootstrap +
  `TeamRepository` + branch-protection); claim provisions Harbor + Vault + fence + DB only.
  Coordinate with the Crossplane track. **Owner: devops + security review.**
- **PR-E — Batched Backstage image rebuild** *(deps: `commit-to-main` from sibling; PR-C)*.
  Compile #186's `database` input + `capstone:commit-to-main` + PR-C into the image; register
  `commit-to-main` in `module.ts`; bump the image tag. **Owner: developer/devops.**
- **PR-F — Converge `new-project` steps** *(deps: PR-E in the deployed image)*. Swap steps 4–6
  → `emit-claim` + `commit-claim` (§2.1); wire `database` from `compose` output; keep the
  1-click-PR fallback until `commit-to-main` is confirmed live. **Owner: developer.**
- **PR-G — Register + prove green e2e** *(deps: PR-F)*. Add `new-project` to `catalog/all.yaml`;
  run a real scaffold of one stack + one blank + one FE+BE, confirm repo is green + tenant
  reconciles + DB provisions. **Owner: developer + reviewer.**
- **PR-H — Retire legacy templates** *(deps: PR-G green; HUMAN APPROVAL, ADR-035 §D5)*. Remove
  the 7 legacy targets from `catalog/all.yaml`. Follow-up housekeeping `git rm` optional.
  **Owner: developer.**

**Critical path:** PR-D ‖ (PR-C→PR-E→PR-F→PR-G→PR-H). PR-A/PR-B run in parallel anytime.
PR-D and PR-G both gate PR-H (retirement) — do not retire the legacy path until zero-touch is
proven green AND the Composition no longer collides on the repo.

## 8. Top implementation risks

1. **Repo-ownership collision (ADR-035 §D2)** — highest. If PR-D doesn't land, the claim's
   repo-from-`capstone-app-template` MR fights `publish:github` and can clobber fragment code.
   Zero-touch is untrustworthy until PR-D. Cross-track (Crossplane) + human approval.
2. **`commit-to-main` timing** — PR-F's zero-touch step depends on the sibling's action being in
   the image (PR-E). The 1-click-PR fallback de-risks this (ship PR-F on the fallback, swap later).
3. **`database` output seam** — if `compose` doesn't already output `mysql|none`, emit-claim
   gets an empty/raw value and either over- or under-provisions. PR-C closes it; add a template
   assertion that `database` ∈ {mysql,none} before emit.
4. **Retirement regressions** — a student mid-flight on a legacy template, or another catalog
   entity referencing a retired template. Deregister-not-delete (PR-H) keeps it reversible; grep
   the repo for references first.
5. **Image-rebuild batching** — shipping emit-claim/`database`, `commit-to-main`, and PR-C
   separately triples the rebuild cost and risks a half-wired image. One batched rebuild (PR-E).
