# npm-mirror

In-cluster npm registry mirror/pull-through cache (Verdaccio), the npm-package
equivalent of `platform-services/harbor-dockerhub-proxy` for container images.
Removes the public npm registry as a hard dependency for every tenant's `npm ci`,
the same way the Docker Hub proxy-cache removed Docker Hub as one for image pulls.

## Why Verdaccio

Picked over Nexus/Artifactory/JFrog: it is a single small Node.js process
purpose-built for npm, no JVM or database sidecar, and ships an official minimal
Docker image. Proportionate to the actual need here (a handful of tenant
frontends' `npm ci`), not a general-purpose multi-format artifact server.

## How it works

- One `uplink` (`https://registry.npmjs.org/`) with a catch-all `packages: '**'`
  proxy rule (`configmap.yaml`). A cache miss transparently fetches and caches
  from npmjs; a cache hit never leaves the cluster.
- No publish/auth story — this mirrors reads only. `publish`/`unpublish` are left
  at the (unreachable, since no users are ever registered) `$authenticated`
  default rather than adding a separate deny rule.
- Listens on **8080**, not Verdaccio's 4873 default (`VERDACCIO_PORT` env — the
  official image ignores `listen:` in config.yaml). 8080 is already in
  `arc-runners`' `allow-egress-scoped` allowed port set, so **no netpol change
  was needed** to let CI reach it — see `netpol.yaml`'s header for the pod-port-
  vs-service-port subtlety that makes this matter.

## Storage: permanent, not just cached

Owner directive: build dependencies live here permanently, not merely as an
evictable cache. Verdaccio has no built-in cache eviction, so this is already
the default behavior — a tarball resolved once stays until someone deletes it.

- `ceph-block` (replica-3 RBD, survives node loss), 20Gi to start. The cluster
  has 487Gi of Ceph capacity available; 20Gi is deliberately generous for
  today's footprint (a handful of React/Vite/TypeScript frontends on a heavily
  overlapping dependency graph -- realistically low hundreds of MB) without
  committing a large slice of shared capacity up front. `ceph-block` has
  `allowVolumeExpansion: true` (confirmed live) — grow it later with a live
  `kubectl patch pvc` + `rollout restart`, same playbook as
  `platform-services/monitoring/tempo.yaml`'s PVC resize.
- Scheduling explicitly **excludes `capstone-w1`** (root filesystem at 92%) via a
  required `nodeAffinity` on `statefulset.yaml` — this is about which node's
  local disk/CPU/RAM the pod shares, not where the RBD bytes physically live
  (Ceph places those across OSDs independent of pod scheduling).

## Failure mode: must degrade, not block

**If this mirror is down, a build that points at it and nothing else is a
fleet-wide single point of failure** -- worse than the flakiness it replaces.
This service alone does not prevent that; it has to be paired with a fallback
at the CI call site:

- Point `NPM_CONFIG_REGISTRY`/`.npmrc` `registry` at the mirror as the
  **primary**, but the install step must retry against the **public registry
  directly** if the mirror is unreachable, not just retry the mirror. The
  install-retry loop already shipped in `.github/workflows/tenant-build.yaml`
  and the scaffolder template (this same PR) is the natural place for that
  second tier -- it already retries the whole install command; teaching it to
  flip `--registry` to `https://registry.npmjs.org` after exhausting the
  mirror-side attempts is the follow-up, not yet wired into any tenant.
- Until that fallback is wired in, **do not** point any tenant's `.npmrc` at
  this mirror -- an unwired tenant would trade "sometimes flaky" for
  "unavailable whenever this one pod is unavailable," which is a strictly worse
  trade. This PR ships the mirror itself; pointing tenants at it is a separate,
  sequenced PR per repo (see the top-level report for merge order).
- Verdaccio's own `uplinks.npmjs` settings (`max_fails`/`fail_timeout` in
  `configmap.yaml`) bound how long a flaky *upstream* (npmjs, not this mirror)
  is treated as down, so a bad patch of npmjs itself doesn't wedge every
  install through this mirror either.

## Verification

See the top-level task report for the live execution evidence (a real `npm ci`
against a tenant's `package-lock.json`, run from a pod in `arc-runners` against
this Service, in the actual cluster).
