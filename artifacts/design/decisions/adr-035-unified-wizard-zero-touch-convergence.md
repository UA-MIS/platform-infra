# ADR-035 — Unified "New Project" wizard: zero-touch convergence + blank/BYO + retirement

- Status: **Proposed** (design-only; branch `arc/unified-wizard-design`, NOT merged) —
  **requires human approval** (architecture gate; see §Human approvals).
- Date: 2026-07-02
- Author: architect (overnight run)
- Builds on: **ADR-034** (the unified wizard + compose engine + fragment contract — Phase A,
  PR #154), **ADR-031** (Crossplane zero-touch / CapstoneTenant XR), **ADR-033 / #146**
  (auto per-tenant MySQL), **#184** (DATABASE_URL ExternalSecret in `_contract/` overlays),
  **#186** (`database` field wired into `emit-tenant-claim` + zerotouch template).
- Supersedes (on cutover): the 6 per-stack templates + `new-capstone-project` +
  `new-capstone-project-zerotouch` (all collapse into the one `new-project`). **VM stays
  separate** (`vm-app`, ADR-032).

## Context — what already exists (this is a CONVERGENCE, not a greenfield build)

The overnight fan-out already delivered most of the vision:

- **`templates/new-project/template.yaml`** IS the single unified, fragment-composed wizard
  (ADR-034 Phase A): one branching form → `projectType` (web/mobile) → `layout`
  (single / frontend-backend) → pick fragment(s) → `database`. It is **NOT yet registered**
  in `catalog/all.yaml`, so users can't see it.
- **`capstone:compose-project`** (the engine) is live in the module and reads each
  `fragment.yaml` at scaffold time — O(N) drop-in fragments, no per-combo templates.
- **~24 fragments already exist** under `_fragments/`: backend (django, dotnet-aspnet,
  express, fastapi, flask, go, laravel, nestjs, node-bare, rails, rust-axum, spring-boot),
  frontend (angular, react, solid, vue), fullstack (nuxt, sveltekit), mobile (android-kotlin,
  flutter, ios-swift, react-native), static (bare-html, react-static) — plus the ONE shared
  `_fragments/_contract/` with #184's DATABASE_URL ExternalSecret overlays.

So the headline ask ("one wizard, dozens of stacks, zero-touch, green out of the box") is
**~70% delivered**. What is missing is the *convergence + finishing* work:

1. **The wizard's platform-side path is still IMPERATIVE.** `new-project` steps 4–6 are
   `capstone:harbor-onboard` + `capstone:render-tenant` + `publish:github:pull-request`
   (a review-gated onboarding PR + post-merge operator make-steps). It does **not** use the
   zero-touch `CapstoneTenant` claim, so `database` is recorded into `app-metadata.yaml` but
   never provisions a DB, and onboarding still needs a human merge + operator robot steps.
2. **No single entry point yet.** `new-project` is unregistered; the 8 legacy templates are
   what users see in `catalog/all.yaml`.
3. **No blank / bring-your-own-code path.** `node-bare` and `bare-html` are the closest but
   both ship real sample apps, not an empty "your code goes here" placeholder.
4. **A repo-ownership collision** between the scaffolder and the Crossplane Composition
   (§D2) that must be resolved before zero-touch is trusted.
5. **The DATABASE_URL consume-ES gap** the zerotouch skeleton has (#186 flagged it) —
   convergence dissolves it for free (§D3).

## Decision

### D1 (strategic) — Converge on ONE registered wizard using the zero-touch claim path

`new-project` becomes **the** single entry point. Replace its imperative steps 4–6 with the
zero-touch seam:

```
  1. compose            capstone:compose-project        (unchanged — fragments + _contract)
  2. publish            publish:github                  (unchanged — create UA-MIS/<app>, push code, protect, grant team)
  3. register           catalog:register                (unchanged)
  4. emit-claim         capstone:emit-tenant-claim      (NEW — writes tenants/_claims/<team>-<app>.yaml, database set)
  5. commit-claim       capstone:commit-to-main         (NEW — direct commit to platform-infra main; PR fallback)
```

Steps 4–5 are exactly what `new-capstone-project-zerotouch` already does (post #186) — we are
moving that proven seam onto the fragment-composed wizard and deleting the imperative trio.
The `database` wizard choice flows `compose` → `app-metadata.yaml` **and** `emit-claim`'s
`database` input → the `CapstoneTenant` XR → the Composition's auto-MySQL (ADR-033). One
choice, both halves wired.

**Why converge instead of patching both templates:** `new-project`'s `_contract/` carries
#184's DATABASE_URL ExternalSecret in every overlay (the *consume* half). The zerotouch
template's skeleton does **not** (#186 flagged this gap). Rather than back-port the ES into
the zerotouch skeleton *and* separately give `new-project` the claim path, we do it once:
the unified wizard uses `new-project`'s `_contract` (has the consume-ES) **and** the claim
path (the provision-trigger). Convergence closes the #186 gap as a side effect. This is the
load-bearing reason convergence beats maintaining two templates.

### D2 (strategic, needs human approval) — Repo ownership: the SCAFFOLDER owns the code repo; the claim owns platform tenancy

The `CapstoneTenant` Composition currently provisions a GitHub `Repository` **bootstrapped
from `capstone-app-template`** (`composition.yaml` §GITHUB). The scaffolder's `publish:github`
step ALSO creates `UA-MIS/<app>` and pushes the **composed fragment code**. These collide,
and worse: bootstrapping from `capstone-app-template` would overwrite the fragment starter
the student just chose — defeating the entire wizard.

**Decision:** the scaffolder is the sole owner of the code repo. `publish:github` creates the
repo, pushes the composed fragment skeleton, protects `main`, and grants the team. The
Composition **drops its GitHub repo-creation MRs** (`Repository` + template bootstrap +
`TeamRepository` + branch-protection) and provisions **only Harbor + Vault + the k8s tenancy
fence + the DB**. This shrinks the claim's blast radius (security-positive — no org-admin
repo-create from the auto-committed claim) and is the only model compatible with the fragment
engine.

- Rejected — *claim owns the repo, drop `publish:github`*: the composed fragment code would
  never be pushed; the wizard's stack choice becomes meaningless. Non-starter.
- Rejected — *both create it, rely on provider-github idempotency*: a create-from-template MR
  against an existing repo conflicts, and even if it adopted, the `capstone-app-template`
  bootstrap clobbers the fragment code. Non-starter.

This is a change to the **Crossplane track's** Composition (Track-5, ADR-031) and alters its
security surface, so it is a **human-approval decision** and a coordination seam with that
track. The Composition is not yet applied to a cluster (still Phase-0), so the edit is cheap
now — do it before zero-touch goes live.

### D3 — `database` mapping (wizard → claim) and the consume/provision split

The wizard's 4-option `database` maps to the XRD's 2-value enum `[none, mysql]`:

| wizard `database` | claim `spec.database` | DATABASE_URL ExternalSecret wired? | who fills the secret |
| --- | --- | --- | --- |
| `host-mysql`      | `mysql` | yes | Crossplane provider-sql (auto, per-env, ADR-033) |
| `host-postgres`   | `none`  | yes | the student (Secrets tab) — BYO until Composition adds Postgres |
| `bring-your-own`  | `none`  | yes | the student (Secrets tab) |
| `none`            | `none`  | no  | — |

The compose engine already resolves `database: mysql` **only** for `host-mysql` AND a
DB-using component (never provisions an unused DB) and gates the consume-ES on `dbWired`.
`emit-claim` receives the resolved `mysql|none` (not the raw 4-way choice).

### D4 — A blank / bring-your-own-code fragment (green out of the box)

Add ONE fragment `_fragments/blank/bring-your-own/` (new category `blank`, fills the `single`
slot; FE+BE BYO is future). "Blank" does **not** mean an empty repo that fails CI — it means
a **minimal working placeholder the student replaces**, so the very first CI run is GREEN:

- `skeleton/Dockerfile` — a real, tiny multi-stage Dockerfile that builds + runs the
  placeholder (busybox/static-http or a 20-line language-agnostic HTTP responder) listening on
  `${{ values.port }}`, serving `GET /healthz` → 200 (chart probes stay green) and `GET /` →
  a friendly "replace me" page.
- `skeleton/README.md` — "**Your code goes here.** Replace this app and edit the `Dockerfile`
  to build it. Keep `GET /healthz` returning 200 and listen on `$PORT`. Do not touch
  `.devops/`." (renders `${{ values.appName }}`).
- `fragment.yaml` — `category: blank`, `framework: none`, `slots: [single]`, `needsDB: false`,
  `buildType: container`, `healthPath: /healthz`, `defaultPort: 8080`.

This is the green-out-of-box guarantee generalized: **every** path — stack or blank — ships a
buildable repo with a real Dockerfile and a DB-independent `/healthz`. (See the design doc's
"Green-out-of-box" section for the CI assertion that enforces it for all fragments.)

### D5 — Retire the legacy templates on cutover (VM stays)

Once the converged `new-project` is proven green end-to-end, retire from `catalog/all.yaml`:
`new-capstone-project-zerotouch`, `new-capstone-project`, `python-fastapi-api`,
`nextjs-fullstack`, `react-express`, `dotnet-aspnet-api`, `react-static`. **Keep** `vm-app`
(the separate "New VM" button, ADR-032) and `org.yaml`. Register `new-project`. Retirement is
a `catalog/all.yaml` edit (deregister) + an optional `git rm` of the retired template dirs in a
follow-up; deregistering first is the safe, reversible cutover.

### D6 — Batch the Backstage image rebuild

Three changes compile into the custom Backstage image and MUST ship together in one rebuild +
tag bump: (a) #186's `database` input on `emit-tenant-claim`, (b) the new
`capstone:commit-to-main` action (sibling agent), (c) any `module.ts` registration for it.
The `new-project` template edit (D1) and the blank fragment (D4) are **data** served from
platform-infra and need **no** rebuild — but the template's step 5 can only run once the image
carries `commit-to-main`. Sequence accordingly (design doc §Phases).

### D7 — `capstone:commit-to-main` with a 1-click-PR fallback

Step 5 uses `capstone:commit-to-main` (direct commit of the claim to `platform-infra` main via
the platform GitHub App on the branch-protection bypass list — true zero-touch, no merge).
Until that action lands in the image, step 5 falls back to `publish:github:pull-request` (the
1-click auto-mergeable claim PR the zerotouch template uses today). Design the template so the
swap is a single-step change.

## Human approvals required

1. **This ADR (architecture gate)** — the convergence + repo-ownership model (project invariant:
   architecture requires human approval).
2. **D2 Composition repo-ownership change** — drops the Composition's GitHub repo MRs; alters
   the Crossplane security surface; coordinate with the Crossplane track.
3. **D5 retirement** — deregistering 7 user-facing templates; confirm timing (after e2e-green).
4. **`capstone-app-template` bootstrap removal** — confirm no other consumer depends on the
   Composition creating repos from it.
5. **`previewEnabled` default** — stays `false` (security-gated preview ApplicationSet); confirm.

## Consequences

- One entry point, zero-touch, DB auto-provisioned, green out of the box for every path.
- The #186 consume-ES gap is closed structurally (convergence), not patched twice.
- The claim's blast radius shrinks (no repo-create from the auto-committed claim).
- One-time cost: a single batched image rebuild (D6); fragments + template stay rebuild-free.
- The Composition edit (D2) is a cross-track dependency — the wizard's zero-touch path is not
  trustworthy until it lands, so D2 gates the cutover (D5), not the wizard's authoring.
