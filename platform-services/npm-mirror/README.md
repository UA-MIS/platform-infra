# npm-mirror

In-cluster Verdaccio proxy-cache for npm packages. Ships as the Part 2
permanent fix for the 2026-09-10 `npm ci` ETIMEDOUT incident (tenant Kaniko
builds intermittently stalling mid-download against the public npm
registry) -- the same architectural move `platform-services/harbor-dockerhub-proxy`
and `platform-services/harbor-mcr-proxy` already made for container images.

## Why Verdaccio

Lightweight, single-process, no external DB, first-class "uplink" proxy-cache
support that matches this platform's Harbor pull-through-cache pattern almost
exactly. Alternatives considered and rejected for this scale:

- **Nexus Repository / Artifactory** -- both are full multi-format artifact
  repositories (JVM-based, heavier to run and operate) aimed at orgs that
  need Maven/npm/PyPI/Docker/etc. all in one place. This platform has no
  other artifact-repo need today that would justify that operational surface.
- **A raw nginx cache in front of registry.npmjs.org** -- no package-aware
  storage or web UI, and it reinvents npm registry protocol handling that
  Verdaccio already implements correctly.

## Design

- **Namespace**: `npm-mirror`, one StatefulSet (replicas: 1), one PVC, one
  ClusterIP Service on port 4873, config via ConfigMap. Plain manifests
  (no Helm chart), matching the existing minio/dex/cloudflared/vault-unsealer
  pattern for single-workload platform services.
