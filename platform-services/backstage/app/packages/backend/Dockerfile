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

# Stage 1 — yarn install skeleton layer (just the package.json files for cache stability).
FROM node:24-trixie-slim AS packages

WORKDIR /app
COPY backstage.json package.json yarn.lock ./
COPY .yarn ./.yarn
COPY .yarnrc.yml ./

COPY packages packages

# Keep only package.json under each package dir so the install layer is cache-stable.
RUN find packages \! -name "package.json" -mindepth 2 -maxdepth 2 -exec rm -rf {} \+

# Stage 2 — install all deps and build the backend bundle.
FROM node:24-trixie-slim AS build

# node-gyp toolchain (isolated-vm for the scaffolder + better-sqlite3).
ENV PYTHON=/usr/bin/python3
RUN apt-get update && \
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
FROM node:24-trixie-slim

ENV PYTHON=/usr/bin/python3
RUN apt-get update && \
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
