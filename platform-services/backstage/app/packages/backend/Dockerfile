# Multi-stage Dockerfile for "The Process" Backstage backend.
#
# WHY MULTI-STAGE (not the default create-app host build): the in-platform image loop
# (ADR-029 §3) builds with Kaniko on the ARC runners, which only PACKAGES an existing
# context — it cannot run `yarn install && yarn tsc && yarn build:backend` for you the way
# a host build assumes. This Dockerfile does the full build INSIDE the image, so the build
# is self-contained: `kaniko --context=platform-services/backstage/app
# --dockerfile=platform-services/backstage/app/packages/backend/Dockerfile` is a single
# invocation with no host pre-build step.
#
# KANIKO NOTES: no BuildKit `RUN --mount=type=cache` (Kaniko does not support cache mounts);
# the build context root is the monorepo (`platform-services/backstage/app`), not
# packages/backend (the COPY paths are relative to that root).
#
# Build context = the Backstage monorepo root. Based on the official multi-stage reference:
# https://backstage.io/docs/deployment/docker#multi-stage-build

# Pinned base image: explicit registry + digest (reproducible, dodges tag drift; Kaniko
# pulls it from docker.io over :443 — we do not mirror base images to Harbor). Bump the
# digest deliberately when moving Node patch levels.
#
# PINNED TO 24.16 (NOT the floating `24` tag) — DELIBERATE: Node 24.17's CVE-2026-48931
# keep-alive socket fix breaks @backstage/catalog-client's localhost fetches with
# "Invalid response body ... http://localhost:7007/api/catalog/...: Premature close",
# which made the OIDC sign-in resolver's catalog lookup fail → infinite sign-in loop
# (Backstage issue #34651). The earlier floating `24-trixie-slim` digest resolved to 24.17+
# and shipped that regression in the M2 image. 24.16-trixie-slim is the last pre-patch 24.x.
# (24.16 keeps us on Node 24 per engines "22 || 24"; revisit once Backstage ships the
# node-fetch keepAlive fix, then we can move back to a current 24.x.)
# node:24.16-trixie-slim manifest-list digest, resolved 2026-06-19.
ARG NODE_IMAGE=docker.io/library/node:24.16-trixie-slim@sha256:45fbb3ca3b6c7e6646cd2889d0ac7bf314bb180036da792221fc2f48fe4d43fb

# Stage 1 — yarn install skeleton layer (just the package.json files for cache stability).
FROM ${NODE_IMAGE} AS packages

WORKDIR /app
COPY backstage.json package.json yarn.lock ./
COPY .yarn ./.yarn
COPY .yarnrc.yml ./

COPY packages packages
# M3: the root workspaces glob is ["packages/*", "plugins/*"], and packages/{app,backend}
# now depend on the local @internal/* plugin workspaces via `workspace:^`. The skeleton
# install resolves those workspace refs, so plugins/ MUST be copied here too — otherwise
# `yarn install --immutable` fails with "Workspace not found" (the M1/M2 image had no
# plugins/ so this line is new for M3).
COPY plugins plugins

# Keep only package.json under each package/plugin dir so the install layer is cache-stable.
RUN find packages plugins \! -name "package.json" -mindepth 2 -maxdepth 2 -exec rm -rf {} \+

# Stage 2 — install all deps and build the backend bundle.
FROM ${NODE_IMAGE} AS build

# node-gyp toolchain (isolated-vm for the scaffolder + better-sqlite3).
# Force apt over HTTPS (:443): the ARC runner egress netpol allows external :443 ONLY (no
# external :80, SEC-014 port-scoping) — Debian apt defaults to http://deb… (:80), which
# breaks the moment platform-netpol-runners syncs. So rewrite the deb822 sources to https.
# CHICKEN-AND-EGG: node:*-trixie-slim ships NO ca-certificates bundle, so the very first
# https fetch can't verify the (legit Let's Encrypt) Fastly cert. Bootstrap with peer-verify
# OFF for that one update, install ca-certificates, then ALL later layers verify normally.
# This stays :443-only (netpol-compliant); apt still verifies package integrity via the
# Signed-By GPG keyring independently of TLS, so the bootstrap is safe.
ENV PYTHON=/usr/bin/python3
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    apt-get -o Acquire::https::Verify-Peer=false update && \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 g++ build-essential libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /app

