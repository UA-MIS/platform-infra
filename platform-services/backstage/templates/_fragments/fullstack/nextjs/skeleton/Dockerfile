# syntax=docker/dockerfile:1
#
# Multi-stage build for a Next.js (App Router) app in `output: 'standalone'` mode +
# Prisma (MySQL). Built by the platform CI (Kaniko, rootless) on the self-hosted ARC
# runners; the build context is THIS dir (.devops/ci resolves single-component as
# context=app, dockerfile=Dockerfile). Stages: deps -> build -> minimal non-root
# runtime. Keep it rootless + minimal.
#
#   deps     install node_modules (+ prisma generate via postinstall, cache-friendly)
#   build    prisma generate + next build -> .next/standalone (self-contained server)
#   runtime  the standalone server.js on a slim, non-root image listening on $PORT

# B4: resolves through the platform's Harbor pull-through cache (dockerhub-proxy)
# instead of Docker Hub directly -- avoids Docker Hub rate limits across every
# team's CI, verified working end-to-end (cache-hit proof in
# artifacts/implementation/b4-harbor-proxy-cache.evidence.yaml). Same image, same
# tag, different registry host -- purely a pull-path change.
ARG NODE_IMAGE=harbor.capstone.uamishub.com/dockerhub-proxy/library/node:22-bookworm-slim

# ---- deps: install dependencies (cached unless package.json / schema change) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json* ./
# Schema is copied here too so @prisma/client's postinstall can generate the client.
COPY prisma ./prisma
RUN npm ci || npm install

# ---- build: generate the Prisma client + compile Next in standalone mode ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `npm run build` = `prisma generate && next build` (see package.json). No DATABASE_URL
# is needed at build time: pages that touch the DB are `export const dynamic =
# 'force-dynamic'`, so nothing connects to MySQL during the build.
RUN npm run build

# ---- migrator: a self-contained, PINNED Prisma CLI for `prisma migrate deploy` ----
# WHY a dedicated toolchain: `next build`'s standalone output only traces the node_modules
# subset that `server.js` imports — the Prisma CLI is NOT among them, so migrations need
# their own copy. We build a closed, PINNED v6 CLI tree here; the chart's migration
# initContainer runs it (see .devops/chart/base/deployments.yaml, and the `migrate:` entry
# in .devops/components.yaml that selects this command). We NEVER call
# `npx prisma` at runtime: npx resolves to the LATEST prisma (v7), which dropped
# `url = env(...)` in schema.prisma — it now demands a prisma.config.ts loaded through
# `jiti` — and would fail this v6 schema with `Cannot find module 'jiti'`. A pinned v6 CLI
# reads the datasource url straight from schema.prisma (verified: `prisma validate` passes
# and `migrate deploy` reaches the DB).
FROM ${NODE_IMAGE} AS migrator
WORKDIR /prisma-cli
ENV NEXT_TELEMETRY_DISABLED=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
# OpenSSL MUST be installed BEFORE `npm install prisma`: prisma's postinstall selects the
# engine build from the libssl it detects. Debian-slim ships NO openssl, so prisma would
# default to the openssl-1.1.x engines, which then FAIL to load at runtime on bookworm
# (libssl.so.3) with `libssl.so.1.1: cannot open shared object file`. Installing openssl
# first makes prisma detect OpenSSL 3.x and fetch the debian-openssl-3.0.x engines. Same
# proven apt-over-:443 bootstrap as the runtime stage (ARC runner egress is :443 ONLY,
# SEC-014; slim Debian has no ca bundle, so the first HTTPS fetch runs peer-verify OFF).
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    apt-get -o Acquire::https::Verify-Peer=false update && \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
    apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*
# Pin the CLI to the same MAJOR as @prisma/client in package.json (v6). Keep it v6.x — do
# NOT bump to v7 without also adding a prisma.config.ts (see the WHY note above).
ARG PRISMA_VERSION=6.2.1
RUN npm init -y >/dev/null && \
    npm install --omit=dev --no-audit --no-fund "prisma@${PRISMA_VERSION}"
# schema.prisma + prisma/migrations from THIS component's source (build context = the app
# dir). Migrations a team later creates with `prisma migrate dev` flow through on the next
# build. An initial migration is shipped so the sample schema applies out of the box.
COPY prisma ./prisma

# ---- runtime: the standalone server on a slim, non-root image ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=${{ values.port }} \
    HOSTNAME=0.0.0.0

# Prisma's query engine needs the OpenSSL runtime library; ca-certificates is needed
# for TLS to your MySQL host. Install them over HTTPS using the platform's proven
# apt-over-:443 bootstrap: the ARC runner egress allows external :443 ONLY (no :80,
# SEC-014) and slim Debian ships no ca-certificates bundle (so the first HTTPS fetch
# can't verify its cert — bootstrap with peer-verify OFF for that one fetch, then
# verify normally). This is the exact, proven block from the platform's own images.
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    apt-get -o Acquire::https::Verify-Peer=false update && \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
    apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

# Run as a non-root UID (distroless "nonroot" convention; matches the .devops
# Deployment securityContext runAsUser: 65532). next build's standalone output is a
# self-contained server.js + the traced node_modules subset; static assets + public/
# are copied alongside it.
COPY --from=build --chown=65532:65532 /app/.next/standalone ./
COPY --from=build --chown=65532:65532 /app/.next/static ./.next/static
COPY --from=build --chown=65532:65532 /app/public ./public
# Belt-and-suspenders for Prisma in standalone: ensure the generated client + query
# engine are present in the runtime node_modules (next traces them, but copy explicitly).
COPY --from=build --chown=65532:65532 /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=65532:65532 /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build --chown=65532:65532 /app/prisma ./prisma
# The self-contained, pinned Prisma CLI (+ this app's schema & migrations) that the chart's
# migration initContainer runs (`node /app/prisma-cli/node_modules/prisma/build/index.js
# migrate deploy`). It sits OUTSIDE the app's runtime path — server.js never loads it.
COPY --from=migrator --chown=65532:65532 /prisma-cli ./prisma-cli

USER 65532:65532
EXPOSE ${{ values.port }}

# The standalone server listens on $PORT / $HOSTNAME (set above; the .devops
# Deployment also sets PORT + HOSTNAME). Locally: `PORT=3000 node server.js`.
CMD ["node", "server.js"]
