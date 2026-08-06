# lab-hosting — public per-student app hosting for slidedeck's "labs" feature

Hosts a `hosted` lab's student apps at `<lab-slug>-<username>.uamishub.com`,
public, no SSO gate. A DELIBERATELY separate, much lighter mechanism from the
capstone tenant model (Backstage wizard → Crossplane XR → per-team namespaces,
promotion ladder, per-team Harbor/Vault) — ~15 students, no org GitHub identity,
no promotion model. See `RUNBOOK-DEPLOY.md` in `UA-MIS/slidedeck` for the full
lab-feature context this builds on (`hosted` flag, `labAppUrl()`,
`labRepoName()`, the existing per-student lab-mariadb + Adminer console).

> **This README has been revised three times after adversarial review of PR
> #426.** Round 1 found case-sensitivity in the merge generator, a missing
> NetworkPolicy rule, a Cloudflare body-size cap on Harbor pushes, an
> identity-spoofing gap, and unvalidated/unquoted template interpolation
> (tagged `B-*`/`C-*`/`M-*` below). Round 2 found a `hosted`-without-
> `with_database` breakage, a genuine privilege-escalation hole in the
> round-1 CI-writes-its-own-tag fix, and a pull-secret that landed nowhere
> anything would sync it (tagged `H-*`/`M-*` below). **Round 3 found the
> round-2 tag-sync workflow had a real bash syntax error — an indented
> heredoc delimiter — that made it silently a no-op since the moment it was
> introduced** (caught by executing it, not by reading it; see "Image tag
> propagation" and "Local verification"), plus a second-order breakage where
> removing round-2's now-unnecessary identity check also silently removed
> the thing keeping the chart's image-ref DERIVATION in sync with what CI
> actually pushed. Every section reflects the FIXED design as of round 3;
> where something changed materially, it says so inline with the finding ID.
> Finding IDs (`B-`/`C-`/`H-`/`M-`/`L-` + a number) are **not globally
> unique across rounds** — each review pass numbered its own findings from
> scratch, so e.g. "M-1" means a different thing in three different sections
> of this document. Kept as originally numbered (not renumbered) so every ID
> stays traceable back to the actual review comment it came from; each
> occurrence below says which fix it is in the surrounding prose.

This directory is EXCLUDED from the generic `platform-services` directory
ApplicationSet (see the exclude entry + comment in
`applicationsets/platform-services-appset.yaml`) — nothing here auto-syncs as a
standalone Application. It is consumed two ways instead:

- `chart/` — a Helm chart, rendered per-element by the two dedicated
  ApplicationSets below (`applicationsets/labs-namespace-appset.yaml`,
  `applicationsets/labs-students-appset.yaml`).
- `../external-secrets/vault-policies/labs-*.sh` — operator-run scripts, never
  auto-applied (same shape as `platform-services/harbor-onboarding/`).
- `.github/workflows/lab-build.yaml` (student-repo reusable CI) and
  `.github/workflows/lab-tag-sync.yaml` (platform-infra-only scheduled sync —
  see "Image tag propagation" / H-2) — both live in this repo's `.github/`,
  not under this directory, but are part of the same design.

---

## Design at a glance

```
UA-MIS/capstone-labs-fleet (NEW, private, small)
  labs/<lab-slug>/lab.yaml              {labSlug, withDatabase}          — slides writes once, lab opens hosted
  labs/<lab-slug>/students.yaml         [{username, repo, labSlug,
                                           withDatabase}, ...]           — slides writes (roster)
  labs/<lab-slug>/tags/<username>.yaml  {username, labSlug, tag}        — lab-tag-sync.yaml writes (H-2)

        │ git files generator (lab.yaml)      │ merge generator (students.yaml ⋈ tags/*.yaml)
        ▼                                     ▼
applicationsets/labs-namespace-appset.yaml   applicationsets/labs-students-appset.yaml
  1 Application per LAB                        1 Application per STUDENT
  → chart/ (namespaceBootstrap: true)          → chart/ (studentApp: true)
  → Namespace lab-<slug>, ResourceQuota,        → ServiceAccount, Deployment, Service,
    LimitRange, baseline NetworkPolicies          Ingress, ExternalSecret (only if
    (+ slides:3306 egress only if                  withDatabase) — all in ns lab-<slug>
    withDatabase, H-1)

student's own repo:
  .github/workflows/*.yml (thin caller) --uses--> platform-infra's
    .github/workflows/lab-build.yaml (build + push to GHCR, own GITHUB_TOKEN,
    NO fleet-repo write, NO shared secret — H-2)

platform-infra (students CANNOT modify):
  .github/workflows/lab-tag-sync.yaml (scheduled, every 5min) — polls each
    roster row's repo HEAD via API, writes labs/<slug>/tags/<user>.yaml —
    the ONLY writer to tags/*, closing H-2
```

A student's app becomes reachable the moment THREE independent things are all
true: (1) slides has registered them in `students.yaml`, (2) `lab-tag-sync.yaml`
has polled at least once since their first push (`tags/<username>.yaml`
exists), (3) the lab's namespace bootstrap has synced. Missing (2) alone is not
a failure state — the Application still exists and Syncs, the Pod just sits
`ImagePullBackOff` on the `:unreleased` placeholder tag until the next
successful poll (see `chart/templates/_helpers.tpl` `lab-app.imageTag`).

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
PR — the whole point of the fleet-repo split is that slides commits
registration data to a small, separate repo with zero platform-infra
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
  --description "Lab-hosting fleet data: per-lab roster + per-student build tags. Written by slidedeck + lab-tag-sync.yaml; read by platform-infra's labs-*-appset ApplicationSets."
```

Three file shapes, all under `labs/<lab-slug>/`:

**`labs/<lab-slug>/lab.yaml`** — single OBJECT (not a list). Written ONCE by
slides when a lab is flagged `hosted`, deleted (or left — see Teardown) when the
lab tears down.

```yaml
labSlug: "lab1"
withDatabase: false
```

| field | required | meaning |
| --- | --- | --- |
| `labSlug` | yes, **already lowercase** | See "Contract: lowercase everywhere". |
| `withDatabase` | yes | The lab's `with_database` flag (adversarial review H-1 — see "Contract: withDatabase" below). NOT the same as `hosted` — slidedeck's `labs.hosted` and `labs.with_database` are independent columns. |

**`labs/<lab-slug>/students.yaml`** — a LIST. Written/maintained by slides ONLY
(add a row on registration+repo-provision, remove a row on teardown/unregister).
ArgoCD's git files generator explodes a matched list file into one generator
output PER ELEMENT — this is what makes ONE Application per student happen.

```yaml
- username: "jsmith"
  repo: "UA-MIS/lab1-jsmith"
  labSlug: "lab1"
  withDatabase: false
```

| field | required | meaning |
| --- | --- | --- |
| `username` | yes, **already lowercase** | GitHub username, as scaffolded, LOWERCASED by slides before writing (see "Contract: lowercase everywhere" — this is not optional). |
| `repo` | yes | `org/name` of the student's repo, exactly as `github.repository` reads inside the student's CI run (== `labRepoName()` == `<labSlug>-<username>`, by convention — but no longer relied on: see below). **LOAD-BEARING (adversarial review round-3 M-1)**: the chart derives the GHCR pull ref FROM THIS FIELD (`ghcr.io/<lowercased repo>:<tag>`), not by reconstructing `labSlug`+`username`. Must match `^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$` or that student's Application fails its Helm render (a loud, per-Application failure). If it's well-formed but doesn't match the repo the student's CI actually pushed from, there is no render-time signal at all — the pod just sits `ImagePullBackOff` forever, silently pointed at a ref nothing ever pushed. **If a student's repo is ever renamed, slides must update this field** — nothing else will catch a stale value. **MUST also be `≤ 63` total chars combined with username — see "Contract: the 63-char cap must be enforced by slides BEFORE repo creation" (M-3).** |
| `labSlug` | yes, **already lowercase** | Must exactly equal the `lab.yaml` in the same directory. Present on every row (not inferred from the file path) so the merge generator's `mergeKeys` always has it, regardless of how a given ArgoCD version injects file-path metadata. |
| `withDatabase` | yes | **Duplicated** from `lab.yaml` — see "Contract: withDatabase" for why this can't just be read from `lab.yaml` by this ApplicationSet, and why the duplication is low-risk. |

**`labs/<lab-slug>/tags/<username>.yaml`** — single OBJECT. Written ONLY by
`.github/workflows/lab-tag-sync.yaml` (platform-infra, scheduled — adversarial
review H-2). Slides never writes this file. Absent until the first poll after
the student's first successful push.

```yaml
username: "jsmith"
labSlug: "lab1"
tag: "a1b2c3d4e5f6"
```

`tag` is the 12-char short commit SHA of the student's default-branch HEAD at
last poll. Kept in a file separate from `students.yaml` specifically to keep
slides (roster) and the sync workflow (tag) as the only two writers to the
fleet repo, each to disjoint paths — see `applicationsets/labs-students-
appset.yaml`'s header for the full rationale.

## Contract: lowercase everywhere (adversarial review C-1)

**`username` and `labSlug` MUST already be lowercase + DNS-safe
(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`) wherever slides or `lab-tag-sync.yaml`
writes them.** This is not a normalization the chart performs for you — it is
a hard requirement, enforced by `fail`-guards in `chart/templates/_helpers.tpl`
(`lab-app.username`, `lab-app.labSlug`) that ABORT the render if either isn't
already in that exact form.

