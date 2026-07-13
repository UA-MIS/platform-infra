# syntax=docker/dockerfile:1
#
# ${{ values.appName }} static-site image (build context: this skeleton root -> app/).
#
# A plain HTML/CSS/JS site (NO framework, NO build step) served by nginx. There is nothing
# to compile — the source files ARE the deployable — so this is a SINGLE-stage image: copy
# the static files into a tiny nginx (Alpine) runtime. Built by the platform CI (Kaniko,
# rootless) on the self-hosted ARC runners. (90% of org repos ship without a working
# Dockerfile — this one is known-good.)
#
# NO apt/apk at build time (Alpine base, no package installs), so this image sidesteps the
# platform's :443-only runner egress + missing-ca-certificates pitfalls entirely.
#
# RUNTIME HARDENING: the chart runs this pod as runAsNonRoot (uid 65532) +
# readOnlyRootFilesystem. nginx.conf keeps nginx's pid, temp paths, and logs off the
# read-only rootfs (under /dev/shm + stdout/stderr), so it runs clean with no writable volume.

FROM nginx:1.29-alpine

# Our config: foreground nginx, pid/temp under /dev/shm, listen on the app port, static
# multi-page serving + /healthz. nginx.conf lives at the skeleton root, OUTSIDE public/, so
# it is never served as web content.
COPY nginx.conf /etc/nginx/nginx.conf

# The static site (HTML/CSS/JS) lives under public/ — only those web assets land under the
# served root. Add pages by dropping files under public/.
COPY public/ /usr/share/nginx/html

# Run as a non-root UID (matches the chart securityContext runAsUser: 65532). The static
# assets and config are world-readable; the writable pid/temp paths live under /dev/shm.
USER 65532:65532

# Documentation only — the real port is the chart containerPort (components.yaml `port`).
EXPOSE 8080

# Run nginx directly (skip the base image's docker-entrypoint.d scripts, which expect a
# writable /etc/nginx and root) — deterministic under a read-only root filesystem.
ENTRYPOINT ["nginx", "-g", "daemon off;"]
