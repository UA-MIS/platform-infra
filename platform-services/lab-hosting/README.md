# lab-hosting — public per-student app hosting for slidedeck's "labs" feature

Hosts a `hosted` lab's student apps at `<lab-slug>-<username>.uamishub.com`,
public, no SSO gate. A DELIBERATELY separate, much lighter mechanism from the
capstone tenant model (Backstage wizard → Crossplane XR → per-team namespaces,
promotion ladder, per-team Harbor/Vault) — ~15 students, no org GitHub identity,
no promotion model. See `RUNBOOK-DEPLOY.md` in `UA-MIS/slidedeck` for the full
lab-feature context this builds on (`hosted` flag, `labAppUrl()`,
`labRepoName()`, the existing per-student lab-mariadb + Adminer console).

> **This README was revised after an adversarial review of the original PR
> #426 diff found several blocking bugs** (case-sensitivity in the merge
> generator, a missing NetworkPolicy rule, a Cloudflare body-size cap on
> Harbor pushes, an identity-spoofing gap in the CI workflow, and unvalidated/
> unquoted template interpolation). Every section below reflects the FIXED
> design; where something changed materially from the first pass, it says so
> inline (tagged with the review finding ID, e.g. "B-1", "C-2").

This directory is EXCLUDED from the generic `platform-services` directory
ApplicationSet (see the exclude entry + comment in
`applicationsets/platform-services-appset.yaml`) — nothing here auto-syncs as a
standalone Application. It is consumed two ways instead:

- `chart/` — a Helm chart, rendered per-element by the two dedicated
  ApplicationSets below (`applicationsets/labs-namespace-appset.yaml`,
  `applicationsets/labs-students-appset.yaml`).
- `../external-secrets/vault-policies/labs-*.sh` — operator-run scripts, never
  auto-applied (same shape as `platform-services/harbor-onboarding/`).

---

## Design at a glance

```
UA-MIS/capstone-labs-fleet (NEW, private, small — slides + student CI write here)
  labs/<lab-slug>/lab.yaml            {labSlug}                — slides writes once, lab opens hosted
  labs/<lab-slug>/students.yaml       [{username, repo, labSlug}, ...] — slides writes (roster)
  labs/<lab-slug>/tags/<username>.yaml  {username, labSlug, tag} — that student's OWN CI writes

        │ git files generator (lab.yaml)      │ merge generator (students.yaml ⋈ tags/*.yaml)
        ▼                                     ▼
applicationsets/labs-namespace-appset.yaml   applicationsets/labs-students-appset.yaml
  1 Application per LAB                        1 Application per STUDENT
  → chart/ (namespaceBootstrap: true)          → chart/ (studentApp: true)
  → Namespace lab-<slug>, ResourceQuota,        → Deployment, Service, Ingress,
    LimitRange, baseline NetworkPolicies          ExternalSecret — all in ns lab-<slug>
```

A student's app becomes reachable the moment THREE independent things are all
true: (1) slides has registered them in `students.yaml`, (2) their own CI has
pushed at least once (`tags/<username>.yaml` exists), (3) the lab's namespace
bootstrap has synced. Missing (2) alone is not a failure state — the Application
still exists and Syncs, the Pod just sits `ImagePullBackOff` on the `:unreleased`
placeholder tag until their first green build (see `chart/templates/
_helpers.tpl` `lab-app.imageTag`).

## Two ApplicationSets, not one

Rendering the shared-per-lab objects (Namespace/Quota/LimitRange/NetworkPolicy)
and the per-student objects (Deployment/Service/Ingress/ExternalSecret) from the
SAME generator (exploding `students.yaml`) would give N Applications (one per
student) that all declare the identical Namespace object — ArgoCD's per-resource
ownership tracking only lets one Application "own" a shared resource, so the
others chronically fight over it (`argocd.argoproj.io/tracking-id` bouncing,
permanent OutOfSync noise). This is the exact anti-pattern
`applicationsets/platform-services-appset.yaml`'s own comments call out (the
vpa-policies/crossplane-mr-prune double-management incident) and that
`applicationsets/tenants-appset.yaml` avoids by giving each tenant its own
single bootstrap Application. A second, LAB-keyed generator (the tiny
`lab.yaml` marker file) sidesteps it entirely — see
`applicationsets/labs-namespace-appset.yaml`'s header for the full reasoning.

## Why Helm here and nowhere else in this repo

