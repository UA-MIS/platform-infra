# syntax=docker/dockerfile:1
#
# ${{ values.appName }} image — Nuxt 3 fullstack (Vue pages + Nitro server API).
#
# Multi-stage: a Node (Alpine) builder runs `nuxt build` -> .output (a self-contained
# Nitro node-server with its dependencies traced/bundled in); a clean Node (Alpine)
# runtime runs that server. Built by the platform CI (Kaniko, rootless) on the
# self-hosted ARC runners — ONE image for this single component (see .devops/components.yaml).
#
# NO apt/apk at build time (Alpine + npm over HTTPS, and Drizzle/mysql2 are pure JS with no
# native build step), so it sidesteps the platform's :443-only runner egress + missing
# ca-certificates pitfalls — no openssl/apt bootstrap needed (unlike a Prisma image).
#
# RUNTIME: listens on $PORT (the chart sets PORT from this component's port in
# components.yaml; Nitro reads NITRO_PORT || PORT). Runs as non-root (uid 65532, matching
# the chart securityContext).

# ---- build stage (compile the Nuxt/Nitro server) ----
#
# B4: base images resolve through the platform's Harbor pull-through cache
# (dockerhub-proxy) instead of Docker Hub directly -- avoids Docker Hub rate
# limits across every team's CI, verified working end-to-end (cache-hit proof
# in artifacts/implementation/b4-harbor-proxy-cache.evidence.yaml). Same image,
# same tag, different registry host -- purely a pull-path change.
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/node:22-alpine AS build
WORKDIR /src
ENV NUXT_TELEMETRY_DISABLED=1
# node:22-alpine ships npm 10.9.8, which has a real, deterministic Arborist crash
# ("Cannot read properties of null (reading 'edgesOut')") on this fragment's exact
# dependency graph (nuxt 3.21 + drizzle-kit + drizzle-orm + mysql2 + vue-router) --
# reproduced identically in a real Kaniko build, in a bare `node:22-alpine` container
# with no other changes, AND via a plain local `npm install`, so it is not registry
# flakiness, not Kaniko-specific, and not caused by this file's `overrides` block
# (removing overrides alone does NOT fix it -- verified). npm 11+ does not hit this
# bug on the identical dependency tree (verified: install succeeds, `npm run build`
# succeeds, same package count). Pinned exact (project convention: pin all versions)
# rather than a floating `npm@11` or `npm@latest`, which would silently start
# pulling npm 12+ (already GA per this build's own upgrade notice) with unverified
# behavior on this graph.
RUN npm install -g npm@11.19.0
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# ---- runtime stage (the self-contained Nitro server) ----
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NUXT_TELEMETRY_DISABLED=1 \
    PORT=${{ values.port }} \
    HOST=0.0.0.0
COPY --from=build --chown=65532:65532 /src/.output ./.output

# Run as a non-root UID (matches the chart securityContext runAsUser: 65532).
USER 65532:65532

# Documentation only — the real port is $PORT (chart containerPort = components.yaml `port`).
EXPOSE 8080
CMD ["node", ".output/server/index.mjs"]
