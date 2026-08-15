# syntax=docker/dockerfile:1
#
# ${{ values.appName }} — PLACEHOLDER image for a "bring your own code" project.
#
# THIS FILE IS YOURS TO REPLACE. It is a REAL, tiny multi-stage Dockerfile that builds + runs
# a throwaway placeholder so your repo is GREEN on the first CI build and deploy. Swap in your
# own build (any language) and runtime — the platform CI (Kaniko, rootless, on the self-hosted
# ARC runners) builds whatever Dockerfile lives here. Two contracts keep you green (README.md):
#   * the app listens on $PORT (the chart sets PORT; default 8080),
#   * GET /healthz returns 200, database-independent (the chart probes hit it).
#
# The placeholder build uses ONLY the Go standard library (no module downloads), so it needs
# no network and sidesteps the platform's :443-only runner egress. The runtime is `scratch`
# (empty) with a single static binary — nothing to patch, and it runs clean under the chart's
# runAsNonRoot (uid 65532) + readOnlyRootFilesystem security context with no writable volume.

# ---- build stage: compile a static, dependency-free binary ----
#
# B4: base images resolve through the platform's Harbor pull-through cache
# (dockerhub-proxy) instead of Docker Hub directly -- avoids Docker Hub rate
# limits across every team's CI, verified working end-to-end (cache-hit proof
# in artifacts/implementation/b4-harbor-proxy-cache.evidence.yaml). Same image,
# same tag, different registry host -- purely a pull-path change.
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/golang:1.23-alpine AS build
WORKDIR /src
# Only go.mod (no deps) + the single source file — the build pulls NO modules.
COPY go.mod ./
COPY main.go ./
# CGO off -> a fully static binary that runs on `scratch` with no libc.
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /app .

# ---- runtime stage: just the static binary on an empty base ----
FROM scratch
# Run as a non-root UID (matches the chart securityContext runAsUser: 65532). `scratch` has no
# /etc/passwd, but a numeric UID needs no passwd entry.
USER 65532:65532
COPY --from=build /app /app
# Documentation only — the real port is $PORT (chart containerPort = components.yaml `port`).
EXPOSE 8080
ENTRYPOINT ["/app"]
