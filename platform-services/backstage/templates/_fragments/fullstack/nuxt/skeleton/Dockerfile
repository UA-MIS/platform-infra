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
FROM node:22-alpine AS build
WORKDIR /src
ENV NUXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# ---- runtime stage (the self-contained Nitro server) ----
FROM node:22-alpine
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