Every other ApplicationSet in this platform is a git DIRECTORY generator
(`tenants-appset.yaml`, `platform-services-appset.yaml`) — one Application per
matched DIRECTORY, source = that directory, rendered by plain kustomize. That
works because "onboard a tenant" is already a platform-infra PR (a real
directory with real files). Lab onboarding deliberately is NOT a platform-infra
PR — the whole point of the fleet-repo split is that slides (and student CI)
commit registration data to a small, separate repo with zero platform-infra
involvement. ArgoCD's git FILES/MERGE generators turn that data into per-element
PARAMETER MAPS, not directory trees, and kustomize has no way to interpolate an
arbitrary scalar (an Ingress host, an image tag, a Vault path) from a parameter
map — only `source.helm.valuesObject` on the generated Application does. Hence
one small chart, `chart/`, is the one Helm chart in an otherwise kustomize-first
platform. See `chart/Chart.yaml`'s header for the two-mode design.

## Repo-list contract (what slides must write, precisely)

`UA-MIS/capstone-labs-fleet` — private. Create it if it doesn't exist (check for
a name collision first):

```bash
gh repo create UA-MIS/capstone-labs-fleet --private \
  --description "Lab-hosting fleet data: per-lab roster + per-student build tags. Written by slidedeck + student CI; read by platform-infra's labs-*-appset ApplicationSets."
```

Three file shapes, all under `labs/<lab-slug>/`:

**`labs/<lab-slug>/lab.yaml`** — single OBJECT (not a list). Written ONCE by
slides when a lab is flagged `hosted`, deleted (or left — see Teardown) when the
lab tears down.

```yaml
labSlug: lab1
```

**`labs/<lab-slug>/students.yaml`** — a LIST. Written/maintained by slides ONLY
(add a row on registration+repo-provision, remove a row on teardown/unregister).
ArgoCD's git files generator explodes a matched list file into one generator
output PER ELEMENT — this is what makes ONE Application per student happen.

```yaml
- username: jsmith
  repo: UA-MIS/lab1-jsmith
  labSlug: lab1
```

| field | required | meaning |
| --- | --- | --- |
| `username` | yes, **already lowercase** | GitHub username, as scaffolded, LOWERCASED by slides before writing (see "Contract: lowercase everywhere" below — this is not optional). |
| `repo` | yes | `org/name` of the student's repo (== `labRepoName()` == `<labSlug>-<username>`). Carried through as an annotation only — NOT parsed to derive the image name (the chart derives that from `labSlug`+`username` directly, which is guaranteed identical to the repo name by convention). |
| `labSlug` | yes, **already lowercase** | Must exactly equal the `lab.yaml` in the same directory. Present on every row (not inferred from the file path) so the merge generator's `mergeKeys` always has it, regardless of how a given ArgoCD version injects file-path metadata. |

**`labs/<lab-slug>/tags/<username>.yaml`** — single OBJECT. Written ONLY by that
one student's own CI (`.github/workflows/lab-build.yaml`), never by slides.
Absent until the student's first successful push.

```yaml
username: jsmith
labSlug: lab1
tag: a1b2c3d4e5f6
```

`tag` is the 12-char short commit SHA `lab-build.yaml` pushed. Kept in a file
separate from `students.yaml` specifically to avoid a slides-vs-CI write race
— see `applicationsets/labs-students-appset.yaml`'s header for the full
rationale (an earlier draft had `tag` as a column on `students.yaml`;
rejected for that reason).

## Contract: lowercase everywhere (found in adversarial review, C-1)

