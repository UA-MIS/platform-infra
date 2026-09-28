# Renovate: pinned-version watchdog

## Why this exists

The 2026-09-25 → 2026-09-28 CI outage (~48h, every team) was caused by
`ghcr.io/actions/actions-runner:2.335.1` aging into a GitHub-deprecated
version. It was pinned in **four** places, nothing was watching it, and the
failure surfaced as a frozen ARC controller (a single-worker reconcile loop
wedged on a blocked delete call) — not an error message anyone would think to
grep for. See `platform-services/arc/README.md` and
`platform-services/monitoring/alerts-arc.yaml` for the full incident writeup.

Renovate's job here is narrow and specific: **nothing pinned goes
unattended.** Not "stay on the latest version of everything" — several pins in
this repo are deliberately held back, and Renovate is configured to leave
those alone (see below). The goal is visibility and a routine, reviewable path
to bump, so a stale pin is a Monday PR instead of a multi-day outage.

Config lives at `/renovate.json5`. This doc is the inventory and the
reasoning; the config comments are the enforcement.

## What's covered

| Surface | Manager | Notes |
|---|---|---|
| Every `Dockerfile*` in the repo (platform + scaffolder skeleton templates) | `dockerfile` (native) | includes distroless base images, the deliberately-pinned backend `node:24.16` ARG |
| `.github/workflows/**`, `.github/actions/*/action.yml` (incl. SHA-pinned `supply-chain-verify`) | `github-actions` (native) + `helpers:pinGitHubActionDigests` | also proposes pinning the few remaining floating `actions/checkout@v4` refs to SHA |
| 32 real Kubernetes Deployment/StatefulSet/CronJob/Job manifests under `platform-services/` (Dex, Vault, MinIO, Tempo/Thanos, portal, labmx, etc.) | `kubernetes` (native, curated `managerFilePatterns` — off by default upstream) | see the file list in `renovate.json5`; every entry confirmed by grep to contain a real `image:` field |
| Helm chart versions for every ArgoCD `Application` in `applicationsets/*.yaml` (harbor, traefik, kyverno, rook-ceph, cnpg-operator, mariadb-operator, vault, external-secrets, kube-prometheus-stack, loki, alloy, otel-collector, velero, goldilocks, vpa, reloader, descheduler, metrics-server, argo-rollouts, opencost, minio, gha-runner-scale-set + controller, crossplane-core) | `argocd` (native) | reads `spec.source.{repoURL,chart,targetRevision}` |
| ARC runner image, `ghcr.io/actions/actions-runner`, in its 3 pinned sync locations | custom regex manager (`custom.regex`), grouped | **the outage cause.** One PR touches all 3 or none |
| Rook-ceph Ceph image, MariaDB server image, Thanos sidecar image — embedded `image: repo:tag` inside `applicationsets/*.yaml` Helm values blocks | custom regex manager | native `argocd`/`kubernetes` managers don't parse YAML string scalars |
| Vault, Vault-unsealer, otel-collector images — embedded split `repository:`/`tag:` form | custom regex manager | same reason, different shape |
| CNPG Postgres image (`Cluster.spec.imageName`, both the platform and tenant clusters) | custom regex manager | `Cluster` isn't a workload kind the `kubernetes` manager recognizes, and the field is `imageName` not `image` |
| `dockerhub-mirror-configmap.yaml`'s tag-based pre-cache entries | custom regex manager | digest-pinned entries excluded by construction (see below) |

Managers are an explicit allow-list (`enabledManagers`), not
`config:recommended`'s full default set — see "What's not covered."

## Deliberate exclusions — do not remove without re-reading why

These exist because Renovate blindly bumping them would re-break the
platform. Each is a `packageRules` entry in `renovate.json5` with the same
reasoning inline; this is the narrative version.

