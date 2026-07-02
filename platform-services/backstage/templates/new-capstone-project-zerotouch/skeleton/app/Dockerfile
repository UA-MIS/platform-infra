# syntax=docker/dockerfile:1
#
# Multi-stage build: a statically-linked, std-lib-only Go binary copied into a
# scratch image for the smallest footprint + fastest cold start. Built by the
# platform CI (Kaniko, rootless) on the self-hosted ARC runners. Edit if your app
# needs more — but keep it rootless + minimal.

# ---- build stage ----
FROM golang:1.26-alpine AS build
WORKDIR /src

COPY go.mod ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath -ldflags="-s -w" \
    -o /out/app .

# ---- final stage ----
FROM scratch

# Run as a non-root UID (distroless "nonroot" convention) for least privilege.
USER 65532:65532

COPY --from=build /out/app /app

EXPOSE ${{ values.port }}
ENTRYPOINT ["/app"]

# ============================================================================
# ⚠ SWITCHING TO A DEBIAN/UBUNTU BASE? Read this first (platform lesson #4).
# ============================================================================
# The default above is Go-on-scratch, which needs no apt — so none of this bites
# the starter. BUT the moment you change a build/runtime stage to a Debian-family
# base (e.g. `node:*-trixie-slim`, `python:*-slim`, `debian:*-slim`) and run
# `apt-get`, your CI build WILL break on the platform runners unless you use the
# bootstrap block below. Two platform facts cause this:
#
#   1. The ARC runner egress NetworkPolicy allows external **:443 ONLY** (no
#      external :80, SEC-014 port-scoping). Debian apt defaults to
#      `http://deb.debian.org` (:80) → blocked. You must rewrite the apt sources
#      to HTTPS.
#   2. The slim Debian bases ship **NO `ca-certificates` bundle**, so the very
#      first HTTPS fetch can't verify the (legitimate) TLS cert — a chicken-and-egg.
#      Bootstrap with peer-verify OFF for that ONE fetch to install
#      `ca-certificates`, then every later layer verifies normally. This stays
#      :443-only (netpol-compliant); apt still verifies PACKAGE integrity via its
#      Signed-By GPG keyring independent of TLS, so the bootstrap is safe.
#
# COPY THIS PATTERN VERBATIM into any Debian-base stage that runs apt (it is the
# exact, proven block from the platform's own Backstage backend image):
#
#   FROM node:24-trixie-slim AS build      # or python:3-slim, debian:trixie-slim, …
#   RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
#           /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
#       apt-get -o Acquire::https::Verify-Peer=false update && \
#       apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
#       apt-get update && \
#       apt-get install -y --no-install-recommends <your-packages-here> && \
#       rm -rf /var/lib/apt/lists/*
#
# Note: today the runner netpol is inert (flannel) on the live cluster, so a build
# WITHOUT this block may pass right now — but it will break the moment
# `platform-netpol-runners` is enforced (Cilium). Use the pattern from the start;
# do not depend on the netpol being inert. See docs/index.md for the full note.
# ============================================================================
