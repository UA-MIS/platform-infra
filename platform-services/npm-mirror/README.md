# npm-mirror — in-cluster npm registry mirror (Verdaccio)

The same move this fleet already made for container images
(`harbor-dockerhub-proxy`, `harbor-mcr-proxy`): stop hitting the public origin
on every CI build, cache it once, in-cluster. This exists because of
UA-MIS/mychef run 34420522887 — `npm error network read ETIMEDOUT` (errno
-110) inside a Kaniko build — and its siblings (mychef#13, next-up#28,
curb-web#22, springais#12, platform-infra#639/#640), which harden `npm ci`
against that failure with retry loops. Retrying survives a *transient* stall;
this mirror is the other half — it reduces how often a tenant build depends on
the public registry answering at all.

## Why Verdaccio

A single lightweight Node.js process with no external DB dependency, an
official Docker image, and a large, actively-maintained install base as the
de-facto standard lightweight npm proxy. Nexus/Artifactory both want their own
Postgres and a materially bigger footprint for a job this platform only needs
done for one registry — same "smallest thing that does the job" reasoning as
`harbor-dockerhub-proxy`/`harbor-mcr-proxy` over a heavier alternative.

## Why port 8080, not Verdaccio's default 4873

`hardening/netpol-runners/runner-netpol.yaml`'s `allow-egress-scoped` policy
already permits `arc-runners` egress into `10.96.0.0/12` (in-cluster services)
on `443/80/8443/8080/8200` — and nothing else. Running Verdaccio on 8080
(via the `VERDACCIO_PORT` env var — the config file's `listen:` directive is
**documented-ignored under Docker**, verified against a live container) means
**no netpol change is required at all**. The brief for this work was explicit
that a port outside that list needed the change stated explicitly rather than
widened quietly; the better answer was not needing a wider netpol in the first
place.

## Storage: permanent, not merely cached

Explicit owner directive: build dependencies belong on Ceph, permanently —
"THIS is where our storage is useful, not for tenant storage." So this ships
a real `ceph-block` PVC via `volumeClaimTemplates` (RWO, replica-3), not an
`emptyDir` or anything a reschedule could silently discard.

- **30Gi to start.** Ceph had 487Gi free and `HEALTH_OK` at write time, shared
  by the whole platform. A verification install of one real tenant's frontend
  dependency tree (UA-MIS/mychef, ~90 packages) cached ~190MB. 30Gi is
  generous headroom for this fleet's actual scale (a handful of tenant
  frontends plus a semester of student CI installs) without reserving
  capacity nobody needs yet.
- **Not node-pinned.** Deliberately NOT `hostPath`/`local-path` (which would
  tie this to one node's root disk — `capstone-w1` is explicitly off-limits,
  92% full). `ceph-block` is cluster-wide, so this PVC's placement is
  unaffected by which node the pod lands on.
- **Expandable online.** `ceph-block` has `allowVolumeExpansion: true`
  (confirmed in `applicationsets/rook-ceph-cluster-app.yaml`) — growing this
  later is a PVC edit, not a rebuild.

## Degrade, not block

**If this pod is down or unreachable, today: nothing happens to any tenant
build.** This PR ships the mirror itself; it does **not** repoint any
tenant's `.npmrc`/`NPM_CONFIG_REGISTRY` at it. Wiring consumers is a
deliberate, separate follow-up, after this is confirmed `Synced`/`Healthy` in
the real cluster — the same sequencing this fleet already used for
`harbor-dockerhub-proxy`/`harbor-mcr-proxy` (declare + verify, then a later,
separate PR repoints Dockerfiles). Shipping the mirror and the rewire in one
change would make a single new pod a fleet-wide single point of failure on
day one; this way, a broken or not-yet-live mirror has **zero** blast radius
until something is actually told to depend on it.

When a follow-up does wire a tenant to this mirror, the recommended shape
(not implemented here) is: point at the mirror first, and on the SAME
exhaustion path the retry loops in mychef#13/next-up#28/curb-web#22/
springais#12/platform-infra#639/#640 already use, fall back to
`https://registry.npmjs.org/` directly before giving up — so "mirror down"
degrades to "exactly as flaky as before this existed," never to a new hard
failure the tenant didn't have yesterday.

Independently of that: a package this mirror has **never** cached still
needs the `npmjs` uplink to resolve (`uplinks.npmjs.cache: true` in
`configmap.yaml`) — if `registry.npmjs.org` itself is down, that install
fails the same way it would with no mirror at all. This is a cache, not a
registry replacement.

## Read-only by design

`auth.htpasswd.max_users: -1` disables new registrations; every package rule
still requires `$authenticated` to publish/unpublish. With registration off
and no user seeded, publish/unpublish are unreachable in practice — this
instance only ever serves the public registry through to CI, it never accepts
uploads. That also closes the obvious dependency-confusion angle (nobody can
shadow a real package name with their own upload here).

## What is here

| File | What |
|---|---|
| `namespace.yaml` | dedicated `npm-mirror` namespace, Goldilocks recommend-only |
| `configmap.yaml` | Verdaccio `config.yaml` — storage path, `npmjs` uplink, package access rules |
| `statefulset.yaml` | single-replica StatefulSet (`ceph-block` PVC via `volumeClaimTemplates`) + ClusterIP Service |
| `netpol.yaml` | default-deny + arc-runners-only ingress on 8080 + DNS/443-egress for the uplink |

## NetworkPolicy: auto-synced here, not the manual control-plane gate

`hardening/netpol-controlplane/`'s default-deny rollouts are deliberately
**manual-sync** for already-LIVE, sensitive namespaces (argocd/dex/harbor/
vault/minio) — a fresh default-deny landing on real live traffic needs a
watched sync. `npm-mirror` is a brand-new namespace with no live traffic, so
that risk doesn't apply — same reasoning `platform-services/lab-db/netpol.yaml`
used for its own brand-new pods. Shipping default-deny here rides the normal
**automated** `platform-services-appset` sync, no separate manual step for an
operator to remember.

## Verification

Real `npm install`/`npm ci` proven through a live Verdaccio instance, not
just an HTTP health check:

- `verdaccio/verdaccio:5` run locally (via `harbor.capstone.uamishub.com/
  dockerhub-proxy/verdaccio/verdaccio:5`, digest-matched against Docker Hub's
  own digest for the tag), `VERDACCIO_PORT=8080`.
- `/-/ping` (Verdaccio's implementation of the standard npm registry ping
  route) confirmed live — `200`, not assumed from docs.
- A `node:22-alpine` container (pulled through the same Harbor proxy every
  tenant Dockerfile uses) on the same Docker network, pointed at the mirror
  by **service name** (`http://verdaccio-net:8080/`) — the same reachability
  shape a Kaniko build gets in-cluster — ran a real install against
  UA-MIS/mychef's actual `frontend/package.json`: **91 packages installed,
  exit 0**, entirely through the mirror's `npmjs` uplink fallthrough (the
  mirror started empty).
- Cache confirmed on disk: `192.7MB` written to `/verdaccio/storage/data`
  after that one install.
- A second install of the same dependency set completed in ~53s versus the
  first cold install's ~2m — a real, if not dramatically isolated (shared
  sandbox CPU), speedup consistent with serving from cache rather than
  re-fetching from `registry.npmjs.org` every time.

## Known gap, not fixed here

Kyverno image-verification is worth checking against this image before
relying on it further (out of scope for this PR — raised separately with the
platform owner).