**Why this matters more than it looks**: `applicationsets/labs-students-
appset.yaml`'s `merge` generator joins `students.yaml` (slides-written) against
`tags/<username>.yaml` (`lab-tag-sync.yaml`-written, already lowercased) on
`mergeKeys: [username, labSlug]` — an EXACT STRING match, case-sensitive. An
early draft "fixed" this by silently lowercasing `username` with Helm's
`| lower` filter — which does nothing for the actual bug: the merge generator
compares the RAW fleet-repo values BEFORE Helm ever runs, so a `students.yaml`
row written as `JSmith` would simply never join with a tag file written as
`jsmith`, permanently pinning that student on the `:unreleased` placeholder
with **no error anywhere** — ArgoCD shows a normal, Synced, Healthy
Application; only the image tag is silently wrong forever. The fail-guards fix
this by rejecting a not-already-lowercase value outright: if slides ever writes
mixed-case data, the Application for that ONE student goes visibly Degraded (a
clear `fail` message naming the exact field and value) instead of silently
never updating.

**This also affects the Vault path.** `chart/templates/externalsecret.yaml`
builds the read path from the SAME validated (lowercased) `labSlug`/`username`
— so the path slides writes credentials to must ALSO be the lowercased form,
never the as-scaffolded-case GitHub username. See "Vault" below.

### Contract: quote every string scalar in `lab.yaml`/`students.yaml` (adversarial review round-4 — MEASURED, not theoretical)

There are TWO different YAML parsers in this pipeline, and they resolve an
UNQUOTED YAML-1.1 boolean/octal-looking word differently. `lab-tag-sync.yaml`
uses `yq` (go-yaml v3 under the hood); ArgoCD's git-files generator uses
`sigs.k8s.io/yaml`, which is strict YAML 1.1. Measured side by side on the
same unquoted input:

```
input:            yq resolves it to:      sigs.k8s.io/yaml resolves it to:
username: no      "no" (string)           false (bool)
username: 0755    "0755" (string)         493 (int, octal)
```

If slides writes an UNQUOTED `username: no` in `students.yaml`, ArgoCD's
generator hands the ApplicationSet template the boolean `false`, which
stringifies to `"false"` in `valuesObject.username` — a value that IS itself
a valid lowercase DNS label, so `lab-app.username`'s fail-guard (previous
section) does **not** catch it; the render succeeds, but as
`lab-lab1-false` / `lab1-false.uamishub.com`. Meanwhile `lab-tag-sync.yaml`
resolves the SAME unquoted `no` via `yq` as the literal string `"no"`, and
writes `username: "no"` (quoted, correctly) into that student's tag file. The
merge generator then joins on `[username, labSlug]` comparing `"false"`
against `"no"` — they never match, and that student is silently pinned on
`:unreleased` forever, same failure shape as the case-sensitivity bug earlier
in this section, just triggered by an unquoted boolean-looking word instead
of mixed case. The same class of bug applies to `on`/`off`/`yes`/`y`/`n` and
to any all-digit username YAML would read as a number.

