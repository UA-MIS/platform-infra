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
# digest deliberately when moving Node patch levels. node:24-trixie-slim as of 2026-06-19.
ARG NODE_IMAGE=docker.io/library/node:24-trixie-slim@sha256:287c662bed62f3c7b68ea68544814eaff9d7ed2254d2fc9627f2df5957bb7401

# Stage 1 — yarn install skeleton layer (just the package.json files for cache stability).
FROM ${NODE_IMAGE} AS packages

WORKDIR /app
COPY backstage.json package.json yarn.lock ./
COPY .yarn ./.yarn
COPY .yarnrc.yml ./

COPY packages packages

# Keep only package.json under each package dir so the install layer is cache-stable.
RUN find packages \! -name "package.json" -mindepth 2 -maxdepth 2 -exec rm -rf {} \+

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

# Stage 3 — the runtime image: production deps + the bundle only.
FROM ${NODE_IMAGE}

# Same apt-over-HTTPS rewrite + ca-certificates bootstrap as the build stage (runner egress
# is :443-only, SEC-014; the slim base ships no CA bundle). See the build-stage comment.
ENV PYTHON=/usr/bin/python3
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    apt-get -o Acquire::https::Verify-Peer=false update && \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 g++ build-essential libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

# Least-privileged node user.
USER node
WORKDIR /app

ENV NODE_ENV=production
# Disable the Node snapshot so the scaffolder's isolated-vm works.
ENV NODE_OPTIONS="--no-node-snapshot"

# Copy the install skeleton (yarn.lock + root package.json + each workspace package.json),
# then install production-only deps. The skeleton tarball holds only packages/*/package.json,
# so yarn.lock + the root package.json must be copied alongside it for the focus install.
COPY --from=build --chown=node:node /app/.yarn ./.yarn
COPY --from=build --chown=node:node /app/.yarnrc.yml /app/backstage.json ./
COPY --from=build --chown=node:node /app/yarn.lock /app/package.json /app/packages/backend/dist/skeleton/ ./
RUN yarn workspaces focus --all --production && rm -rf "$(yarn cache clean)"

# The examples are referenced by the baked app-config catalog.locations (M1 seed data).
COPY --from=build --chown=node:node /app/examples ./examples

# The built backend bundle + the baked app-config files.
COPY --from=build --chown=node:node /app/packages/backend/dist/bundle/ ./
COPY --from=build --chown=node:node /app/app-config*.yaml ./

CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