- **Storage**: a 50Gi `ceph-block` (Rook-Ceph RBD, replica-3) PVC --
  **permanent**, not ephemeral: this is deliberately a Ceph-backed volume, not
  a `local-hostpath`/emptyDir cache, per the owner's explicit directive that
  build dependencies belong on durable, shared storage ("THIS is where our
  storage is useful, not for tenant storage"). Ceph had 487Gi free at write
  time; 50Gi is sized for this platform's actual Node tenant footprint
  (five tenants x a few hundred packages each, plus scaffolder growth), not
  a full npm-registry mirror, leaving 10-20x headroom. `ceph-block` has
  `allowVolumeExpansion: true`, so this grows online if that assumption ever
  proves wrong. The StatefulSet pod is pinned away from `capstone-w1`
  (`nodeAffinity: NotIn capstone-w1`) per the owner's explicit note that
  w1's root filesystem is at 92% -- belt-and-suspenders, since Ceph OSDs are
  distributed and the PVC's data placement is not actually pinned to any one
  node's local disk regardless.
- **Fall-through for unseen packages**: every package pattern proxies to the
  `npmjs` uplink (`https://registry.npmjs.org/`) on a cache miss, so a
  package this mirror has never served resolves and gets cached
  transparently -- exactly like the Harbor dockerhub-proxy for images.
- **No publish surface**: `auth.htpasswd.max_users: -1` disables
  self-registration entirely, so there are no accounts and nobody can
  publish/unpublish through this instance -- it exists purely to cache the
  public registry, with zero new credentials to plumb into tenant CI (mirrors
  `harbor-dockerhub-proxy/project.yaml`'s `public: true` reasoning).

## Failure mode: not a build-blocking SPOF

If the `npm-mirror` pod is down (crash, reschedule, node drain), a build
pointed at it does not fail outright the moment that happens -- the retry
loop shipped in Part 1 (every tenant Dockerfile/CI install step: 4 attempts,
15/30/45s backoff, ~90s total) transparently rides out a routine pod restart,
since Kubernetes typically has a replacement Service endpoint back well
inside that window. A genuinely extended outage (node failure, PVC issue)
does turn into real build failures for any tenant whose `.npmrc` names this
registry, because there is no automatic client-side fallback to the public
registry once a tenant's config points here.

This is exactly why the Part 1 same-day tenant PRs (mychef, next-up,
curb-web, springais) do **not** flip `registry=` to this mirror. Today's
incident fix (the retry loop) stands on its own, working against the public
registry, so it can never be made worse by this instance's own availability.
Pointing tenants at the mirror is an explicit, separate **day-2 step** (see
Rollout below), taken only once this Application is confirmed Synced/Healthy
in-cluster.

Multi-replica HA is a documented future enhancement, not built now:
Verdaccio's included storage plugin is single-node by design (a local
filesystem tree on one RWO volume); real HA needs a shared backend (e.g. its
S3/Ceph-RGW storage plugin), which is more moving parts than this incident's
timeline justifies. Flagging as a follow-up rather than silently shipping a
single point of failure and calling it done.

## NetworkPolicy change -- stated explicitly, not silently widened

`arc-runners`' `allow-egress-scoped` policy
(`hardening/netpol-runners/runner-netpol.yaml`) needs a new rule so a build
pod can reach `npm-mirror.npm-mirror.svc.cluster.local:4873`. This PR adds
exactly one rule to that file, nothing else.

**Not** another port on the file's existing `ipBlock: 10.96.0.0/12` block
(the pattern used for 443/80/8443/8080/8200) -- a live finding from this
PR's own verification ruled that out. Adding `:4873` to that port list did
NOT admit traffic to the freshly-created npm-mirror pod, even though
`cilium endpoint get <id> -o json` showed the rule correctly compiled into
the endpoint's realized policy -- `hubble observe` showed the SYN still
`Policy denied DROPPED`. Swapping Verdaccio onto an ALREADY-allowed port
(8080, already used live by harbor-core) made no difference either, which
rules out a port-number explanation. Best-evidence read: Cilium's
CIDR-to-identity derivation for that ipBlock rule had already resolved
`10.96.0.0/12` against whichever backends existed when it was last
(re)compiled (harbor-core, Traefik, vault-unsealer -- all long-lived) and
does not pick up a brand-new backend on that same CIDR promptly -- the same
class of "CIDR-based selectors do not match in-cluster entities" gap that
file's own SEC-019 caveat already documents for the node-LAN/tailnet
excepts, just showing up here too.

The rule that actually works, verified immediately (no propagation delay) in
the same live test: a **separate, identity-based** egress rule --
`namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: npm-mirror}}`
scoped to TCP/4873 -- rather than another CIDR-based port. See the comment on
that rule in `hardening/netpol-runners/runner-netpol.yaml` for the full
finding, written there for whoever next adds an in-cluster destination to
this policy.

This does **not** take effect on merge: that policy file is the existing
MANUAL-SYNC Application (`applicationsets/arc-runner-netpol-app.yaml`,
`platform-netpol-runners`) by design -- merging only makes the new rule
present-and-tracked; an operator must run
`argocd app sync platform-netpol-runners` to actually apply it, same as
every other change to that file.

## Rollout (day-2, after this Application is Synced/Healthy)

1. Confirm the mirror is healthy: `kubectl -n npm-mirror get pods` Ready,
   and `curl http://npm-mirror.npm-mirror.svc.cluster.local:4873/-/ping`
   from any in-cluster pod returns `{}`.
2. Sync the netpol change above (`argocd app sync platform-netpol-runners`)
   and confirm a real tenant build still reaches the mirror from inside
   `arc-runners` (this PR already proved this exact path live -- see
   Verification).
3. Per tenant (mychef, next-up, curb-web, springais, ida-llm), add to
   `frontend/.npmrc`:
   ```
   registry=http://npm-mirror.npm-mirror.svc.cluster.local:4873/
   ```
   This is safe for tenants with an **existing** `package-lock.json`, not
   only fresh installs: modern npm (verified here on 10.9.8, default
   `replace-registry-host=npmjs`) transparently rewrites any `resolved` URL
   that targets the default `registry.npmjs.org` to whatever registry is
   currently configured, at fetch time -- the lockfile's `resolved` field on
   disk is untouched, but the actual tarball request goes to the mirror.
   Proven by execution (see Verification): a real `npm ci` against ida-llm's
   committed (pre-existing, registry.npmjs.org-resolved) lockfile, pointed at
   the mirror, fetched every tarball through it with zero lockfile changes.
4. Deliberately **not** done in this PR: flipping the tenants' own registry,
   or the scaffolder templates' default registry. This mirror is new and
   unproven-in-production; making it a hard dependency for every build on
   day one would trade today's known, bounded (retry-covered) failure mode
   for a new, less-understood one. Flip registries only after this
   Application has run Synced/Healthy for a while under real traffic.

## Verification (execution evidence, not just "the service answers")

All of the following were run against the **actual in-cluster deployment**
(not just a local container), from an unprivileged pod inside `arc-runners`
itself -- the same namespace, same netpol boundary, same node
(`capstone-w2`) as the real Kaniko builds this fixes:

- `GET /-/ping` from `arc-runners` -> HTTP 200 `{}`, through the
  namespaceSelector netpol rule above (confirmed both the pre-fix
  `ipBlock`-based attempt failing via `hubble observe` -- `Policy denied
  DROPPED` -- and the namespaceSelector fix succeeding immediately).
- A real `npm ci` from that same `arc-runners` pod, against
  `UA-MIS/ida-llm`'s actual, committed `frontend/package-lock.json` (419
  packages, including multi-MB native binaries like
  `@next/swc-linux-x64-gnu`/`-musl`, ~47MB each), through the mirror's
  `npmjs` uplink on a cold cache: **completed successfully end to end**
  (`added 418 packages... in 11s` on the warm re-run).
- **A real bug found and fixed by this same live test, not papered over**:
  the first cold-cache attempt failed with `npm error code ECONNRESET` /
  `network aborted`. Root-caused via the mirror pod's own logs + npm's debug
  log: one 47MB tarball (`@next/swc-linux-x64-musl`) took 102 seconds to
  fetch-and-stream even for this in-cluster, same-node client, and
  Verdaccio's `server.keepAliveTimeout: 60` (60s) closed the connection out
  from under that still-in-flight request, aborting the NEXT request queued
  on the same keep-alive socket. Fixed by setting `keepAliveTimeout: 0`
  (`configmap.yaml`, matches Verdaccio's own documented pre-Node-8 behavior)
  -- a registry whose whole job is absorbing slow/flaky transfers cannot
  itself impose a timeout shorter than the transfers it serves. Re-ran the
  identical `npm ci` after the fix: no ECONNRESET, clean install. (The
  102-second upstream fetch itself is a separate observation, not something
  this PR claims to fix -- it is consistent with this platform's
  already-known flaky egress-to-the-public-internet path; the mirror's value
  is that this cost is paid ONCE per package version, cluster-wide, instead
  of once per tenant build.)