**Contract requirement: every STRING scalar in `lab.yaml` and
`students.yaml` MUST be quoted** — `labSlug`, `username`, `repo`, and any
future string field. The `withDatabase` field is the one exception: it is a
REAL boolean and must stay unquoted (see `chart/templates/_helpers.tpl`'s
"withDatabase gating" comment for why the chart itself normalizes it via
`toString` rather than trusting either parser's native type). This repo's own
`labs/<lab-slug>/tags/<username>.yaml` examples already show this correctly
quoted — the `lab.yaml`/`students.yaml` examples above have been updated to
match.

## Contract: required + validated fields (adversarial review C-2)

Every field in every fleet-repo row is REQUIRED — a missing field is not
tolerated silently. Two layers enforce this without letting one bad row take
down the whole fleet:

1. **`applicationsets/labs-*-appset.yaml`** never reference a field raw
   (`{{.username}}`) — every reference is `hasKey`-guarded
   (`{{ if hasKey . "username" }}{{.username}}{{ end }}`), so a missing field
   renders as an empty string instead of aborting ArgoCD's own
   `missingkey=error` template render for the WHOLE ApplicationSet (the
   original bug: a single malformed row could have stopped every OTHER lab's
   Applications from generating/updating too).
2. **`chart/templates/_helpers.tpl`** then validates format (lowercase+DNS-safe
   for `labSlug`/`username`, `^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$`
   for `repo` — see `lab-app.repo`, adversarial review round-3 M-1 — and
   `^[a-f0-9]{7,64}$` for `tag`) and REQUIREDNESS (empty fails the same regex
   check) — `fail`-ing there aborts only that ONE Application's Helm render,
   which surfaces as that one Application going Degraded, not a fleet-wide
   outage.
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
something a platform-infra manifest change can close. **After the H-2 fix,
this risk is now bounded to slides' own bugs and `lab-tag-sync.yaml`'s own
bugs only** (no student-controlled writer can create a duplicate anymore).
Recommend the operator alert on the `labs-students` ApplicationSet's own
error/degraded conditions
(`kubectl -n argocd get applicationset labs-students -o jsonpath='{.status.conditions}'`)
if catching this proactively matters.

## Contract: the 63-char cap must be enforced by slides BEFORE repo creation (adversarial review M-3)

`chart/templates/_helpers.tpl`'s `lab-app.appName` fail-guard catches an
over-length `<labSlug>-<username>` combination — but only AFTER the repo
already exists: slidedeck's `labRepoName()` truncates at 90 characters when
naming the GitHub repo
(`` `${lab.slug}-${githubUsername}`.slice(0, 90) ``), which is well past this
chart's 63-char cap. A `(labSlug, username)` pair between 64 and 90 characters
combined therefore yields a WORKING, successfully-created student repo whose
lab-hosting Application is then PERMANENTLY Degraded (the fail-guard fires on
every single render forever — there is no shorter name to fall back to once
the repo is named). **Slides must check `labSlug.length + 1 + username.length
<= 63` BEFORE calling the repo-generate API**, not rely on this chart to catch
it after the fact — this chart's guard is a correctness backstop, not a
substitute for validating at the point where the mistake is still cheap to
refuse.

## Contract: withDatabase (adversarial review H-1 — NEW)

**`hosted` and `with_database` are INDEPENDENT columns in slidedeck**
(`server/db.js:56-57`; `server/scaffold.js`'s own comment: "Stack and database
are ORTHOGONAL"; `deriveLabFlags()` returns them as two separate booleans). An
earlier draft of this chart rendered `chart/templates/externalsecret.yaml` and
`deployment.yaml`'s `envFrom` unconditionally — so a `hosted: true,
with_database: false` lab (slides never writes a Vault path for it, by design)
would have every student pod sit in `CreateContainerConfigError` forever,
waiting on a k8s Secret an ExternalSecret can never materialize because
nothing will ever populate the Vault path it's pointed at.

**Fixed**: `withDatabase` gates THREE things, all via the identical inline
check `{{- if eq (toString .Values.withDatabase) "true" }}` (see
`chart/templates/_helpers.tpl`'s "withDatabase gating" comment for why this is
NOT a reusable `{{- define }}` helper — a Helm/Go-template footgun where any
non-empty string, including the literal text "false", is truthy):

1. `chart/templates/externalsecret.yaml` — the whole file, gated alongside
   `.Values.studentApp`.
2. `chart/templates/deployment.yaml` — the `envFrom` block only (the rest of
   the Deployment always renders).
3. `chart/templates/namespace-bootstrap.yaml` — the `slides:3306` egress
   `NetworkPolicy` rule only (DNS egress always renders).

**Why `withDatabase` is DUPLICATED onto every `students.yaml` row** instead of
living only in `lab.yaml`: `namespaceBootstrap` mode (gate #3) has a direct
path to `lab.yaml`'s data (its OWN ApplicationSet's generator reads that file
directly), but `studentApp` mode (gates #1 and #2) does not — the
`labs-students` ApplicationSet's `merge` generator is keyed on
`[username, labSlug]`, and `lab.yaml` carries neither of those keys, so there
is no way for that generator to join in `lab.yaml`'s data without changing the
merge key shape (which would break the EXISTING roster⋈tag merge — see
`applicationsets/labs-students-appset.yaml`'s header). A nested `matrix`
generator combining a per-lab source with the existing per-student `merge`
could in principle thread this through without duplication, but that shape
could not be verified against a live ArgoCD controller from this environment
(schema-valid via `--dry-run=server` says nothing about generator RUNTIME
behavior, unlike the `merge` generator's left-join semantics, which round 1's
review independently verified as correct) — duplication was chosen as the
lower-risk, provably-correct option. Both copies are written by slides at the
SAME time (lab creation), from the SAME source fact, and neither ever changes
after that — low drift risk in practice, unlike the tag/roster split, which
genuinely needed separation because those two values change on different,
overlapping schedules from different writers.

**Advisory — the residual drift risk this duplication leaves open
(adversarial review round-3 M-2, logged rather than fixed):** nothing
enforces that `lab.yaml`'s `withDatabase` and every `students.yaml` row's
copy actually agree. If slides' own write logic ever lets them drift (e.g.
`lab.yaml: withDatabase: false` but a row still carries `withDatabase: true`,
or vice versa), the two gates land INDEPENDENTLY and can disagree at runtime:
a row saying `true` gets the ExternalSecret + `envFrom` (DB creds injected
into the pod env) while `lab.yaml` saying `false` means the SHARED
`lab-<slug>` namespace never got the `slides:3306` egress rule — the student
sees `DATABASE_URL` etc. set in their env, but every connection attempt times
out with no NetworkPolicy-level error visible anywhere (a silent, confusing
runtime failure, not a Kyverno/Helm-fail-guard-catchable one, since both
values are individually well-formed booleans). **This is a slides-side
contract requirement, not something this chart can guard**: slides MUST
write `lab.yaml`'s `withDatabase` and every row's copy in the SAME
transaction/code path, from the SAME source value, every time a lab is
created or a student is added. Not fixed with a chart-side `fail` guard in
this PR — closing it chart-side would require exactly the same
merge-generator reach-into-`lab.yaml`-from-`studentApp`-mode problem this
section's duplication already exists to avoid (see above), so a real fix
would have to happen on the slides side, or via the `matrix`-generator
alternative already flagged as unverified from this environment.

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

## Container security context vs. lab template images (adversarial review M-5 — KNOWN LIMITATION)

The Deployment forces `runAsUser: 65532` at the pod level (`chart/templates/
deployment.yaml`), which OVERRIDES whatever `USER` a lab template's own
Dockerfile sets. **Verified concretely against slidedeck's generated Next.js
starter**: its Dockerfile sets `USER node` (uid 1000) with `/app` owned by
that uid; forcing uid 65532 means `next start` writing its `.next/cache`
directory hits `EACCES` (the directory is owned by uid 1000, not 65532) — the
Next.js hosted-lab template is broken out of the box against this chart as
shipped. The Spring Boot starter is unaffected (its image runs as root by
default, so uid 65532 doesn't collide with anything the JVM needs to write).
**Not fixed in this PR** — a per-template `runAsUser` override would need a
value threaded through the fleet contract for every stack, which this PR
deliberately avoids (see "Container port convention" for the same tradeoff
made the same way). The Next.js hosted-lab template's Dockerfile MUST either
`chown` its working directory to `65532` or provide a writable `.next/cache`
location the image can use regardless of uid — flagged prominently here so
this is caught before a professor's first Next.js hosted lab, not during it.

## Image tag propagation (adversarial review H-2 — CHANGED from round 1)

**Round 1 had each student's own CI (`lab-build.yaml`) write its own tag file
directly into `capstone-labs-fleet`, using an org-shared `LAB_FLEET_TOKEN`
secret present in every student repo's job environment.** Round-1 review
caught that this token was shared and gated the write with an identity check
(B-3); round-2 review found that gate insufficient: a student has push access
to their OWN repo (`scaffold.js:81-84`), so they could author ANY workflow in
`.github/workflows/` in their own repo that reads `secrets.LAB_FLEET_TOKEN`
directly and does whatever it wants with the raw token — B-3's identity check
only constrained what `lab-build.yaml`'s OWN git commands did with the token;
it did nothing to stop a student from bypassing `lab-build.yaml` entirely.
With the raw token, a student could pin any peer to an old/nonexistent tag
(DoS), read the private roster, corrupt `students.yaml`, or — worst —
`git rm labs/<slug>/`, which with `prune: true` on both `labs-*-appset.yaml`
ApplicationSets would DESTROY that lab's entire Namespace and every student's
app.

**Fixed by removing the shared secret from student repos entirely, not by
tightening the check further** (tightening cannot close a "student can write
their own script" hole — any check lives in code the student can route
around). `.github/workflows/lab-build.yaml` now does ONLY the one thing that
is safe to let student-authored CI do: build + push ITS OWN repo's image to
ITS OWN GHCR package, using the workflow run's automatic, repo-scoped
`GITHUB_TOKEN` (which cannot reach any other repo's package or any other
resource). It takes no inputs and needs no secrets at all — see that file's
header. Tag-writing moved to `.github/workflows/lab-tag-sync.yaml`, a
SCHEDULED workflow (every 5 minutes, `on: schedule` + `workflow_dispatch`)
that lives ONLY in `platform-infra`, which students have no access to at all.
It reads the (slides-owned, trusted) roster, asks the GitHub API for each
student repo's default-branch HEAD commit, and writes/updates
`labs/<slug>/tags/<username>.yaml` itself, batching every change from one poll
into a single commit. **Latency is fine**: the `labs-students` ApplicationSet's
git generators already requeue on ArgoCD's own ~3 minute default polling
interval, so a 5-minute sync cadence is not the bottleneck.

**This closes the round-2 findings completely, not partially**: with no
credential of any kind in a student repo's environment that can reach
`capstone-labs-fleet`, a student cannot write another student's tag file,
cannot corrupt `students.yaml` (read-only to them — they have no token that
can write it at all), and cannot `git rm` a lab directory. The two credentials
`lab-tag-sync.yaml` uses (`LAB_ROSTER_READ_TOKEN`, `LAB_FLEET_WRITE_TOKEN` —
see "OPERATOR ACTIONS") live ONLY as platform-infra repository/organization
secrets, which GitHub Actions never exposes to a DIFFERENT repository's
workflow runs (including student repos) under any circumstance — there is no
`secrets: inherit` or equivalent that could leak them there, because
`lab-tag-sync.yaml` is not a reusable workflow a student repo calls; it is a
scheduled workflow that only ever runs in the context of `platform-infra`
itself.

**Never falls back to `:latest`** — Kyverno's `disallow-latest-tag`
ClusterPolicy is `Enforce` cluster-wide and `lab-*` namespaces are not in its
exclude list (correctly — they shouldn't be); a student with no tag yet gets
`:unreleased` (a real, non-`latest`, guaranteed-nonexistent tag — Kyverno
admits the Pod, it just sits `ImagePullBackOff`). `tag` is also STRICTLY
VALIDATED against `^[a-f0-9]{7,64}$` before it is ever interpolated into a
manifest (adversarial review B-4 — see "Security hardening" below), AND every
field `lab-tag-sync.yaml` writes into a tag file is explicitly quoted
(adversarial review M-4 — see that workflow's own comment: an unquoted
all-digit 12-char short SHA, ~1.4% of builds by birthday-paradox arithmetic on
hex digits, parses as a YAML/JSON NUMBER once ArgoCD's git generator converts
it, which the chart's own hex-format fail-guard then correctly — but
confusingly — rejects; quoting removes the whole class of coercion bug,
including the same risk for a username/labSlug that happens to be a YAML 1.1
boolean word like `on`/`no`/`yes`/`off`).

**Round-3 review found the mechanism that writes those quoted fields had
never actually worked, at all, since it was introduced (adversarial review
round-3 H-1, CRITICAL).** The tag-file write used a `cat > "$TAG_FILE" <<EOF
... EOF` heredoc, indented to match the surrounding nested `for`/`while` loop
for readability — but a heredoc delimiter must sit at column 0; GitHub
Actions' YAML `run: |` block-scalar processing only strips the block's COMMON
leading indent, so the `EOF` delimiter still carried the loop's indentation
and was never recognized as the terminator. Verified live by extracting the
exact step via `yaml.safe_load` (the same parse Actions performs) and running
`bash -n` on it: a real syntax error, not a lint nitpick — the broken heredoc
silently swallowed the rest of the script, including both loop `done`s and
the `changed=` `GITHUB_OUTPUT` write. Because round 3 made this workflow the
SOLE writer of `tags/*.yaml` (closing H-2), this meant NO tag file was ever
written by anything, ever: every student, on every lab, would have been
permanently pinned on the chart's `:unreleased` placeholder — the H-2 fix was
only half-landed (the insecure writer was removed; the replacement could not
run). Fixed by replacing the heredoc with `printf '%s\n' ...` (sidesteps the
whole indentation-sensitive class rather than just re-indenting it correctly,
so a future edit inside this loop can't reintroduce the same bug), with the
quoting on all three fields preserved exactly. See "Local verification" below
for the execution evidence this fix was actually tested against, not just
read.

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

**Fix: push to GHCR instead.** `.github/workflows/lab-build.yaml` pushes to
`ghcr.io/<lowercased github.repository>:<tag>` using the workflow run's own
automatic `GITHUB_TOKEN` (scoped to that one repo, `packages: write`) — no
shared secret needed for the push side at all, and no Cloudflare/Harbor in the
path whatsoever.

## Image ref derivation: from `repo`, not `labSlug`+`username` (adversarial review round-3 M-1 — CHANGED from rounds 1-2)

`chart/templates/_helpers.tpl`'s `lab-app.image` used to RECONSTRUCT the pull
ref as `ghcr.io/ua-mis/<labSlug>-<username>`, on the assumption that
`lab-build.yaml` always pushes to that exact same string. That assumption was
only actually TRUE because round 2's B-3 identity-assertion check in
`lab-build.yaml` enforced it as a side effect (it refused to run at all
unless the caller's claimed `labSlug`/`username` reconstructed the repo's own
real name). Round 3 correctly removed that check — it gated nothing an
attacker couldn't already bypass once H-2 removed the shared fleet-write
secret from student repos, so keeping it added complexity with no remaining
security value. But removing it silently broke the OTHER thing it was
enforcing: with no check left, a `students.yaml` row whose `repo` field
doesn't exactly equal `<labSlug>-<username>` (a slides bug, a repo that was
renamed after creation, anything) would push a perfectly successful build to
`ghcr.io/<real repo name>`, while this chart kept deriving
`ghcr.io/ua-mis/<labSlug>-<username>` — a real image sitting in GHCR, an
`ImagePullBackOff` pod pointed at a different, non-existent ref, and nothing
anywhere surfacing the mismatch. **The failure mode had degraded from fail
loud (round 2's check) to fail silent (round 3 with no compensating fix.)**

**Fixed by deriving from `.Values.repo` instead** — the roster's own
authoritative `org/name` field (now required + format-validated by a new
`lab-app.repo` helper, same fail-loud pattern as `labSlug`/`username`/`tag`),
lowercased. `repo` is exactly what `github.repository` equals inside the
student's CI run, so this can no longer drift: the chart now points at
whatever slides ACTUALLY put in the roster, not a reconstruction that assumes
it matches. `lab-app.appName` (`labSlug`-`username`) remains authoritative
for k8s object names and the Ingress host — those still need the platform's
own naming convention regardless of what the student's repo happens to be
named — only the pull ref changed. Verified (`helm template`): a
`repo=UA-MIS/lab1-jsmith` row renders `ghcr.io/ua-mis/lab1-jsmith:<tag>`; a
deliberately NONCONFORMING `repo=UA-MIS/totally-different-repo-name` row
(mismatched with its `labSlug`/`username`) now correctly renders
`ghcr.io/ua-mis/totally-different-repo-name:<tag>` — reflecting the real
field instead of silently reconstructing the wrong one.

## Pull: GHCR packages are PUBLIC — no pull secret at all (adversarial review H-3/M-2 — CHANGED from round 1)

**Round 1 planned to reseal ONE static PAT as a `docker-registry` Secret
(`labs-pull`) into every `lab-<slug>` namespace**, and round-1's own README
even said so — but round-2 review found the plan never actually landed
anywhere GitOps would apply it (the SealedSecret's proposed path,
`platform-services/lab-hosting/`, is EXCLUDED from the `platform-services`
directory generator by this SAME PR, and the two `labs-*-appset.yaml`
ApplicationSets only ever render `chart/` — nothing in the design applied it).
Separately, round-2 review also confirmed a factual gap in the round-1 plan
(M-2): GitHub Packages authentication requires a **classic** PAT, not the
fine-grained PAT round 1 offered as the primary option, and a private package
inherits its linked repo's access — meaning a single pull identity would need
explicit read access GRANTED on every current AND future student repo, an
ever-growing list the operator would have to maintain by hand.

**Decision: make GHCR packages PUBLIC, and delete the pull-secret mechanism
entirely** rather than solve either problem. Reasoning: every hosted-lab app
is ALREADY fully public (no SSO gate, that's the whole design point of this
layer) — the running application, its behavior, and everything a professor or
anyone else can observe by visiting the URL are already unauthenticated and
world-reachable. Making the CONTAINER IMAGE that produces that same running
app also publicly pullable adds no meaningful new exposure: the image doesn't
(and must not, by ordinary Docker hygiene any public open-source project
already has to observe) contain secrets baked in — database credentials arrive
at runtime via the ExternalSecret/`envFrom`, never the image. Public GHCR
visibility does NOT affect the PUSH side at all (still gated by the
repo-scoped `GITHUB_TOKEN`, still only that repo's own CI can push to it) —
only pull/read visibility changes. This deletes `imagePullSecrets` from
`chart/templates/deployment.yaml` entirely (confirmed: `grep -i pullsecret`
against the rendered chart output returns nothing — see "Local verification"),
deletes the classic-vs-fine-grained-PAT problem (M-2, moot — there is no PAT),
and deletes the "where does the SealedSecret land" problem (H-3, moot — there
is no SealedSecret).

**Operator action required**: each student's GHCR package defaults to private
on first push and must be flipped to Public once — see "OPERATOR ACTIONS"
below for the exact API call and a bulk script covering the whole current
roster. This is the one piece of this decision that costs operator effort; it
was chosen anyway because the alternative (classic PAT, ever-growing read
grants, actually finding a real place to land a SealedSecret) was assessed as
more total ongoing effort, not less.

## Security hardening (adversarial review B-4)

**B-4 — template injection.** `tag` originates from a value `lab-tag-sync.yaml`
resolves from the GitHub API and writes into a git file this chart reads — an
earlier draft interpolated it unquoted into `image:` in the Deployment
manifest. A tag value containing a YAML-significant character (e.g. a newline)
could inject sibling keys into the pod spec. Fixed two ways,
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
`chart/templates/externalsecret.yaml` reads a student's DB credentials (only
when `withDatabase` — see "Contract: withDatabase") via the EXISTING
platform-wide `vault-backend` ClusterSecretStore (same store every other
platform service uses) — property names `DATABASE_URL`, `DB_HOST`, `DB_NAME`,
`DB_USER`, `DB_PASSWORD`, mapped 1:1 into a k8s Secret `<appName>-db` that the
Deployment consumes via `envFrom`.

**Vault path notation — three correct forms, one value (adversarial review
M-6, disambiguating an earlier inconsistency where this README stated the path
three different ways without saying they were different things)**:
- **ESO `remoteRef.key`** (what `externalsecret.yaml` actually contains): the
  BARE KV-v2 logical path, `labs/<slug>/<user>` — no `secret/` or
  `secret/data/` prefix. Correct because the ClusterSecretStore already
  carries `spec.provider.vault.path: "secret"` as the mount point, and ESO
  appends `/data` itself for KV-v2 reads.
  - Both `labSlug`/`username` are the ALREADY-VALIDATED, lowercased values —
    slides must write to this SAME lowercased path or ESO 404s even though the
    roster data looked fine (see "Contract: lowercase everywhere").
- **Raw Vault HTTP KV-v2 API path**: `secret/data/labs/<slug>/<user>` — what
  `labs-read-role.sh`'s policy grants `read` on, and what a curl call or the
  Vault Go/JS client would address directly. This is the form slides' backend
  will actually use if it calls Vault's HTTP API.
- **Vault CLI `kv` subcommand form**: `vault kv patch secret/labs/<slug>/<user>
  ...` — the CLI's own `kv` helper inserts `data` itself, so this form LOOKS
  almost identical to the ESO bare form above; that visual similarity is the
  actual source of the confusion this section exists to resolve. They are not
  interchangeable outside their own tool's context.

**What's missing today**: `external-secrets-ro` (the policy the ESO controller's
k8s-auth role carries) does not cover `secret/data/labs/*` — see
`platform-services/external-secrets/vault-policies/labs-read-role.sh`
(drafted, not applied — agents are classifier-gated from prod Vault writes).

**Write side (slides writes the values; NOT built here)**:
`platform-services/external-secrets/vault-policies/slides-labs-writer-role.sh`
drafts the WRITE-only policy + k8s-auth role slides' backend will authenticate
as (mirrors `backstage-role.sh` exactly): **create + update + patch ONLY — no
`read`, no `delete`.**
- **Setting/updating credentials**: KV-v2 `PATCH` (merge-patch), same as
  Backstage's secrets-UX.
- **Removing a single key**: a merge-patch with that key set to `null`
  (`{"DATABASE_URL": null}`), NOT a `vault kv delete` / KV-v2 `DELETE` — the
  policy grants no `delete` capability, so an actual delete call 403s.
- **No read-back**: the slides backend cannot fetch a previously-written value
  from this path with this token. If slides ever needs to display "current"
  values back to a TA/admin, it must retain them itself (e.g. in its own
  Postgres, as it already does for the browser-only lab-mariadb creds) — Vault
  is write-only from this identity.

Wiring the slides Deployment to actually present that identity (a projected
serviceAccountToken volume, same as `backstage-process-app.yaml`) is a
slidedeck-repo change — out of scope for this PR; the script only stands up
the Vault-side identity ahead of that wiring landing.

## Netpol: lab pods reaching lab-mariadb (adversarial review B-1 — CRITICAL fix)

**This was a real, would-have-shipped-broken bug.** `platform-services/lab-db/
netpol.yaml` (already live on `main`, from PR #425) governs ingress to the
`lab-mariadb` pod in ns `slides` with an explicit allowlist of PEERS
(`podSelector`s for `app: slidedeck` and `app.kubernetes.io/name: lab-adminer`
— no `namespaceSelector`, so only same-namespace `slides` pods matching those
labels could reach it). This chart's own `namespace-bootstrap.yaml` adds the
EGRESS side from every `withDatabase` `lab-<slug>` namespace to `slides:3306`
— but per that netpol file's OWN header comment ("a peer's egress allowance
alone does not admit traffic once the receiver is policy-covered"),
egress-only is not enough: `lab-mariadb` already declares
`policyTypes: [Ingress, ...]`, so it is policy-covered, and without a matching
INGRESS rule naming lab pods as an allowed peer, every hosted lab app's DB
connection would be dropped — the platform would ship an ExternalSecret with
valid credentials pointed at a database the app's own pod is network-denied
from ever reaching.

**Fix** (included in this PR, `platform-services/lab-db/netpol.yaml`): added a
`namespaceSelector: {matchLabels: {platform.capstone/component: lab}}` peer to
`lab-mariadb`'s `ingress[].from` list. Every `lab-<slug>` namespace this
chart's `namespace-bootstrap.yaml` creates carries that exact label
(`chart/templates/_helpers.tpl`'s `lab-app.labels`), so this ONE edit admits
traffic from every current AND future lab namespace on 3306 — no per-lab netpol
edit needed as labs come and go.

**Verification** (server-side dry-run + live label-match evidence):
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

  **Full quota, spelled out for a README-only reader** (`chart/values.yaml`):
  `requests.cpu: 5`, `requests.memory: 5Gi`, `limits.cpu: 10`,
  `limits.memory: 10Gi`, `pods: 30`, `services: 20`, and
  **`persistentvolumeclaims: 0`** — a HARD, deliberate constraint, not an
  oversight: lab apps are stateless by design (their database, when
  `withDatabase`, lives in the dedicated `lab-mariadb` instance in ns
  `slides`, never a per-app PVC). A future lab that genuinely needs a PVC must
  raise this quota explicitly.
- **M-2 (this section's M-2 is the resource-governance one — see "Pull: GHCR
  packages are PUBLIC" above for the OTHER M-2, about PAT scoping, which this
  numbering collision is left as-is from the original review rather than
  renumbered) — no intra-namespace traffic**: the original NetworkPolicies
  allowed unrestricted pod-to-pod traffic within a `lab-<slug>` namespace
  (`podSelector: {}` both directions), copied from the tenant model where one
  namespace = one TRUSTED team. Here one namespace = up to 15 MUTUALLY
  UNTRUSTED students sharing nothing (one Deployment/Service each, no
  sidecars). Removed both intra-namespace allow rules —
  `chart/templates/namespace-bootstrap.yaml` now permits only Traefik/
  cloudflared ingress and DNS(+lab-mariadb, if withDatabase) egress.
- **M-3 — no default-SA sharing**: every other app template in this platform
  gives its workload a dedicated ServiceAccount with
  `automountServiceAccountToken: false`; the lab chart was the odd one out on
  exactly the LEAST-trusted workload here (arbitrary student-authored code,
  publicly reachable). Fixed — `chart/templates/serviceaccount.yaml` +
  `deployment.yaml`'s `serviceAccountName`/`automountServiceAccountToken: false`.
  (This is a DIFFERENT M-3 than the "63-char cap" M-3 elsewhere in this
  README — again, left as originally numbered by the two separate review
  passes rather than renumbered, to keep finding IDs traceable back to the
  actual review comments.)

## Teardown

- **A student leaves / lab closes to new students**: slides removes their row
  from `students.yaml` → the merge generator drops that element → ArgoCD
  prunes that ONE Application (Deployment/Service/Ingress/ExternalSecret gone;
  the shared namespace and its siblings are untouched). `lab-tag-sync.yaml`'s
  NEXT poll simply stops finding that row and stops touching its tag file (it
  neither deletes nor needs to — the pruned Application means nothing reads it
  anymore); an operator MAY delete the stale `tags/<username>.yaml` for
  tidiness, not required for correctness.
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
- **What teardown does NOT clean up (adversarial review LOW — stated plainly,
  not assumed obvious)**: the Vault entries at `secret/labs/<slug>/<user>`
  are NOT deleted — the `slides-labs-writer` policy has no `delete`
  capability by design (see "Vault: read side vs write side"), and neither
  ArgoCD nor this chart has any Vault-write identity at all. Orphaned Vault
  data after teardown is an accepted, low-cost byproduct (it's inert once
  nothing reads it) — cleaning it up, if ever wanted, is a slides-side or
  manual Vault-admin action, not something this PR's teardown path performs.
  Similarly, each torn-down student's GHCR package (and its now-Public
  visibility, see "Pull: GHCR packages are PUBLIC") is NOT deleted or
  re-privatized by teardown — an intentionally-scoped decision to keep
  teardown to "stop serving traffic + free cluster resources," not "erase
  every trace," matching how student repos themselves are only ever ARCHIVED
  (never deleted) elsewhere in slidedeck's own teardown flow.

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
- Further expression-injection hardening review of `lab-build.yaml`/`lab-tag-sync.yaml` beyond the `env:`-passthrough fix already applied (L-1/L-2) — the pattern is consistent throughout both files, but a dedicated actionlint/zizmor pass was not run.
- Doc cross-links from `docs/operator/harbor.md` etc. noting labs no longer touch Harbor — not added; this README + the PR description are the source of truth for now.
- `lab-tag-sync.yaml` does not verify a GHCR image actually exists before writing its tag (trusts that a push already happened) — see that workflow's header for the tradeoff accepted.

**Fixed this round, trivial** (round-3 review's L-1/L-2/L-3 — NOTE: these are
DIFFERENT findings than the round-2 L-1/L-2 mentioned above, which were about
`lab-build.yaml`'s expression-injection pattern; the review's own finding IDs
reset per round rather than being globally unique, so — same as the M-1/M-2/
M-3 collisions elsewhere in this README — they're kept as originally
numbered rather than renumbered, to stay traceable back to the actual review
comments):
- `lab-tag-sync.yaml`'s `yq` install now uses `sudo install` rather than
  assuming an unprivileged write to `/usr/local/bin` on `ubuntu-latest`
  (every OTHER pinned-install in this repo targets a root ARC runner, where
  that assumption already held; this one doesn't).
- The `capstone-labs-fleet` clone is now a full clone, not `--depth 1` — a
  shallow clone's `git pull --rebase` retry path (in the commit+push step)
  can fail against history it doesn't have; the fleet repo is small enough
  that a full clone costs nothing meaningful.
- The malformed-row `WARN` message now reports the row index BEFORE it was
  incremented, so it names the actual bad row instead of the next one.

## Local verification

```bash
helm lint platform-services/lab-hosting/chart

# namespaceBootstrap mode, both withDatabase states:
helm template t platform-services/lab-hosting/chart --set namespaceBootstrap=true --set labSlug=lab1
helm template t platform-services/lab-hosting/chart --set namespaceBootstrap=true --set labSlug=lab1 --set withDatabase=true

# studentApp mode, both withDatabase states (H-1 — prove the false case has NO
# ExternalSecret / envFrom / 3306 egress, and the true case has all three):
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=jsmith --set tag=abc123d
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=jsmith --set tag=abc123d --set withDatabase=true

# confirm no pull secret anywhere (H-3):
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=jsmith | grep -i pullsecret   # expect: no output

# fail-guards (should each error loudly, scoped to this one render):
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=JSmith        # C-1: not lowercase
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=jsmith --set tag=not-hex  # B-4: bad tag
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=jsmith --set tag=abc123d --set repo=""  # round-3 M-1: repo now required

# M-1 image-ref derivation (round 3) — conforming vs. a deliberately
# nonconforming repo field, proving the ref now tracks `repo` exactly rather
# than silently reconstructing labSlug-username:
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=jsmith --set tag=abc123d --set repo=UA-MIS/lab1-jsmith | grep image:
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=jsmith --set tag=abc123d --set repo=UA-MIS/totally-different-repo-name | grep image:
```

**`lab-tag-sync.yaml` cannot be verified this way** — it's a GitHub Actions
workflow, not a Helm template. Round-3 review found a real bash syntax error
(H-1 above) that inspection alone missed for two whole rounds; verifying it
now REQUIRES actually running it, not just reading it:

```bash
# 1. Extract each step's `run:` block exactly the way Actions parses it
#    (yaml.safe_load -> steps[].run), and bash -n each one — must be clean:
python3 -c "
import yaml
doc = yaml.safe_load(open('.github/workflows/lab-tag-sync.yaml'))
for i, step in enumerate(doc['jobs']['sync']['steps']):
    if 'run' in step:
        open(f'/tmp/step_{i}.sh', 'w').write('#!/usr/bin/env bash\n' + step['run'])
"
for f in /tmp/step_*.sh; do bash -n "$f" || echo "SYNTAX ERROR in $f"; done

# 2. Actually execute the extracted "poll + write tag files" step against a
#    real local git repo standing in for capstone-labs-fleet, with a fake
#    `curl` on PATH stubbing the GitHub API responses (default_branch + HEAD
#    sha), covering: a normal username, an all-digit-first-12-chars sha
#    (proves M-4's quoting prevents numeric coercion), and a username of
#    literally `no` (proves it prevents YAML 1.1 boolean coercion). Confirm
#    the written files are valid YAML with all THREE values still strings,
#    then run the whole thing a second time unchanged and confirm zero new
#    commits (idempotence) — see the PR thread for the full transcript.
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
3. **Merging this PR to `main` IS the deploy for the two ApplicationSets — no
   manual `kubectl apply` needed or possible.** `bootstrap/root-app.yaml`
   recurses `applicationsets/` with `automated: {prune: true, selfHeal: true}`,
   so ArgoCD picks up `labs-namespace-appset.yaml`/`labs-students-appset.yaml`
   automatically on merge, per this platform's own golden rule ("you do not
   `kubectl apply` to change the platform" — `docs/operator/README.md`).
   **Sequencing matters**: do step 1 (create the fleet repo) BEFORE or
   immediately after merging — until it exists and is readable, both new
   ApplicationSets' git generators show `ErrorOccurred` (harmless — they just
   generate zero Applications — but noisy in the ArgoCD UI until the repo
   exists). The `lab-tag-sync.yaml` SCHEDULED WORKFLOW, by contrast, does NOT
   auto-enable on merge — GitHub disables `schedule` triggers on workflows in
   a repo with no activity for 60 days, and more relevantly here, it simply
   won't fire usefully until secrets exist (step 5) and the fleet repo has
   real data (step 1) — no action needed beyond merging for it to start
   working once those are in place.
4. **GHCR — make each student's package Public** (adversarial review H-3/M-2
   — replaces the round-1 Harbor-robot / round-1-revision static-PAT-pull
   plans entirely; see README "Pull: GHCR packages are PUBLIC" for why this
   was chosen over maintaining a pull credential):
   ```bash
   # one-time, per student, after their FIRST successful push creates the
   # package (idempotent — safe to re-run):
   gh api -X PATCH "/orgs/UA-MIS/packages/container/<labSlug>-<username>" -f visibility=public

   # bulk, covering the whole CURRENT roster (run periodically, or after
   # onboarding a batch of students) — requires a token with admin:org or the
   # package-admin equivalent, which a plain repo-scoped GITHUB_TOKEN does NOT
   # have (verified by this PR's own review as a real constraint, not
   # assumed) — use an operator PAT, not the CI token:
   for repo in $(yq -r '.[] | .labSlug + "-" + .username' labs/*/students.yaml); do
     gh api -X PATCH "/orgs/UA-MIS/packages/container/${repo}" -f visibility=public || echo "WARN: ${repo} (package may not exist yet — no push since last run)"
   done
   ```
   No `imagePullSecrets`, no SealedSecret, no per-namespace anything — the
   Deployment has none of that (confirmed — see "Local verification").
5. **GHCR — no push-side secret needed.** Each student repo's CI uses its own
   automatic `GITHUB_TOKEN` (with `permissions: packages: write` — declared in
   both the reusable workflow and the caller, see `.github/workflows/
   lab-build.yaml`'s header). Nothing to mint or store for this side at all.
6. **`lab-tag-sync.yaml` — mint TWO platform-infra-only secrets** (adversarial
   review H-2 — neither of these is ever granted to any student repo):
   - `LAB_ROSTER_READ_TOKEN` — a token that can READ commit metadata across
     every current and future student repo (fine-grained PAT, organization
     resource owner, "all repositories", Contents:read ONLY — deliberately
     broad but read-only, low risk by construction: it can never write or
     destroy anything). Set as a `platform-infra` repository (or org, scoped
     to `platform-infra` only) secret:
     `gh secret set LAB_ROSTER_READ_TOKEN --repo UA-MIS/platform-infra`.
   - `LAB_FLEET_WRITE_TOKEN` — a fine-grained PAT scoped to
     `UA-MIS/capstone-labs-fleet` ONLY, Contents:read/write (the same shape
     the round-1 `LAB_FLEET_TOKEN` had — the fix here is WHERE it lives, not
     its own scope, which was already minimal):
     `gh secret set LAB_FLEET_WRITE_TOKEN --repo UA-MIS/platform-infra`.
7. **Vault — read side**: run
   `platform-services/external-secrets/vault-policies/labs-read-role.sh` inside
   `vault-0` (see its header for the exact `kubectl exec` invocation).
8. **Vault — write side**: run
   `platform-services/external-secrets/vault-policies/slides-labs-writer-role.sh`
   inside `vault-0`. This alone does NOT let slides write yet — the slidedeck
   Deployment also needs the projected `serviceAccountToken` (audience `vault`)
   + SA `slides-vault-writer` wiring; that's a slidedeck-repo change, tracked
   there, not in this PR.
9. **DNS — the one-time wildcard route.** Marked here as
   **operator-confirmed, not independently re-verified by this PR** (an
   earlier draft of this README said "DONE" on the strength of the
   coordinator's own statement alone — restated more precisely): the operator
   reported already adding ONE Cloudflare Tunnel Public Hostname route for
   `*.uamishub.com` (HTTP, empty path, origin
   `traefik.kube-system.svc.cluster.local:80`). This IS a tunnel *routing
   config* change (the dashboard-managed Public Hostname list) — what's
   independently verified by THIS PR (live, read-only) is only that
   cloudflared's own process-level ingress config stays a single catch-all
   (`ingressRule=0` on both replicas) — a wildcard Public Hostname still
   resolves to that one rule regardless of who added it or when, so no
   PER-LAB or PER-STUDENT Cloudflare change is ever needed going forward
   REGARDLESS of the current status of the one-time route itself. If the
   route is not actually live yet, no lab-hosting URL will resolve until it
   is — worth a operator double-check, not just taking this line's word for
   it. `*.uamishub.com` was chosen over `*.labs.uamishub.com` for zero
   incremental TLS cost (free Universal SSL already covers a single-label
   wildcard on the zone apex) — see "Judgment calls" below.

### Judgment calls made without being able to verify live (flagged, not hidden)

- **`*.uamishub.com` vs `*.labs.uamishub.com`** for the one-time wildcard —
  the former was used (zero incremental TLS cost); a reasonable alternative
  for tighter zone-scoping, not taken.
- **Public GHCR packages vs. a maintained pull credential** (H-3/M-2) — chosen
  after concluding the private-package path required either a classic PAT
  with an ever-growing per-repo grant list, or a nontrivial GitOps landing
  spot for a per-namespace SealedSecret that the round-1 design never
  actually resolved. A reasonable operator could still prefer private
  packages for other reasons (e.g. hiding student source/Dockerfile
  structure, not just the running app); that tradeoff is now explicit rather
  than defaulted-into.
- **`withDatabase` duplicated across `lab.yaml` and every `students.yaml` row**
  rather than joined via a nested `matrix` generator — chosen because the
  `matrix` approach could not be verified against a live ArgoCD controller
  from this environment, while the `merge` generator's behavior already had
  independent verification from round 1's review. See "Contract:
  withDatabase" for the full reasoning.
- **`LAB_ROSTER_READ_TOKEN` scoped "all repositories"** rather than an
  explicit, maintained list — deliberately broad-but-read-only, accepting
  that scope as lower operational burden than keeping a repo list in sync,
  since a read-only token cannot itself cause the H-2 class of damage.
- **Container port = 8080, fixed** rather than adding a `port` field to the
  roster schema — mitigated by injecting `PORT=8080`, which covers most
  frameworks; a template whose framework ignores `$PORT` still needs its own
  adjustment.
- **`runAsUser: 65532` forced at the pod level** (M-5) — known to break the
  Next.js starter template as shipped; not fixed, prominently flagged instead
  (see "Container security context vs. lab template images").
- **ArgoCD repo-credential coverage for the new fleet repo** (operator step 2)
  — inferred from `argocd-repo-creds-uamis`'s existing org-wide usage
  (cohort-gc), not independently verified (its `url` field is SealedSecret-
  encrypted; decrypting it is a cluster-admin action outside this PR's scope).
  Marked as an explicit operator verification step, not assumed to just work.
