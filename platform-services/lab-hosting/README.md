# lab-hosting — public per-student app hosting for slidedeck's "labs" feature

Hosts a `hosted` lab's student apps at `<lab-slug>-<username>.uamishub.com`,
public, no SSO gate. A DELIBERATELY separate, much lighter mechanism from the
capstone tenant model (Backstage wizard → Crossplane XR → per-team namespaces,
promotion ladder, per-team Harbor/Vault) — ~15 students, no org GitHub identity,
no promotion model. See `RUNBOOK-DEPLOY.md` in `UA-MIS/slidedeck` for the full
lab-feature context this builds on (`hosted` flag, `labAppUrl()`,
`labRepoName()`, the existing per-student lab-mariadb + Adminer console).

This directory is EXCLUDED from the generic `platform-services` directory
ApplicationSet (see the exclude entry + comment in
`applicationsets/platform-services-appset.yaml`) — nothing here auto-syncs as a
standalone Application. It is consumed two ways instead:

- `chart/` — a Helm chart, rendered per-element by the two dedicated
  ApplicationSets below (`applicationsets/labs-namespace-appset.yaml`,
  `applicationsets/labs-students-appset.yaml`).
- `harbor/`, and `../external-secrets/vault-policies/labs-*.sh` — operator-run
  templates/scripts, never auto-applied (same shape as
  `platform-services/harbor-onboarding/`).

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
| `username` | yes | GitHub username, as scaffolded. The chart lowercases it (`\| lower`) everywhere it composes a k8s name/hostname/Vault path segment — GitHub usernames are already DNS-safe otherwise (alnum + single internal hyphens; see `chart/values.yaml` "Username handling"). |
| `repo` | yes | `org/name` of the student's repo (== `labRepoName()` == `<labSlug>-<username>`). Carried through as an annotation only — NOT parsed to derive the image name (the chart derives that from `labSlug`+`username` directly, which is guaranteed identical to the repo name by convention). |
| `labSlug` | yes | Must exactly equal the `lab.yaml` in the same directory. Present on every row (not inferred from the file path) so the merge generator's `mergeKeys` always has it, regardless of how a given ArgoCD version injects file-path metadata. |

**`labs/<lab-slug>/tags/<username>.yaml`** — single OBJECT. Written ONLY by that
one student's own CI (`.github/workflows/lab-build.yaml`), never by slides.
Absent until the student's first successful push.

```yaml
username: jsmith
labSlug: lab1
tag: a1b2c3d4e5f6
```

`tag` is the 12-char short commit SHA `lab-build.yaml` pushed to Harbor. Kept in
a file separate from `students.yaml` specifically to avoid a slides-vs-CI
write race — see `applicationsets/labs-students-appset.yaml`'s header for the
full rationale (an earlier draft had `tag` as a column on `students.yaml`;
rejected for that reason).

## Container port convention (judgment call)

Every hosted lab app MUST listen on `0.0.0.0:8080` — a fixed, platform-wide
convention (mirrors slidedeck's own port 8080), chosen specifically so
`students.yaml`/`tags/*.yaml` never need a `port` field. **This is a real
constraint on today's lab templates**: `.lab.yml`'s `STACK_RUN_DEFAULTS` in
slidedeck (`server/scaffold.js`) defaults Next.js to port 3000 — a Next.js
hosted-lab template's Dockerfile/start command must be adjusted to bind 8080 (or
the platform must add a `port` field later and thread it through the chart +
Deployment + Service; deliberately NOT done here, to keep the roster schema
minimal per the brief). Spring Boot's default (8080) already matches.

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

## Vault: read side vs write side

**Read side (this PR provides the manifest, NOT the Vault write)**:
`chart/templates/externalsecret.yaml` reads `secret/labs/<labSlug>/<username>`
via the EXISTING platform-wide `vault-backend` ClusterSecretStore (same store
every other platform service uses) — property names `DATABASE_URL`, `DB_HOST`,
`DB_NAME`, `DB_USER`, `DB_PASSWORD`, mapped 1:1 into a k8s Secret
`<appName>-db` that the Deployment consumes via `envFrom`.

**What's missing today**: `external-secrets-ro` (the policy the ESO controller's
k8s-auth role carries) does not cover `secret/data/labs/*` — see
`platform-services/external-secrets/vault-policies/labs-read-role.sh`
(drafted, not applied — agents are classifier-gated from prod Vault writes).

