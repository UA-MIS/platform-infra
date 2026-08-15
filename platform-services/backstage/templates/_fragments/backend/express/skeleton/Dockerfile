# syntax=docker/dockerfile:1
#
# ${{ values.appName }} BACKEND image (build context: ./backend).
#
# Node/Express + TypeScript API, compiled to JS. Multi-stage: a Node (Alpine) builder runs
# `tsc` -> /dist; a separate stage installs ONLY production deps; a clean Node (Alpine)
# runtime runs the compiled server. Built by the platform CI (Kaniko, rootless) on the
# self-hosted ARC runners — ONE image per component (see .devops/components.yaml).
#
# NO apt/apk at build time (Alpine + npm over HTTPS), so it sidesteps the platform's
# :443-only runner egress + missing-ca-certificates pitfalls (no apt bootstrap needed). If
# you switch to a Debian-family base that runs apt, see the apt-over-HTTPS note in
# docs/index.md.
#
# RUNTIME: listens on $PORT (the chart sets PORT from this component's port in
# components.yaml). Runs as non-root (uid 65532, matching the chart securityContext) under
# readOnlyRootFilesystem — Node needs no writable rootfs; the MySQL pool is network-only.

# ---- build stage (compile TypeScript) ----
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

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
COPY --from=build /src/dist ./dist
COPY package.json ./

# Run as a non-root UID (matches the chart securityContext runAsUser: 65532).
USER 65532:65532

# Documentation only — the real port is $PORT (chart containerPort = components.yaml `port`).
EXPOSE 8080
CMD ["node", "dist/index.js"]
