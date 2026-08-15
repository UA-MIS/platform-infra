# syntax=docker/dockerfile:1
#
# Multi-stage build for a static SPA: stage 1 builds the Vite app to /app/dist with
# Node; stage 2 serves those static files with nginx. The runtime image contains ZERO
# Node/build tooling — just nginx + the compiled assets — so it is tiny and has a small
# attack surface. Built by the platform CI (Kaniko, rootless) on the self-hosted ARC
# runners. (90% of org repos ship without a working Dockerfile — this one is known-good.)

# ---- build stage ----
# Pinned Node LTS on Alpine. Vite + Tailwind v4 build here; nothing from this stage
# reaches the runtime image except the compiled ./dist.
#
# B4: base images resolve through the platform's Harbor pull-through cache
# (dockerhub-proxy) instead of Docker Hub directly -- avoids Docker Hub rate
# limits across every team's CI, verified working end-to-end (cache-hit proof
# in artifacts/implementation/b4-harbor-proxy-cache.evidence.yaml). Same image,
# same tag, different registry host -- purely a pull-path change.
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/node:22-alpine AS build
WORKDIR /app

# Install deps first (better layer caching). Use `npm ci` when a lockfile is present
# (reproducible); fall back to `npm install` for a freshly-scaffolded repo that has not
# committed a package-lock.json yet.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Build the static site -> /app/dist.
COPY . .
RUN npm run build

# ---- runtime stage ----
# Pinned nginx on Alpine. We replace the default config with app/nginx.conf (SPA
# fallback + /healthz + non-root, read-only-fs friendly) and copy in the built assets.
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/nginx:1.27-alpine AS runtime

# Our config: foreground nginx, pid/temp under writable mounts, listen on the app port.
COPY nginx.conf /etc/nginx/nginx.conf

# Static assets only — no source, no node_modules.
COPY --from=build /app/dist /usr/share/nginx/html

# Run as a non-root UID (matches the Deployment securityContext runAsUser: 65532).
# The static assets and config are world-readable; the writable pid/temp paths are
# provided by emptyDir mounts at runtime (see .devops/chart/base/deployment.yaml).
USER 65532:65532

# Documents the port nginx listens on (see app/nginx.conf + .devops/app-metadata.yaml).
EXPOSE ${{ values.port }}

# Run nginx directly (skip the base image's docker-entrypoint.d scripts, which expect a
# writable /etc/nginx and root) — deterministic under a read-only root filesystem.
ENTRYPOINT ["nginx", "-g", "daemon off;"]