**Write side (slides writes the values; NOT built here)**:
`platform-services/external-secrets/vault-policies/slides-labs-writer-role.sh`
drafts the WRITE-only policy + k8s-auth role slides' backend will authenticate
as (mirrors `backstage-role.sh` exactly — PATCH merge-patch, no read-back, one
named SA `slides-vault-writer` in ns `slides`, `audience: vault`). Wiring the
slides Deployment to actually present that identity (a projected
serviceAccountToken volume, same as `backstage-process-app.yaml`) is a
slidedeck-repo change — out of scope for this PR; the script only stands up the
Vault-side identity ahead of that wiring landing.

## Harbor

One shared project `labs` (not per-student, not per-team) — reuses the EXISTING
`onboard-team-job.yaml`/`make harbor-onboard` mechanism completely unchanged
(it is already generically parameterized by `<name>`; the harmless side effect
of an inert OIDC group mapping `UA-MIS:labs` — no student will ever carry that
group claim — is accepted rather than forking the template). See "OPERATOR
ACTIONS" below for the exact sequence, including the Harbor v2.15 unified-robots-
API gotcha (`docs/operator/harbor.md` "The unified robots API") and its `name`
prefix (`robot$labs+<name>` — that FULL string is the docker username).

Two robots:
- **CI push** (org-level GitHub Actions secret, shared by every lab repo) —
  minted once via the unified API (`level:project`,
  `permissions[].namespace:"labs"`, `pull`+`push`), pasted into
  `HARBOR_ROBOT_USER`/`HARBOR_ROBOT_TOKEN` as an **organization** secret
  (`gh secret set --org UA-MIS`) so every lab template repo's CI picks it up
  with zero per-repo setup, per the brief. Scoped ONLY to project `labs` at the
  registry — safe to share broadly even as an org secret.
