# syntax=docker/dockerfile:1
#
# ${{ values.appName }} BACKEND image (build context: this skeleton root).
#
# Multi-stage: a Go (Debian) builder compiles a STATIC, CGO-disabled binary; a tiny
# distroless/static runtime runs it. Built by the platform CI (Kaniko, rootless) on the
# self-hosted ARC runners — ONE image per component.
#
# NO apt/apk at build time (modules over HTTPS, no cgo), so it sidesteps the platform's
# :443-only runner egress + missing-ca-certificates pitfalls. If you ever switch to a base
# that runs apt, see the apt-over-HTTPS note at the bottom of this file.
#
# RUNTIME: listens on $PORT (main.go reads PORT; the chart sets it from the component port).
# distroless/static:nonroot already runs as uid 65532 (non-root) and ships no shell, no
# package manager, and a read-only-friendly filesystem.

# ---- build stage (compile a static binary) ----
FROM golang:1.23 AS build
WORKDIR /src
# Resolve modules first (cached when only source changes).
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app .

# ---- runtime stage (distroless static, non-root) ----
FROM gcr.io/distroless/static-debian12:nonroot AS final
WORKDIR /app
COPY --from=build /out/app /app/app

# Matches the chart securityContext (runAsUser: 65532, runAsNonRoot, readOnlyRootFilesystem).
USER 65532:65532
ENV PORT=${{ values.port }}

# Documentation only — the real port is $PORT (chart containerPort = component `port`).
EXPOSE ${{ values.port }}

ENTRYPOINT ["/app/app"]

# ============================================================================
# ADDING apt PACKAGES TO A DEBIAN BASE? Read this first (platform lesson #4).
# ============================================================================
# This image needs NO apt. BUT the moment you add `apt-get` to a Debian base, your CI build
# WILL break on the platform runners unless you use the bootstrap block below:
#   1. The ARC runner egress NetworkPolicy allows external :443 ONLY (no external :80,
#      SEC-014). Debian apt defaults to http://deb.debian.org (:80) -> blocked. Use HTTPS.
#   2. Slim Debian bases ship NO ca-certificates, so the first HTTPS fetch can't verify the
#      TLS cert. Bootstrap with peer-verify OFF for that ONE fetch to install
#      ca-certificates, then later layers verify normally (apt still GPG-verifies packages).
#
#   RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
#           /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
#       apt-get -o Acquire::https::Verify-Peer=false update && \
#       apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
#       apt-get update && \
#       apt-get install -y --no-install-recommends <your-packages-here> && \
#       rm -rf /var/lib/apt/lists/*
# ============================================================================