COPY --from=packages --chown=node:node /app .

RUN yarn install --immutable

COPY --chown=node:node . .

RUN yarn tsc
RUN yarn --cwd packages/backend build

# Unpack the produced skeleton + bundle for the production stage.
RUN mkdir packages/backend/dist/skeleton packages/backend/dist/bundle \
    && tar xzf packages/backend/dist/skeleton.tar.gz -C packages/backend/dist/skeleton \
    && tar xzf packages/backend/dist/bundle.tar.gz -C packages/backend/dist/bundle

# HARDENING (2026-07, vuln scan): produce the PRODUCTION-only node_modules HERE, in the
# build stage, where the node-gyp toolchain is already installed above — instead of in the
# runtime stage (see that stage's comment for why). `yarn workspaces focus --all
# --production` prunes the EXISTING install (from `yarn install --immutable` above) down to
# production dependencies only; it does not re-fetch or recompile anything already
# resolved — it just removes the devDependency-only packages. That means the native addons
# (better-sqlite3, isolated-vm) that got compiled during `yarn install --immutable` are left
# untouched on disk, compiled binaries and all. The runtime stage below COPYs this tree
# verbatim rather than re-running a fresh install there, which is what used to force a
# second toolchain install (and therefore build-essential -> perl/libc6-dev) into the
# shipped image. Both stages share the exact same NODE_IMAGE digest, so the compiled .node
# binaries stay ABI-compatible when copied across.
RUN yarn workspaces focus --all --production && rm -rf "$(yarn cache clean)"