- **Pull** (one per `lab-<slug>` namespace) —
  `harbor/labs-pull-robot-job.yaml` (templated, `__LAB_SLUG__`), minted+sealed
  PER LAB NAMESPACE (not reused/resealed) — see that file's header for why a
  shared robot name can't just be reused across labs (Harbor robot names are
  unique per project) and the open landing-spot question for the resulting
  SealedSecret (a small platform-infra PR per new lab vs. an unmanaged
  `kubectl apply` — operator's call, both documented there).

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
`tenant-build.yaml`'s `supply-chain-verify` composite action). Today this is
**harmless**: the policy's `validationFailureAction` is currently `Audit`
platform-wide (report-only — confirmed live: the dry-run above returned a
`Warning`, not a blocking error) while tenant images get signed cosign coverage
proven out. **But it is documented as temporary** (`verify-image-signature.yaml`'s
own header: "until tenant images are actually verified cosign-signed... flip
back to Enforce"). If/when that flip happens, every lab pod would start failing
admission the moment `lab-build.yaml` pushes an unsigned image. Not fixed in
this PR (adding cosign signing to a "thin" reusable workflow was out of scope
for this pass) — flagged here so the eventual Enforce flip either (a) adds
cosign signing to `lab-build.yaml` first, or (b) makes a deliberate, reviewed
decision to keep `lab-*` excluded from that specific policy (unlike the other
two, which correctly stay unexcluded).

## Local verification

```bash
helm lint platform-services/lab-hosting/chart
helm template t platform-services/lab-hosting/chart --set namespaceBootstrap=true --set labSlug=lab1
helm template t platform-services/lab-hosting/chart --set studentApp=true --set labSlug=lab1 --set username=jsmith --set tag=abc123def456
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
3. **Apply the two new ApplicationSets** (already dry-run validated against the
   live cluster in this PR): `kubectl apply -f applicationsets/labs-namespace-appset.yaml -f applicationsets/labs-students-appset.yaml`.
   They will sit generating ZERO Applications (no matching files exist in the
   fleet repo yet) until step 1 + a real `lab.yaml`/`students.yaml` land.
4. **Harbor — create the shared project**: `make harbor-onboard NAME=labs KUBE_CONTEXT=admin@capstone`
   (existing target, zero code changes — see README "Harbor").
5. **Harbor — mint the CI push robot** (unified API, admin-authed, in-cluster —
   mirror the existing `harbor-robot`/`harbor-push-robot` Job pattern manually
   since there's no per-repo SealedSecret landing spot for this one):
   ```bash
   kubectl --context admin@capstone -n harbor exec -it deploy/harbor-core -- true # (sanity: confirms context)
   # From an in-cluster curl (Job or `kubectl -n harbor run --rm -it ...`), admin-authed:
   curl -sS -u "admin:$HARBOR_ADMIN_PASSWORD" -X POST http://harbor-core.harbor.svc:80/api/v2.0/robots \
     -H 'Content-Type: application/json' \
     -d '{"name":"labs-push","duration":-1,"level":"project","description":"CI push, shared by every lab repo",
          "permissions":[{"kind":"project","namespace":"labs","access":[
            {"resource":"repository","action":"pull"},{"resource":"repository","action":"push"}]}]}'
   # response: {"name":"robot$labs+labs-push","secret":"..."} — that FULL name
   # string (with the robot$ prefix) is HARBOR_ROBOT_USER.
   gh secret set HARBOR_ROBOT_USER --org UA-MIS --body 'robot$labs+labs-push'
   gh secret set HARBOR_ROBOT_TOKEN --org UA-MIS --body '<secret from response>'
   ```
6. **Harbor — mint a pull robot for the FIRST lab namespace**: run
   `harbor/labs-pull-robot-job.yaml` per its header, seal into `lab-<first-slug>`.
   Repeat per new lab namespace thereafter.
7. **Vault — read side**: run
   `platform-services/external-secrets/vault-policies/labs-read-role.sh` inside
   `vault-0` (see its header for the exact `kubectl exec` invocation).
8. **Vault — write side**: run
   `platform-services/external-secrets/vault-policies/slides-labs-writer-role.sh`
   inside `vault-0`. This alone does NOT let slides write yet — the slidedeck
   Deployment also needs the projected `serviceAccountToken` (audience `vault`)
   + SA `slides-vault-writer` wiring; that's a slidedeck-repo change, tracked
   there, not in this PR.
9. **DNS — ONE-TIME wildcard record** (per the corrected brief — NOT per
   student, NOT per lab): add a Cloudflare Tunnel Public Hostname
   `*.uamishub.com` → `http://traefik.kube-system.svc.cluster.local:80`
   (tunnel `b959ce76-568b-4f30-bfc8-ae6ef5169a10`, the same one
   `*.capstone.uamishub.com` already uses), proxied. **Recommend `*.uamishub.com`
   over `*.labs.uamishub.com`** (judgment call — see below) since Cloudflare's
   free Universal SSL already issues a `*.uamishub.com` wildcard cert for the
   zone apex (confirmed: slidedeck's own RUNBOOK notes "Universal SSL wildcard
   already covers a single label" for `slides.uamishub.com`), so this is a
   DNS-only change with **zero incremental Cloudflare cost or new TLS
   product** — a 2-level wildcard like `*.labs.uamishub.com` would need a NEW
   hostname entry on the paid Advanced Certificate that already covers
   `*.capstone.uamishub.com` (D-044/ADR-028), an extra step this PR did not
   confirm is free of charge/limit. Verified read-only that this is safe:
   cloudflared's tunnel ingress is a single catch-all rule
   (`kubectl -n cloudflared logs <pod> --tail 500 | grep -oE 'ingressRule=[0-9]+' | sort -u`
   → `ingressRule=0` only, both replicas, re-verified live for this PR) — so no
   tunnel *ingress* config changes, only the one new DNS record, and per-app
   routing stays entirely inside Traefik via each Ingress's `host:`.
10. **Confirm no downstream host collides.** `*.uamishub.com` is broader than
    today's explicit per-host records (`slides.`, `demos.`) — those still win
    (Cloudflare resolves the most specific match), so this is additive, not a
    behavior change for existing hosts. Flagging as an accepted, documented
    trade-off rather than a silent one.

### Judgment calls made without being able to verify live (flagged, not hidden)

- **`*.uamishub.com` vs `*.labs.uamishub.com`** for the one-time wildcard (item
  9) — recommended the former for zero incremental TLS cost; reasonable people
  could pick the latter for tighter zone-scoping. Operator's call.
- **Pull-robot SealedSecret landing spot** (item 6 / `harbor/
  labs-pull-robot-job.yaml`) — a small platform-infra PR per new lab, or an
  unmanaged `kubectl apply` outside GitOps. Left open; both documented.
- **Container port = 8080, fixed** rather than adding a `port` field to the
  roster schema — keeps the schema minimal per the brief, at the cost of
  requiring template authors to conform (flagged above under "Container port
  convention").
- **ArgoCD repo-credential coverage for the new fleet repo** (item 2) — inferred
  from `argocd-repo-creds-uamis`'s existing org-wide usage (cohort-gc), not
  independently verified (its `url` field is SealedSecret-encrypted; decrypting
  it is a cluster-admin action outside this PR's scope). Marked as an explicit
  operator verification step, not assumed to just work.
