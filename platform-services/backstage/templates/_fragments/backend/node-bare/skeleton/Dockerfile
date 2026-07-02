# syntax=docker/dockerfile:1
#
# ${{ values.appName }} BACKEND image (build context: ./backend).
#
# Bare Node.js http server (no framework, no build step — plain JS). Multi-stage anyway:
# a deps stage installs ONLY production deps (mysql2) so the toolchain/cache never reaches
# the runtime; a clean Node (Alpine) runtime runs the server. Built by the platform CI
# (Kaniko, rootless) on the self-hosted ARC runners — ONE image per component.
#
# NO apt/apk at build time (Alpine + npm over HTTPS), so it sidesteps the platform's
# :443-only runner egress + missing-ca-certificates pitfalls. If you switch to a
# Debian-family base that runs apt, see the apt-over-HTTPS note in docs/index.md.
#
# RUNTIME: listens on $PORT (the chart sets PORT from this component's port in
# components.yaml). Runs as non-root (uid 65532, matching the chart securityContext) under
# readOnlyRootFilesystem — Node needs no writable rootfs; the MySQL pool is network-only.

# ---- deps stage (production node_modules only) ----
FROM node:22-alpine AS deps
WORKDIR /src
COPY package.json ./
RUN npm install --omit=dev

# ---- runtime stage ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /src/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Run as a non-root UID (matches the chart securityContext runAsUser: 65532).
USER 65532:65532

# Documentation only — the real port is $PORT (chart containerPort = components.yaml `port`).
EXPOSE 8080
CMD ["node", "src/server.js"]