**`username` and `labSlug` MUST already be lowercase + DNS-safe
(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`) wherever slides or student CI writes
them.** This is not a normalization the chart performs for you — it is a hard
requirement, enforced by `fail`-guards in `chart/templates/_helpers.tpl`
(`lab-app.username`, `lab-app.labSlug`) that ABORT the render if either isn't
already in that exact form.

**Why this matters more than it looks**: `applicationsets/labs-students-
appset.yaml`'s `merge` generator joins `students.yaml` (slides-written) against
`tags/<username>.yaml` (student-CI-written, via `lab-build.yaml`, which already
lowercases before writing) on `mergeKeys: [username, labSlug]` — an EXACT
STRING match, case-sensitive. The first draft of this chart "fixed" this by
silently lowercasing `username` with Helm's `| lower` filter — which does
nothing for the actual bug: the merge generator compares the RAW fleet-repo
values BEFORE Helm ever runs, so a `students.yaml` row written as `JSmith`
would simply never join with a tag file written as `jsmith`, permanently
pinning that student on the `:unreleased` placeholder with **no error
anywhere** — ArgoCD shows a normal, Synced, Healthy Application; only the
image tag is silently wrong forever. The fail-guards fix this by rejecting a
not-already-lowercase value outright: if slides ever writes mixed-case data,
the Application for that ONE student goes visibly Degraded (a clear `fail`
message naming the exact field and value) instead of silently never updating.

**This also affects the Vault path.** `chart/templates/externalsecret.yaml`
builds the read path from the SAME validated (lowercased) `labSlug`/`username`
— so the path slides writes credentials to must ALSO be the lowercased form:
`secret/labs/<lowercase labSlug>/<lowercase username>`, never the
as-scaffolded-case GitHub username. See "Vault" below.

## Contract: required + validated fields (found in adversarial review, C-2)

Every field in every fleet-repo row is REQUIRED (`username`, `repo`, `labSlug`
in `students.yaml`; `labSlug` in `lab.yaml`; `username`, `labSlug`, `tag` in a
tag file) — a missing field is not tolerated silently. Two layers enforce this
without letting one bad row take down the whole fleet:

1. **`applicationsets/labs-*-appset.yaml`** never reference a field raw
   (`{{.username}}`) — every reference is `hasKey`-guarded
   (`{{ if hasKey . "username" }}{{.username}}{{ end }}`), so a missing field
   renders as an empty string instead of aborting ArgoCD's own
   `missingkey=error` template render for the WHOLE ApplicationSet (the
   original bug: a single malformed row could have stopped every OTHER lab's
   Applications from generating/updating too).
2. **`chart/templates/_helpers.tpl`** then validates format (lowercase+DNS-safe
   for `labSlug`/`username`, `^[a-f0-9]{7,64}$` for `tag`) and REQUIREDNESS
   (empty fails the same regex check) — `fail`-ing there aborts only that ONE
   Application's Helm render, which surfaces as that one Application going
   Degraded, not a fleet-wide outage.
3. **Length cap**: `<labSlug>-<username>` is used as both a k8s label value
   and a DNS label (both 63-char capped). `_helpers.tpl`'s `lab-app.appName`
   explicitly checks `len(labSlug)+1+len(username) <= 63` and fails loudly if
   not — an uncapped combination would otherwise silently produce an invalid
   Service selector / Ingress host.

**Known risk NOT closed by the above**: a DUPLICATE `(username, labSlug)` pair
across two rows (e.g. a stale `tags/<username>.yaml` left over after a
lab-slug rename, now colliding with a re-registered student) makes the
`merge` GENERATOR itself error — that happens before any template renders, so
no `hasKey` guard reaches it. This is a fleet-repo data-hygiene concern, not
something a platform-infra manifest change can close. Recommend the operator
alert on the `labs-students` ApplicationSet's own error/degraded conditions
(`kubectl -n argocd get applicationset labs-students -o jsonpath='{.status.conditions}'`)
if catching this proactively matters.

## Contract: Vault write semantics (found in adversarial review, C-3)

The `slides-labs-writer` Vault policy
(`../external-secrets/vault-policies/slides-labs-writer-role.sh`) grants
**create + update + patch ONLY — no `read`, no `delete`.** This is already
correctly scoped in the script; stated explicitly here so the slides
implementation doesn't assume either capability:

- **Setting/updating credentials**: KV-v2 `PATCH` (merge-patch), same as
  Backstage's secrets-UX.
- **Removing a single key**: a merge-patch with that key set to `null`
  (`{"DATABASE_URL": null}`), NOT a `vault kv delete` / KV-v2 `DELETE` — the
  policy grants no `delete` capability, so an actual delete call 403s.
- **No read-back**: the slides backend cannot fetch a previously-written
  value from this path with this token. If slides ever needs to display
  "current" values back to a TA/admin, it must retain them itself (e.g. in
  its own Postgres, as it already does for the browser-only lab-mariadb
  creds) — Vault is write-only from this identity.

## Container port convention (judgment call)

Every hosted lab app MUST listen on `0.0.0.0:8080` — a fixed, platform-wide
convention (mirrors slidedeck's own port 8080), chosen specifically so
`students.yaml`/`tags/*.yaml` never need a `port` field. `PORT=8080` is also
injected into the container env (`chart/templates/deployment.yaml`) — most
frameworks (Next.js's `next start` included) honor `$PORT`, which mostly
dissolves the constraint this section used to flag as a hard blocker for the
Next.js stack template (whose `STACK_RUN_DEFAULTS` in slidedeck's
`server/scaffold.js` otherwise defaults to port 3000). A template whose
framework does NOT honor `$PORT` still needs its Dockerfile/start command
adjusted to bind 8080 explicitly.

## Image tag propagation ("bump-dev, simpler")

Mirrors the tenant `tenant-build.yaml` → `bump-dev` pattern (CI resolves + pushes
an image, then writes the new tag into a git-tracked file ArgoCD watches) with
the promotion ladder removed: single env, and the "overlay" is
`tags/<username>.yaml` instead of a kustomize image patch. See
`.github/workflows/lab-build.yaml`'s header for the full pipeline and
`applicationsets/labs-students-appset.yaml`'s `merge` generator for how the tag
reaches the rendered Deployment. **Never falls back to `:latest`** — Kyverno's
`disallow-latest-tag` ClusterPolicy is `Enforce` cluster-wide and `lab-*`
namespaces are not in its exclude list (correctly — they shouldn't be); a
student with no tag yet gets `:unreleased` (a real, non-`latest`, guaranteed-
nonexistent tag — Kyverno admits the Pod, it just sits `ImagePullBackOff`).
`tag` is also STRICTLY VALIDATED against `^[a-f0-9]{7,64}$` before it is ever
interpolated into a manifest (adversarial review B-4 — see "Security hardening"
below).

## Registry: GHCR, not Harbor (adversarial review B-2 — CHANGED from the first draft)

**The original design pushed student images to the platform's Harbor
(`harbor.capstone.uamishub.com`) from a GitHub-hosted runner. This was a real
bug, not just a judgment call**: Harbor sits behind the Cloudflare Tunnel,
which is CF-proxied — Cloudflare's Free/Pro plans cap request body size at
100MB. `platform-services/arc/hook-template.yaml` avoids this for TENANT
builds by pointing self-hosted Kaniko builders at Traefik's in-cluster
ClusterIP directly (a `hostAliases` bypass, never touching Cloudflare at all).
A GitHub-hosted runner has no equivalent bypass — every push goes over the
public internet, through the tunnel, subject to the 100MB cap. Any student
image with a layer over 100MB (routine for `node_modules` on a Next.js
template, a Spring Boot fat jar, or any ML dependency set) would 413 and look
like an unexplained platform failure.

**Fix: push to GHCR instead.** `.github/workflows/lab-build.yaml` now pushes
to `ghcr.io/ua-mis/<repo-name>:<tag>` using the workflow run's own automatic
`GITHUB_TOKEN` (scoped to that one repo, `packages: write`) — **no shared
secret needed for the push side at all**, and no Cloudflare/Harbor in the path
whatsoever. `chart/templates/_helpers.tpl`'s `lab-app.image` derives the same
`ghcr.io/ua-mis/<labSlug>-<username>` ref the chart-side, so there is exactly
one place the naming convention lives.

**Pull still needs a credential** (GHCR packages tied to a private repo
default to private visibility) — ONE static, read-scoped credential, sealed
into each `lab-<slug>` namespace as a `docker-registry` Secret named
`labs-pull` (same name the Deployment's `imagePullSecrets` already expects).
Unlike a Harbor robot (API-minted, uniquely named per project, one mint call
required per lab because robot names can't repeat), this is just a static PAT
the operator generates once in GitHub's UI/CLI — resealing the SAME value into
every lab namespace is fine (no server-side uniqueness constraint), which
removes an entire class of operator tooling (no per-lab Job to mint anything).
See "OPERATOR ACTIONS" below for the exact commands.

**Harbor is not used anywhere in the lab-hosting layer as of this revision** —
the earlier `make harbor-onboard NAME=labs` / shared push-robot / per-lab
pull-robot Job steps from the first draft of this PR are REMOVED, not just
deprioritized.

## Security hardening (adversarial review B-3, B-4)

**B-3 — identity spoofing.** The reusable workflow's `with: {lab_slug,
username}` inputs are set by the CALLER (the thin ~7-line workflow baked into
each student's OWN repo at scaffold time) — and a student has push access to
their own repo, so they can edit that caller. Without a check, a malicious
student could set `username: <victim>` to have their OWN CI write
`labs/<lab>/tags/<victim>.yaml`, redeploying the VICTIM's public URL with the
attacker's image. **Fix**: `lab-build.yaml`'s first real step reconstructs the
expected repo name (`ua-mis/<lab_slug>-<username>`, lowercased) from the
caller's claimed inputs and asserts it EXACTLY equals `github.repository` —
the one thing a student cannot forge (renaming a repo they don't admin is not
possible). This is deliberately NOT a parse of `github.repository` back into
`(lab_slug, username)` — that split is genuinely ambiguous, since `labSlug`
itself may contain hyphens (e.g. `f26-lab0`) — reconstruct-and-compare sidesteps
the ambiguity entirely: there is no `(lab_slug, username)` pair other than the
student's own real one that reconstructs their own immutable repo name.

**Residual trust**: `LAB_FLEET_TOKEN` (Contents:read/write, scoped to
`capstone-labs-fleet` ONLY) is present in the job environment for every
student's CI run. After the B-3 fix, a student cannot repurpose it to write
anyone else's file (the workflow's own git commands are hardcoded to
`labs/${LAB_SLUG}/tags/${USERNAME}.yaml`, using the now-validated values) — but
the token itself is still shared across all ~15 students' CI runs, since it
lives in the reusable workflow, not per-student. Do not grant students direct
access to mint or view this token; it should be minted and set once by the
operator (see "OPERATOR ACTIONS"), scoped to nothing beyond the fleet repo.

**B-4 — template injection.** `tag` originates from a git file a student's own
CI writes — an earlier draft interpolated it unquoted into `image:` in the
Deployment manifest. A tag value containing a YAML-significant character
(e.g. a newline) could inject sibling keys into the pod spec. Fixed two ways,
belt-and-suspenders: (1) `_helpers.tpl`'s `lab-app.imageTag` now rejects
anything that isn't `^[a-f0-9]{7,64}$` (or empty) BEFORE it is ever
interpolated anywhere — this alone closes the injection vector, since a valid
match can't contain YAML-structural characters; (2) every scalar interpolation
across the whole chart (`image`, `host`, all k8s names, the `repo` annotation)
is also explicitly `| quote`d as defense-in-depth, so even a value that
somehow bypassed validation would be YAML-string-safe, not parsed as
structure.

## Vault: read side vs write side

**Read side (this PR provides the manifest, NOT the Vault write)**:
`chart/templates/externalsecret.yaml` reads `secret/labs/<labSlug>/<username>`
(both ALREADY lowercase — see "Contract: lowercase everywhere") via the
EXISTING platform-wide `vault-backend` ClusterSecretStore (same store every
other platform service uses) — property names `DATABASE_URL`, `DB_HOST`,
`DB_NAME`, `DB_USER`, `DB_PASSWORD`, mapped 1:1 into a k8s Secret
`<appName>-db` that the Deployment consumes via `envFrom`.

**What's missing today**: `external-secrets-ro` (the policy the ESO controller's
k8s-auth role carries) does not cover `secret/data/labs/*` — see
`platform-services/external-secrets/vault-policies/labs-read-role.sh`
(drafted, not applied — agents are classifier-gated from prod Vault writes).

**Write side (slides writes the values; NOT built here)**:
`platform-services/external-secrets/vault-policies/slides-labs-writer-role.sh`
drafts the WRITE-only policy + k8s-auth role slides' backend will authenticate
as (mirrors `backstage-role.sh` exactly — see "Contract: Vault write
semantics" above for the exact capability set: create/update/patch only, no
read-back, no delete). Wiring the slides Deployment to actually present that
identity (a projected serviceAccountToken volume, same as
`backstage-process-app.yaml`) is a slidedeck-repo change — out of scope for
this PR; the script only stands up the Vault-side identity ahead of that
wiring landing.

## Netpol: lab pods reaching lab-mariadb (adversarial review B-1 — CRITICAL fix)

**This was a real, would-have-shipped-broken bug.** `platform-services/lab-db/
netpol.yaml` (already live on `main`, from PR #425) governs ingress to the
`lab-mariadb` pod in ns `slides` with an explicit allowlist of PEERS
(`podSelector`s for `app: slidedeck` and `app.kubernetes.io/name: lab-adminer`
— no `namespaceSelector`, so only same-namespace `slides` pods matching those
labels could reach it). This chart's own `namespace-bootstrap.yaml` adds the
EGRESS side from every `lab-<slug>` namespace to `slides:3306` — but per that
netpol file's OWN header comment ("a peer's egress allowance alone does not
admit traffic once the receiver is policy-covered"), egress-only is not
enough: `lab-mariadb` already declares `policyTypes: [Ingress, ...]`, so it is
policy-covered, and without a matching INGRESS rule naming lab pods as an
allowed peer, every hosted lab app's DB connection would be dropped — the
platform would ship an ExternalSecret with valid credentials pointed at a
database the app's own pod is network-denied from ever reaching.

**Fix** (included in this PR, `platform-services/lab-db/netpol.yaml`): added a
`namespaceSelector: {matchLabels: {platform.capstone/component: lab}}` peer to
`lab-mariadb`'s `ingress[].from` list. Every `lab-<slug>` namespace this
chart's `namespace-bootstrap.yaml` creates carries that exact label
(`chart/templates/_helpers.tpl`'s `lab-app.labels`), so this ONE edit admits
traffic from every current AND future lab namespace on 3306 — no per-lab netpol
edit needed as labs come and go.

**Verification** (server-side dry-run + live label-match evidence, see the PR
thread for the raw command output — summarized here):
- `kubectl --dry-run=server -f platform-services/lab-db/netpol.yaml` → all
  three NetworkPolicy objects in that file apply cleanly as `configured`
  (modifications to the live, already-applied objects), zero schema errors.
- Live `lab-mariadb` NetworkPolicy BEFORE this fix (read via
  `kubectl -n slides get networkpolicy lab-mariadb -o yaml`) shows exactly the
  two `podSelector` peers described above and NO `namespaceSelector` — matches
  what the fix needed to add.
- `chart/templates/namespace-bootstrap.yaml` rendered
  (`helm template ... --set namespaceBootstrap=true --set labSlug=lab1`) shows
  the `Namespace` object carrying `platform.capstone/component: lab` in its
  `labels:` block — the EXACT key/value the new `namespaceSelector.matchLabels`
  targets. Label-selector matching is a plain equality check on this
  key/value pair; both sides now agree on it byte-for-byte.
- The `lab-mariadb-0` pod is live and Running in ns `slides` today (confirmed
  read-only), so the fix is landing against the real, currently-reachable
  target, not a hypothetical.

## Resource governance (adversarial review M-1, M-2, M-3)

- **M-1 — quota headroom**: the Deployment's container limits are hard-coded
  `500m`/`512Mi`. 15 students × that = 7.5 CPU / 7.5Gi. The first draft's
  `limits.cpu: "6"` / `limits.memory: 6Gi` ResourceQuota would have silently
  quota-blocked student #13+ (visible only in ReplicaSet events, not on the
  Application). Raised to `10`/`10Gi` (`chart/values.yaml`).
- **M-2 — no intra-namespace traffic**: the original NetworkPolicies allowed
  unrestricted pod-to-pod traffic within a `lab-<slug>` namespace
  (`podSelector: {}` both directions), copied from the tenant model where one
  namespace = one TRUSTED team. Here one namespace = up to 15 MUTUALLY
  UNTRUSTED students sharing nothing (one Deployment/Service each, no
  sidecars). Removed both intra-namespace allow rules —
  `chart/templates/namespace-bootstrap.yaml` now permits only Traefik/
  cloudflared ingress and DNS+lab-mariadb egress.
- **M-3 — no default-SA sharing**: every other app template in this platform
  gives its workload a dedicated ServiceAccount with
  `automountServiceAccountToken: false`; the lab chart was the odd one out on
  exactly the LEAST-trusted workload here (arbitrary student-authored code,
  publicly reachable). Fixed — `chart/templates/serviceaccount.yaml` +
  `deployment.yaml`'s `serviceAccountName`/`automountServiceAccountToken: false`.

## Teardown

- **A student leaves / lab closes to new students**: slides removes their row
  from `students.yaml` (and may delete their `tags/<username>.yaml`) → the
  merge generator drops that element → ArgoCD prunes that ONE Application
  (Deployment/Service/Ingress/ExternalSecret gone; the shared namespace and its
  siblings are untouched).
- **End of term**: delete the WHOLE lab —
  ```bash
  git rm labs/<lab-slug>/lab.yaml labs/<lab-slug>/students.yaml \
    && git rm -r labs/<lab-slug>/tags && git commit -m "teardown: <lab-slug>" && git push
  # labs-students / labs-namespace ApplicationSets prune every generated
  # Application for that lab (automated: {prune: true}) — including the
  # Namespace itself (owned by the labs-namespace Application).
  ```
  `platform-services/cohort-gc/` was evaluated and does NOT fit: it is built
  around the per-team `platform.capstone/{team,semester,env}` label triple and
  Crossplane `CapstoneTenant` claim lifecycle — labs are a single flat
  `lab-<slug>` namespace with no semester/env axis. Forcing it in would be more
  code than the two `git rm`s above; not done.

## Known gap found during verification: `verify-image-signature` (cosign)

Server-side dry-run against the live cluster (`kubectl --dry-run=server`) surfaced
a THIRD Kyverno policy beyond the two accounted for in the brief:
`verify-image-signature` (cosign keyless), which — like `disallow-latest-tag` and
`require-limits` — applies to every namespace not in its exclude list, and
`lab-*` is not in it (correctly not, by the same reasoning as the other two).
`lab-build.yaml` does **not** cosign-sign the images it pushes (unlike
`tenant-build.yaml`'s `supply-chain-verify` composite action) — switching the
registry to GHCR (adversarial review B-2) does not change this. Today this is
**harmless**: the policy's `validationFailureAction` is currently `Audit`
platform-wide (report-only — confirmed live: a dry-run returned a `Warning`,
not a blocking error) while tenant images get signed cosign coverage proven
out. **But it is documented as temporary** (`verify-image-signature.yaml`'s own
header: "until tenant images are actually verified cosign-signed... flip back
to Enforce"). If/when that flip happens, every lab pod would start failing
admission the moment `lab-build.yaml` pushes an unsigned image. Not fixed in
this PR (adding cosign signing to a "thin" reusable workflow was out of scope
for this pass) — flagged here so the eventual Enforce flip either (a) adds
cosign signing to `lab-build.yaml` first, or (b) makes a deliberate, reviewed
decision to keep `lab-*` excluded from that specific policy (unlike the other
two, which correctly stay unexcluded).

## Backlog (noted, not fixed — opportunistic/non-blocking per review)

- Harbor immutable-tag rule: moot now that Harbor isn't used for lab images at all (B-2).
- An ADR for this design was not written (v1 lab-hosting predates this repo's ADR-numbered decisions; could be retrofitted).
- Further expression-injection hardening review of `lab-build.yaml` beyond the `env:`-passthrough fix already applied (L-1/L-2) — the pattern is now consistent throughout the file, but a dedicated actionlint/zizmor pass was not run.
- Doc cross-links from `docs/operator/harbor.md` etc. noting labs no longer touch Harbor — not added; this README + the PR description are the source of truth for now.

## Local verification

```bash
helm lint platform-services/lab-hosting/chart
helm template t platform-services/lab-hosting/chart --set namespaceBootstrap=true --set labSlug=lab1
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=jsmith --set tag=abc123d
# fail-guards (should each error loudly, scoped to this one render):
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=JSmith        # C-1: not lowercase
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=jsmith --set tag=not-hex  # B-4: bad tag
```

---

## OPERATOR ACTIONS REQUIRED BEFORE THIS WORKS END-TO-END

In order. None of these were performed by this PR — cluster/external-API writes
are classifier-gated for agents; read-only verification only
(`/usr/bin/kubectl --kubeconfig /tmp/kc-n2`).

1. **Create the fleet repo** (see "Repo-list contract" above):
   `gh repo create UA-MIS/capstone-labs-fleet --private ...` — verify no name
   collision first (`gh repo view UA-MIS/capstone-labs-fleet` should 404 before
   creating).
2. **Verify ArgoCD can read the new private repo.** The two `labs-*-appset.yaml`
   generators point at it; this platform already has a GitHub App repo
   credential (`argocd-repo-creds-uamis`, `platform-services/argocd-config/
   sealedsecret-repo-creds.yaml`) used for org-wide reads (cohort-gc's PR
   listing across every tenant repo). It should cover the new repo with zero
   extra config IF its registered `url` is an org-level prefix
   (`https://github.com/UA-MIS`) — **verify** with
   `argocd repo list` / a test sync once the repo exists and the first
   `lab.yaml` is committed; if it 404s/permission-denied, register the new repo
   explicitly the same way `sealedsecret-repo-creds.yaml` does. Note this repo
   is NOT added to the `platform` AppProject `sourceRepos`
   (`bootstrap/platform-appproject.yaml`) and does not need to be — ApplicationSet
   generator reads are a repo-server read operation, gated by repo credentials,
   not by an Application's `spec.source.repoURL` (which stays `platform-infra`
   for every generated Application here; `sourceRepos` governs THAT field only).
3. **Merging this PR to `main` IS the deploy — no manual `kubectl apply`
   needed or possible** (correction — an earlier draft of this README said to
   `kubectl apply` the two new ApplicationSets manually; that was wrong).
   `bootstrap/root-app.yaml` recurses `applicationsets/` with
   `automated: {prune: true, selfHeal: true}`, so ArgoCD picks up
   `labs-namespace-appset.yaml`/`labs-students-appset.yaml` automatically on
   merge, per this platform's own golden rule ("you do not `kubectl apply` to
   change the platform" — `docs/operator/README.md`). **Sequencing matters**:
   do step 1 (create the fleet repo) BEFORE or immediately after merging —
   until it exists and is readable, both new ApplicationSets' git generators
   show `ErrorOccurred` (harmless — they just generate zero Applications — but
   noisy in the ArgoCD UI until the repo exists).
4. **GHCR — mint the shared pull credential** (adversarial review B-2 —
   replaces the old Harbor pull-robot-per-lab flow entirely): generate ONE
   fine-grained PAT (or a machine-user classic PAT), `read:packages` scope,
   able to read the `ua-mis/*` package namespace. Reseal the SAME value into
   every `lab-<slug>` namespace as it's created:
   ```bash
   kubectl create secret docker-registry labs-pull \
     --docker-server=ghcr.io \
     --docker-username=<a GitHub username/bot with read:packages> \
     --docker-password=<the PAT> \
     -n lab-lab1 --dry-run=client -o yaml \
     | kubeseal --controller-namespace kube-system \
         --controller-name sealed-secrets-controller \
         --namespace lab-lab1 --format yaml \
     > platform-services/lab-hosting/sealedsecret-pull-lab1.yaml
   # commit that file; repeat --namespace lab-<slug> per new lab, same PAT value.
   ```
   (No in-cluster Job/API mint step needed — unlike a Harbor robot, GHCR PAT
   creation has no per-project uniqueness constraint, so the same secret value
   reseals cleanly into every lab namespace.)
5. **GHCR — no push-side secret needed.** Each student repo's CI uses its own
   automatic `GITHUB_TOKEN` (with `permissions: packages: write` — declared in
   both the reusable workflow and the caller, see `.github/workflows/
   lab-build.yaml`'s header). Nothing to mint or store for this side at all.
6. **Vault — read side**: run
   `platform-services/external-secrets/vault-policies/labs-read-role.sh` inside
   `vault-0` (see its header for the exact `kubectl exec` invocation).
7. **Vault — write side**: run
   `platform-services/external-secrets/vault-policies/slides-labs-writer-role.sh`
   inside `vault-0`. This alone does NOT let slides write yet — the slidedeck
   Deployment also needs the projected `serviceAccountToken` (audience `vault`)
   + SA `slides-vault-writer` wiring; that's a slidedeck-repo change, tracked
   there, not in this PR.
8. **Set `LAB_FLEET_TOKEN`** as an org secret (`gh secret set LAB_FLEET_TOKEN
   --org UA-MIS --visibility selected --repos <fleet repo + each lab template
   repo>`) — a fine-grained PAT, Contents:read/write on
   `UA-MIS/capstone-labs-fleet` ONLY. See "Security hardening" above for the
   residual-trust note on this token's scope.
9. **DNS — the one-time wildcard route.** ~~Pending~~ **DONE** (per the
   coordinator's live confirmation): the operator already added ONE Cloudflare
   Tunnel Public Hostname route for `*.uamishub.com` (HTTP, empty path, origin
   `traefik.kube-system.svc.cluster.local:80`). This IS a tunnel *routing
   config* change (the dashboard-managed Public Hostname list) — corrected
   wording from an earlier draft of this README/`ingress.yaml`, which
   inaccurately implied "no tunnel config change at all"; what's still true is
   that cloudflared's own process-level ingress config stays a single
   catch-all (`ingressRule=0`, verified live on both replicas) — a wildcard
   Public Hostname still resolves to that one rule, so no PER-LAB or
   PER-STUDENT Cloudflare change is ever needed going forward. `*.uamishub.com`
   was chosen over `*.labs.uamishub.com` for zero incremental TLS cost (free
   Universal SSL already covers a single-label wildcard on the zone apex) —
   see "Judgment calls" below.

### Judgment calls made without being able to verify live (flagged, not hidden)

- **`*.uamishub.com` vs `*.labs.uamishub.com`** for the one-time wildcard —
  the former was used (zero incremental TLS cost); a reasonable alternative
  for tighter zone-scoping, not taken.
- **Pull-credential landing spot** (step 4) — a committed SealedSecret per lab
  namespace under `platform-services/lab-hosting/`, applied via a small
  platform-infra PR per new lab. Simpler than the Harbor-robot-Job approach
  the first draft used (no per-project uniqueness constraint to work around),
  but still means "onboard a new hosted lab" costs one small platform-infra PR
  for this ONE piece (namespace bootstrap + student apps need zero
  platform-infra involvement per lab; only this pull-credential step does).
- **Container port = 8080, fixed** rather than adding a `port` field to the
  roster schema — mitigated by injecting `PORT=8080` (L-3), which covers most
  frameworks; a template whose framework ignores `$PORT` still needs its own
  adjustment.
- **ArgoCD repo-credential coverage for the new fleet repo** (operator step 2)
  — inferred from `argocd-repo-creds-uamis`'s existing org-wide usage
  (cohort-gc), not independently verified (its `url` field is SealedSecret-
  encrypted; decrypting it is a cluster-admin action outside this PR's scope).
  Marked as an explicit operator verification step, not assumed to just work.
