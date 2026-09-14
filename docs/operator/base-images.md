# base-images (permanent build-path image mirror)

`base-images` is a Harbor project (`https://harbor.capstone.uamishub.com/harbor/projects` →
`base-images`) that holds a **permanent, never-evicted** copy of every base image
the org's build path pulls FROM: Dockerfile `FROM` lines, CI job `container:`
images, the Kaniko executor itself, and scaffolder skeleton base images. It is
declared in git at `platform-services/harbor-base-images/`, picked up by the
`platform-services` directory-generator ApplicationSet as the ArgoCD Application
`platform-svc-harbor-base-images`.

It is **not** the same mechanism as `dockerhub-proxy` / `mcr-proxy` (Harbor
`proxy_cache` projects with a 7-day `nDaysSinceLastPull` retention policy + nightly
GC — see [Harbor](harbor.md)'s "Proxy caches vs. the permanent base-images mirror"
section for the full contrast). Those evict; `base-images` never does. `mcr-proxy`
is documented here too because it shares this project's failure mode and fix (see
"Incident" below) — `dockerhub-proxy` is a separate, tenant-facing proxy-cache and
is out of scope for this doc.

---

## It is PUBLIC — do not make it private

`public: true` is deliberate, not an oversight. ARC's Kaniko build pods carry **no
`imagePullSecrets`**, so every pull from `base-images` (a Dockerfile `FROM`, a CI
job's `container:` image, the Kaniko executor image itself) is anonymous. Making
this project private would break every build in the org simultaneously — there is
no credential plumbed anywhere in the build path to authenticate an image *pull*
from it. (The mirror-population *push* path does use a scoped robot — see
"Repopulation" below — but that robot has no bearing on pull access.)

`vulnerabilityScanning: false` for the same class of reason as the proxy-cache
projects: this is unmodified upstream content the platform does not build, so a
Trivy finding here is not actionable locally — it would need to flow upstream.

---

## What lives in it, and where each image comes from

| Image | Upstream registry | Pinned as | Repopulation mechanism |
| --- | --- | --- | --- |
| `library/python:3.12-slim`, `:3.11-slim`, `:3.12-slim-bookworm`, `:3-slim` | Docker Hub | tag | `dockerhub-mirror-populate` CronJob |
| `library/node:22-alpine`, `:18-alpine`, `:24.16-alpine`, `:24.16-trixie-slim`, `:24.16-trixie`, `:24-trixie`, `:24-trixie-slim`, `:22-bookworm-slim` | Docker Hub | tag | `dockerhub-mirror-populate` CronJob |
| `library/nginx:1.27-alpine`, `:1.29-alpine`; `nginxinc/nginx-unprivileged:1.27-alpine` | Docker Hub | tag | `dockerhub-mirror-populate` CronJob |
| `library/golang`, `library/composer`, `library/php`, `library/ruby`, `library/rust`, `library/maven`, `library/eclipse-temurin`, `library/postgres` (see `dockerhub-mirror-configmap.yaml` for the exact tags) | Docker Hub | tag | `dockerhub-mirror-populate` CronJob |
| `kaniko-project/executor:v1.23.2-debug` (`@sha256:c3109d5926a997b100c4343944e06c6b30a6804b2f9abe0994d3de6ef92b028e`) | **gcr.io** | digest (SEC, D-030) — the Kaniko executor itself, needed by **every** build | `replication-gcr-kaniko-executor.yaml` (manual-trigger) **and** `dockerhub-mirror-populate` CronJob (automatic — see below) |
| `dotnet/sdk` (`@sha256:5ef85cc12cb25be6ec319a7392d1e9efd53c3bc8abb971c53d8058a473f09053`) | **mcr.microsoft.com** | digest (SEC, D-030) | `replication-mcr-dotnet-sdk.yaml` (manual-trigger) **and** `dockerhub-mirror-populate` CronJob (automatic) |
| `dotnet/aspnet` (`@sha256:9a464e9a7e8c6144631020975f703c89034fe386417cb740620df69c2c6cfe24`) | **mcr.microsoft.com** | digest (SEC, D-030) | `replication-mcr-dotnet-aspnet.yaml` (manual-trigger) **and** `dockerhub-mirror-populate` CronJob (automatic) |
| `gcr.io/distroless/static-debian12:nonroot`, `gcr.io/distroless/cc-debian12:nonroot` | **gcr.io** | tag | `replication-gcr-distroless-{static,cc}.yaml` (manual-trigger) |

The full, current source-of-truth list lives in
`platform-services/harbor-base-images/dockerhub-mirror-configmap.yaml` (Docker
Hub + the GCR/MCR entries the CronJob also covers) and the `replication-*.yaml`
files in the same directory (the Harbor-native path for GCR/MCR). If the two
disagree, the files are correct and this table is stale — update this table in the
same PR that changes either.

---

## How it gets (re)populated — two mechanisms, why both exist

1. **Harbor-native Replication MRs** (`replication-mcr-*.yaml`, `replication-gcr-*.yaml`)
   for MCR and GCR sources. `schedule: manual` — a human (or CI) POSTs
   `.../replication/executions` when a filter changes. This is the deliberate,
   reviewed path for bumping a pinned version: one PR changes the filter, one
   execution runs it, done. It does **not** run on its own on any schedule.

2. **`dockerhub-mirror-populate` CronJob** (`0 2 * * *`, `crane copy`) for Docker
   Hub sources, **plus** (as of 2026-09-14) the same 3 GCR/MCR images the
   Replication MRs above also cover. Harbor's native replication engine cannot
   populate Docker Hub anonymously past a shallow page depth (`pagination offset
   too large for anonymous requests` — Docker Hub's Hub API, not a Harbor bug;
   see the CronJob's header comment for the full verified mechanism), so this
   project uses `crane copy` via `mirror.gcr.io` instead — it resolves one exact
   tag/digest at a time and never lists. `images.txt`
   (`dockerhub-mirror-configmap.yaml`) now carries an optional second column
   naming the real source registry per entry (`gcr.io`, `mcr.microsoft.com`),
   defaulting to `mirror.gcr.io` when omitted.

   **Why the CronJob duplicates 3 of the Replication MRs' images:** the
   Replication MRs are `schedule: manual` — they do not self-heal after a
   project recreate. The CronJob runs nightly and is idempotent (a re-copy of an
   unchanged digest is a fast no-op via `crane`'s manifest HEAD check), so
   putting kaniko-executor/dotnet-sdk/dotnet-aspnet in *both* places means the
   project recovers automatically overnight even if nobody remembers to
   re-trigger the manual replications. This is intentional redundancy, not
   drift — see "Incident" below for why it exists.

   Add a new image: edit `dockerhub-mirror-configmap.yaml` in a normal, reviewed
   PR. Trigger immediately instead of waiting for 02:00:
   ```bash
   kubectl create job --from=cronjob/dockerhub-mirror-populate -n harbor \
     dockerhub-mirror-populate-manual-$(date +%s)
   ```

Neither mechanism ever deletes: `crane copy` has no delete verb, the
`mirror-push` robot has no delete permission, and Replication MRs are configured
`deletion: false`. Removing a line/filter stops that image from being
*refreshed*, it does not remove what's already mirrored — an image a tenant still
depends on never vanishes because a list was tidied.

---

## Incident: 2026-09-13 04:00:23Z — the project was destroyed by Kubernetes object churn

**What happened, confirmed in production:** the `Project` MRs for both
`base-images` and `mcr-proxy` were **recreated** at 04:00:23Z and went
`Synced=False` **one second later**. Both MRs had the Crossplane default
`deletionPolicy: Delete` (and default `managementPolicies: ["*"]`) — so whatever
triggered the recreate had Crossplane issue a `DELETE` against the real Harbor
project as part of it, before the recreate failed with `observe failed: cannot
run refresh: ... 403 FORBIDDEN`. A `404` there would have let Crossplane recreate
the project cleanly and self-heal; the `403` turned recoverable drift into a
**permanent stall** — every tenant build in the org (next-up, mychef, springais,
attributeextractor — anything whose Dockerfile or CI workflow pulls from
`base-images`) failed for **~36 hours**.

Compounding it: the `RobotAccount` MR reported `Ready=True` the entire time, even
though its external-name pointed at a robot bound to a Harbor project ID that no
longer existed. **Both resource types reported healthy over things that did not
exist**, which is why nothing paged anyone for a day and a half.

**Recovery (manual, by a human):** recreated both projects via the Harbor API
(public, matching the original spec), deleted the stale `RobotAccount` MR plus an
orphan robot squatting the `mirror-push` name so Crossplane could mint a fresh
robot and write a matching connection secret, then re-mirrored the images by hand
(`crane copy`, including a by-digest fetch for the GCR/MCR images the CronJob
could not reach at the time).

**Fix landed here:**

- `spec.deletionPolicy: Orphan` on both Project MRs
  (`platform-services/harbor-base-images/project.yaml`,
  `platform-services/harbor-mcr-proxy/project.yaml`). With `Orphan`, the identical
  failure sequence becomes a no-op: the MR can be recreated/churned freely, the
  registry content is never touched, and the next reconcile re-adopts it via the
  `crossplane.io/external-name` annotation.
  **Trade-off accepted, not hidden:** a *deliberate* decommission of either
  project now needs a manual Harbor delete — removing the MR alone no longer
  cleans up Harbor. That's the correct trade for a shared, org-wide mirror; it is
  explicitly the wrong default for a tenant's own Harbor project (tenant teardown
  legitimately needs Crossplane to delete it), so this change is scoped to only
  these two platform-owned Project MRs and must not be copied onto the
  tenant-scoped `Project` MR templated in
  `platform-services/crossplane/apis/composition.yaml`.
- `dockerhub-mirror-populate` now also mirrors `kaniko-project/executor`,
  `dotnet/sdk`, and `dotnet/aspnet` (digest-pinned) via the extended
  `images.txt` format, so an automatic, self-healing path exists independent of
  the `schedule: manual` Replication MRs — see "How it gets (re)populated" above.
- Each `crane copy` now retries up to 3 times with a short backoff before
  counting as a failure — verified necessary during recovery: the ~800MB
  `dotnet/sdk` image failed once on a transient `stream ID …; CANCEL` from
  Microsoft's CDN, then succeeded immediately on retry. Without a retry, a flaky
  upstream CDN fails the whole nightly job (`backoffLimit: 1` means the Job
  itself does not retry a failed Pod) and someone debugs a non-problem.

**Not fixed by this change, and worth a follow-up:** the RobotAccount MR's
false-healthy `Ready=True` over a dead external reference is a separate gap (this
PR does not add a liveness check for that) — flagged for a future pass, not
addressed here. Whatever destroyed the two MRs at 04:00:23Z was also never
identified (no controller/job/actor confirmed) — `deletionPolicy: Orphan` makes
that mechanism harmless going forward for these two projects, but it was not
diagnosed.

---

## Recovery runbook (if this ever happens again)

1. Check `kubectl -n crossplane-system get projects.project.harbor.crossplane.io
   base-images mcr-proxy` — if `Synced=False` with a `403` in the message and
   `deletionPolicy: Orphan` is in place (post-fix), the underlying Harbor project
   should **still exist** (Orphan means the MR's own churn never deleted it) —
   confirm via `GET /api/v2.0/projects/base-images` before assuming data loss.
2. If the project genuinely does not exist (pre-fix state, or a real manual
   deletion): recreate it via the Harbor API — `name`, `public: true`,
   `vulnerability_scanning: false` — and either update the MR's
   `crossplane.io/external-name` annotation to the new project ID, or delete and
   let Crossplane create fresh (project is empty either way at this point).
3. Check the `RobotAccount` MR (`base-images-mirror-push`) — do not trust
   `Ready=True` alone; confirm the robot it names actually exists in Harbor and
   is bound to the current project ID. If not, delete the stale MR (and any
   orphan robot squatting the same name in Harbor) so Crossplane mints a fresh
   one and rewrites the connection secret.
4. Re-run population: trigger `dockerhub-mirror-populate` immediately (see
   command above) for the Docker Hub + GCR/MCR-via-CronJob images, and manually
   `POST .../replication/executions` for each `replication-*.yaml` policy for
   the remaining GCR images (`distroless/static`, `distroless/cc`).
5. Confirm with a pull: `kubectl run verify --rm -it --image=harbor.capstone.uamishub.com/base-images/library/python:3.12-slim --restart=Never -- true`
   (public project, no pull secret needed).

---

## Disk

Registry PVC is 60Gi on `ceph-block`. `base-images` holds ~30 distinct images
across Docker Hub, MCR, and GCR — a few GB, not a capacity concern at this size.
Check current usage: `kubectl -n harbor exec deploy/harbor-registry -c registry --
du -sh /storage`.