# Stage 2b — kubeseal binary (M3, plan §2.1). The `capstone:seal-secret` scaffolder action
# shells out to `kubeseal` to seal team secrets OFFLINE against the exported public cert
# (D-047 A2 — no controller egress). We bundle the OFFICIAL, version-matched binary rather
# than reimplement the sealing crypto in TS (a wrong impl yields a SealedSecret the controller
# silently won't decrypt). PINNED to v0.37.0 — the SAME version as the in-cluster
# sealed-secrets controller (ADR-029 §11.5); a kubeseal/controller skew can produce
# undecryptable secrets, so this MUST track the controller version.
#
# Isolated single-purpose stage: only the download + checksum gate run here, so it is cache-
# stable (independent of the Node build) and the runtime image COPYs just the verified binary.
# SECURITY: the download is checksum-verified against the sha256 published in the official
# sealed-secrets_0.37.0_checksums.txt — `sha256sum -c` FAILS THE BUILD on any mismatch
# (supply-chain integrity). Fetch is over :443 only (netpol-compliant, SEC-014), same as the
# base-image pull; we do not mirror it to Harbor. ca-certificates bootstrap mirrors the build
# stage (the slim base ships no CA bundle, runner egress is :443-only).
FROM ${NODE_IMAGE} AS kubeseal
ARG KUBESEAL_VERSION=0.37.0
# linux-amd64 tarball sha256 from sealed-secrets_0.37.0_checksums.txt (verified against the
# downloaded artifact). Bump BOTH the version and this digest together when tracking a new
# controller version.
ARG KUBESEAL_SHA256=dd598209cc8b8398ce3234487609f5ba31f963a4547e8561f10739cb66a75262
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    apt-get -o Acquire::https::Verify-Peer=false update && \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/* && \
    curl -fsSL -o /tmp/kubeseal.tar.gz \
      "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz" && \
    echo "${KUBESEAL_SHA256}  /tmp/kubeseal.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/kubeseal.tar.gz -C /tmp kubeseal && \
    install -o root -g root -m 0755 /tmp/kubeseal /usr/local/bin/kubeseal && \
    rm -f /tmp/kubeseal.tar.gz /tmp/kubeseal && \
    kubeseal --version

# Stage 3 — the runtime image: production deps + the bundle only.
FROM ${NODE_IMAGE}

# HARDENING (removes all 9 Critical CVEs at the root — vuln scan 2026-07-07): this stage
# used to install the node-gyp toolchain (python3 g++ build-essential libsqlite3-dev) here
# and re-run `yarn workspaces focus --all --production`, which recompiled better-sqlite3 and
# isolated-vm FROM SOURCE in this slim runtime image. build-essential transitively pulls in
# perl/libperl5.40/perl-modules-5.40 (CVE-2026-42496, CVE-2026-8376) and libc6-dev ->
# linux-libc-dev (CVE-2026-43185) — none upstream-fixable, and none of it needed by a
# production Backstage backend. Fix: the production node_modules — already pruned AND
# compiled — is produced in the build stage (where the toolchain lives for the tsc/backend
# build anyway) and COPYed in verbatim below. No toolchain, no recompile, in this stage.
# better-sqlite3 bundles its own SQLite amalgamation, so libsqlite3-dev was never a runtime
# need either.
#
# What's left here is just the apt-over-HTTPS rewrite + ca-certificates bootstrap (runner
# egress is :443-only, SEC-014; the slim base ships no CA bundle) — the backend itself needs
# the CA bundle at runtime for outbound HTTPS (GitHub App / OIDC / catalog calls), so this
# part stays. See the build-stage comment for the bootstrap mechanics.
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    apt-get -o Acquire::https::Verify-Peer=false update && \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# M3: the version-pinned, checksum-verified kubeseal binary (from the isolated kubeseal
# stage). root-owned 0755 so the least-privileged `node` user can execute but not modify it;
# the `capstone:seal-secret` action invokes it via execFile (plan §2.1). Static Go binary,
# no runtime deps.
COPY --from=kubeseal /usr/local/bin/kubeseal /usr/local/bin/kubeseal

# Least-privileged node user.
USER node
WORKDIR /app

ENV NODE_ENV=production
# Disable the Node snapshot so the scaffolder's isolated-vm works, AND load the
# OpenTelemetry auto-instrumentation register hook before the backend bundle starts
# (OBSERVABILITY / traces first-producer, ADR-032). The register entrypoint reads ALL
# of its config from OTEL_* env vars (exporter, endpoint, service name, sampler), which
# the Helm values inject at deploy time (applicationsets/backstage-process-app.yaml
# backstage.extraEnvVars) — so WHERE spans go and HOW MUCH is sampled is tunable with
# no rebuild; only toggling instrumentation on/off touches this line. require-in-the-
# middle patches the real node_modules (Backstage does NOT bundle its deps — it ships a
# skeleton + `yarn workspaces focus --production`, so the http/pg/express libs stay
# require()'d and are patchable). Baked here (not in Helm NODE_OPTIONS) so it can COEXIST
# with --no-node-snapshot: a Helm-set NODE_OPTIONS would REPLACE this value wholesale and
# silently drop --no-node-snapshot, breaking the scaffolder's isolated-vm.
ENV NODE_OPTIONS="--no-node-snapshot --require @opentelemetry/auto-instrumentations-node/register"

# Manifests (yarn.lock + root package.json + each workspace package.json from the skeleton
# tarball). No yarn command runs in this stage anymore (see HARDENING note above) — these
# are kept as static files so the workspace-local node_modules symlinks copied in below
# (node_modules/backend, node_modules/app, node_modules/@internal/*) still resolve to a real
# package.json on disk, and so backstage.json is present for the About-page version display.
COPY --from=build --chown=node:node /app/.yarn ./.yarn
COPY --from=build --chown=node:node /app/.yarnrc.yml /app/backstage.json ./
COPY --from=build --chown=node:node /app/yarn.lock /app/package.json /app/packages/backend/dist/skeleton/ ./

# The production node_modules — already pruned to production-only AND already built (native
# addons compiled) in the build stage, where the toolchain exists. Straight COPY, no
# install/recompile here. See the HARDENING note above.
COPY --from=build --chown=node:node /app/node_modules ./node_modules

# The examples are referenced by the baked app-config catalog.locations (M1 seed data).
COPY --from=build --chown=node:node /app/examples ./examples

# The built backend bundle + the baked app-config files.
COPY --from=build --chown=node:node /app/packages/backend/dist/bundle/ ./
COPY --from=build --chown=node:node /app/app-config*.yaml ./

CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
