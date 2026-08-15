# syntax=docker/dockerfile:1
#
# ${{ values.appName }} FRONTEND image (build context: ./frontend).
#
# Vite + React + TypeScript SPA built to static files, served by nginx. Multi-stage: a
# Node (Alpine) builder produces /dist, copied into a tiny nginx (Alpine) runtime. Built
# by the platform CI (Kaniko, rootless) on the self-hosted ARC runners — ONE image per
# component (see .devops/components.yaml).
#
# NO apt/apk at build time (Alpine bases + npm over HTTPS only), so this image sidesteps
# the platform's :443-only runner egress + missing-ca-certificates pitfalls entirely. (If
# you switch to a Debian-family base that runs apt, see the apt-over-HTTPS note in
# docs/index.md — the runner egress is :443-only.)
#
# RUNTIME HARDENING: the chart runs this pod as runAsNonRoot (uid 65532) +
# readOnlyRootFilesystem. nginx/nginx.conf keeps nginx's pid, temp paths, and logs off the
# read-only rootfs (under /dev/shm + stdout/stderr), so it runs clean with no writable volume.

# ---- build stage ----
#
# B4: base images resolve through the platform's Harbor pull-through cache
# (dockerhub-proxy) instead of Docker Hub directly -- avoids Docker Hub rate
# limits across every team's CI, verified working end-to-end (cache-hit proof
# in artifacts/implementation/b4-harbor-proxy-cache.evidence.yaml). Same image,
# same tag, different registry host -- purely a pull-path change.
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/node:22-alpine AS build
WORKDIR /src

# Install deps first (layer-cached), then copy the source and build. No lockfile is shipped
# with the starter, so `npm install` resolves the manifests; commit the generated
# package-lock.json and switch to `npm ci` for reproducible builds once you are set up.
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/nginx:1.27-alpine

# Custom config: listen on the component port, SPA fallback, /healthz, and a fully
# read-only-rootfs-compatible runtime (pid + temp under /dev/shm, logs to stdout/stderr).
COPY nginx/nginx.conf /etc/nginx/nginx.conf
# The built SPA (static files only) — nothing else from the build stage ships.
COPY --from=build /src/dist /usr/share/nginx/html

# Run as a non-root UID (matches the chart securityContext runAsUser: 65532).
USER 65532:65532

# Documentation only — the real port is the chart containerPort (components.yaml `port`).
EXPOSE 8080
# Foreground so the container's PID 1 is nginx.
CMD ["nginx", "-g", "daemon off;"]
