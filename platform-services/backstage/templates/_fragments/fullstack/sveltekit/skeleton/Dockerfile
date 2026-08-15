# syntax=docker/dockerfile:1
#
# ${{ values.appName }} image — SvelteKit fullstack (Svelte routes + server endpoints),
# built with adapter-node.
#
# Multi-stage: a Node (Alpine) builder runs `vite build` -> ./build (the adapter-node
# server); a deps stage installs ONLY production deps; a clean Node (Alpine) runtime runs
# the server. Built by the platform CI (Kaniko, rootless) on the self-hosted ARC runners —
# ONE image for this single component (see .devops/components.yaml).
#
# NO apt/apk at build time (Alpine + npm over HTTPS, and Drizzle/mysql2 are pure JS with no
# native build step), so it sidesteps the platform's :443-only runner egress + missing
# ca-certificates pitfalls — no openssl/apt bootstrap needed (unlike a Prisma image).
#
# RUNTIME: listens on $PORT (the chart sets PORT from this component's port in
# components.yaml; adapter-node reads PORT + HOST). Runs as non-root (uid 65532, matching
# the chart securityContext).

# ---- build stage (compile the SvelteKit/adapter-node server) ----
#
# B4: base images resolve through the platform's Harbor pull-through cache
# (dockerhub-proxy) instead of Docker Hub directly -- avoids Docker Hub rate
# limits across every team's CI, verified working end-to-end (cache-hit proof
# in artifacts/implementation/b4-harbor-proxy-cache.evidence.yaml). Same image,
# same tag, different registry host -- purely a pull-path change.
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# ---- deps stage (production node_modules only) ----
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/node:22-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---- runtime stage ----
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=${{ values.port }} \
    HOST=0.0.0.0
COPY --from=deps --chown=65532:65532 /src/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /src/build ./build
COPY --from=build --chown=65532:65532 /src/package.json ./package.json

# Run as a non-root UID (matches the chart securityContext runAsUser: 65532).
USER 65532:65532

# Documentation only — the real port is $PORT (chart containerPort = components.yaml `port`).
EXPOSE 8080
CMD ["node", "build"]