- **`node:24.16`, repo-wide (not just the backend Dockerfile).** Node 24.17
  shipped a keepAlive socket fix (CVE-2026-48931) that breaks
  `@backstage/catalog-client`'s localhost fetch — `"Invalid response body ...
  Premature close"` — which made the OIDC sign-in resolver's catalog lookup
  fail and caused an infinite sign-in loop (Backstage issue #34651, this
  platform's M2 incident). The pin lives in
  `platform-services/backstage/app/packages/backend/Dockerfile` as a
  digest-pinned `ARG`, but the *same* `24.16-trixie` tag also shows up in
  `dockerhub-mirror-configmap.yaml`'s pre-cache entries and in two CI job
  containers (`portal-tests.yaml`, `ci-scripts-sync-check.yaml`) that were
  bumped to it in lockstep. The exclusion rule matches on `currentValue`
  (`/^24\.16/`) rather than a fixed file/packageName list, specifically so a
  new proxy path or mirror entry doesn't silently fall outside it. Digest
  refreshes (same tag, new OS security patch) stay enabled; version bumps off
  24.16 do not.
- **rook-ceph / rook-ceph-cluster charts, held to `<1.20.0`.** v1.20 changes
  the CSI driver deployment model to a mandatory separate CSI-operator chart —
  see `applicationsets/rook-ceph-operator-app.yaml`'s header. Patch/minor
  movement within 1.19.x stays enabled (still useful); 1.20+ is blocked until
  that migration is done deliberately, by a human, on purpose.
- **CNPG Postgres image, never an auto-proposed major bump.** A Postgres
  major version needs `pg_upgrade` and a human, not a Monday batch PR. Minor
  build/flavor refreshes within PG 17 stay enabled.
- **MariaDB image, held to `<11.9.0`.** Pinned to 11.8.8 for version parity
  with the off-cluster `ua-mis-db-1` box
  (`applicationsets/mariadb-cluster-app.yaml`'s comment). A minor/major bump
  on one side without the other breaks that parity.
- **This platform's own CI-built images** —
  `harbor.capstone.uamishub.com/platform/*` (agile-board, backstage) and
  `/labmx/*` — are excluded entirely. These are bumped by the existing
  `bump-dev`/`bump-portal`/`promote-to-prod` pipeline via git-sha or
  placeholder tags (`ci: bump image to <sha> [skip ci]`), not vendor releases
  Renovate can meaningfully version-check.
- **Digest-pinned Harbor artifacts** (`dockette/adminer:*@sha256:...`,
  `adminer:5.5.1@sha256:...`, etc.) are already tag+digest pinned, which is
  the correct, GC-safe pattern (a digest alone is not a retention anchor —
  Harbor's `delete_untagged` GC reclaims it; three outages on 09-16 were
  caused by exactly that). Renovate's normal digest-update behavior keeps the
  tag and only refreshes the digest, so no special handling was needed —
  verified, not just assumed.
- **Cilium is out of scope, not silently missed.** It is installed by hand
  from `docs/cilium-cni-runbook.md` (`helm install cilium cilium/cilium
  --version 1.17.4 ...`), not as a declarative ArgoCD Application or any other
  file Renovate can safely parse and PR against. Recommend a follow-up:
  convert it to a proper GitOps-managed Application so it can be tracked here
  too — flagged, not fixed, in this pass.

## What's not covered (scope boundary, not an oversight)

`enabledManagers` is an explicit allow-list: `dockerfile`, `github-actions`,
`kubernetes`, `argocd`, `custom.regex`. `config:recommended`'s other default
managers (npm, gomod, etc.) are deliberately off. The largest thing this
excludes is `platform-services/backstage/app`'s `yarn.lock` — a different,
much noisier dependency surface (frontend/backend JS deps) with its own churn
profile. This pass is about infra pins — the ones that age silently and
surface as a frozen controller, not a `npm audit` warning. Follow-up, not
forgotten.

## How Renovate runs

**Recommendation: hosted Renovate GitHub App, not self-hosted.**

This platform is handed to students in ~3 months and nobody has signed up to
maintain a bespoke runner. Self-hosting Renovate as a Kubernetes CronJob would
mean: a new container image to keep patched, a GitHub App credential to
rotate, cluster resources and RBAC to maintain, and — pointedly — one more
pinned thing (the Renovate image/chart version itself) that can silently age
into failure, which is the exact failure class this whole effort exists to
close. The hosted App has none of that: Mend operates it, it updates itself,
and it costs the platform zero maintenance.

**Manual step required (org admin only — cannot be done from this PR):**

1. Go to <https://github.com/apps/renovate> and click **Install**.
2. Choose the `UA-MIS` organization.
3. Select **Only select repositories** → `platform-infra` (or "All
   repositories" if the org wants it everywhere; that's a separate call).
4. Approve. Renovate will pick up `/renovate.json5` on its next scheduled run
   (or trigger one immediately from the Renovate dashboard/Mend UI) — no
   onboarding PR needed since the config already exists in this repo.

Until that install happens, this config sits inert (same as any other
uninstalled GitHub App) — it does nothing on its own, which is why the
verification below was run via the local `renovate` CLI instead of waiting on
the install.

## The deprecation check (the other half of this)

Renovate answers "is there a newer version?" It does not answer "has my
pinned version been deprecated by the vendor?" — those are different
questions, and the second one is what actually caused the outage:
`2.335.1` wasn't stale relative to a newer release at pin time, it aged into
deprecation *after*.

`.github/workflows/actions-runner-deprecation-check.yaml` closes that gap,
narrowly:

1. Reads the pinned version out of all 3 sync locations and fails loudly if
   they disagree (the "change all three or none" invariant, checked
   mechanically instead of by memory).
2. Compares against `actions/runner`'s GitHub releases. There is no public
   "is version X deprecated right now" API — GitHub's broker enforces that
   server-side. This is a **heuristic early warning**, not a guarantee: it
   fails if the pin is not the latest release AND that release is ≥75 days
   old (comfortably inside the "rolling few-month window" the postmortem
   documented). A pass means "no known risk today," not "safe forever."
3. On failure, opens (or comments on) a tracking issue labeled
   `actions-runner-deprecation` + `security` — loud, not a red X nobody sees.

Runs weekly (`workflow_dispatch` also available for on-demand checks).

## Verification (what was actually run, not just asserted)

All of the following were run against a real, git-tracked clone of
`UA-MIS/platform-infra` (branch `devops/renovate-setup`) using the `renovate`
CLI (v42.99.0, the latest release compatible with this environment's Node
22.x — Renovate ≥43 requires Node 24) in `--platform=local --dry-run=full`
mode, which extracts and evaluates every manager/packageRule against the real
files without touching the remote repo.

- **`renovate-config-validator renovate.json5`** → `Config validated
  successfully`.
- **Dry-run extraction found and correctly evaluated real updates**,
  including live registry lookups against `ghcr.io`, `index.docker.io`,
  `quay.io`, `charts.rook.io`, etc. (confirmed via HTTP cache log entries for
  each). Result: **7 grouped batch branches** would be proposed on the next
  scheduled Monday run —
  `renovate/github-actions`, `renovate/kubernetes-embedded-container-images`,
  `renovate/argocd-helm-chart-versions`, `renovate/docker-base-images`, and
  their `-major` counterparts (major bumps are grouped separately by
  `config:recommended`'s default behavior, so they're visibly distinct from
  routine batches).
- **ARC runner image, the actual outage cause:** the custom regex manager
  matched `ghcr.io/actions/actions-runner:2.337.0` in all 3 files, looked it
  up live against `ghcr.io`, and correctly found **no update available** —
  2.337.0 already is the latest `actions/runner` release (verified
  independently via `gh api repos/actions/runner/releases/latest`). This
  proves the matcher works (it reached the dependency and the registry, it
  just had nothing to propose right now) rather than silently matching
  nothing, which was the specific failure mode to rule out.
- **Deliberate exclusions confirmed absent from every proposed branch:**
  `grep -c` across the final `branchesInformation` output —
  `harbor.capstone.uamishub.com/platform|labmx` → **0**, node `24.16` as a
  proposed upgrade → **0** (the one remaining match was an HTTP-cache stat
  line, not an upgrade), MariaDB past 11.8.x → **0**, rook-ceph past 1.19.x →
  **0**, CNPG major bump → **0**.
- **First pass had a real gap, caught by this same verification, then
  fixed:** the initial `node:24.16` exclusion only matched
  `docker.io/library/node` and `library/node`; the dry-run surfaced a third
  variant, `harbor.capstone.uamishub.com/dockerhub-proxy/library/node:24.16-trixie`,
  used by two CI job containers. The exclusion rule was rewritten to match on
  `currentValue` (`/^24\.16/`) across any `**/node` packageName instead of an
  exact list, and the dry-run was re-run clean. This is the exact class of
  mistake a config that "looks right" but was never executed would ship — see
  the "prove it matches" framing at the top of this task.
- **`actions-runner-deprecation-check` logic tested directly** (the same
  commands the workflow runs, executed locally against the live GitHub API):
  - Current pin `2.337.0` vs. `gh api repos/actions/runner/releases/latest` →
    equal → **status=ok** (correctly passes).
  - Deliberately old version `2.328.0` → `published_at: 2025-08-13T16:49:24Z`
    → **411 days old**, ≥ the 75-day threshold and not latest → **status=stale,
    exit 1** (correctly fails loudly). The `workflow_dispatch.override_version`
    input runs this same test path inside the real workflow on demand.

## Follow-ups (not done in this pass, flagged not silently dropped)

- **Auto-merge for a narrow safe class** — digest-only refreshes (OS security
  patches on an already-pinned tag, e.g. the `node:24.16` digest bumps this
  config explicitly allows) are the safest possible update: same version,
  same behavior, patched base image. Once a few weeks of manual-merge PRs
  build trust in the pipeline, consider `packageRules` automerge scoped to
  `matchUpdateTypes: ["digest"]` only, still gated on CI passing. Not done
  now — the instruction was PRs-only for the first pass, deliberately.
- **Cilium** — convert the manual runbook install to a declarative ArgoCD
  Application so it's trackable at all (see above).
- **Harbor registry reachability for hosted Renovate** — some images resolve
  through `harbor.capstone.uamishub.com` (the dockerhub-proxy mirror, CNPG,
  etc.). The hosted GitHub App runs on Mend's infrastructure and needs to
  reach that host's registry v2 API over the public internet. It's fronted by
  Cloudflare and used by CI already, so it's plausibly reachable, but this was
  **not verified against the hosted runner's network path** — only against
  this environment's. If the first scheduled run shows lookup failures for
  `harbor.capstone.uamishub.com/*` packages, the fix is a `hostRules` entry
  (and possibly a read-only robot credential as an encrypted Renovate secret,
  if anonymous pulls aren't allowed on those projects).
