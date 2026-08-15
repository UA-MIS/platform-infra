# syntax=docker/dockerfile:1
#
# ${{ values.appName }} BACKEND image (build context: this skeleton root).
#
# Multi-stage: a Rust (Debian slim) builder compiles a release binary; a tiny
# distroless/cc runtime runs it. Built by the platform CI (Kaniko, rootless) on the
# self-hosted ARC runners — ONE image per component.
#
# NO apt is needed: sqlx is built WITHOUT a TLS feature (no OpenSSL/ring/C toolchain) and
# every other crate is pure Rust, so the build sidesteps the platform's :443-only runner
# egress + missing-ca-certificates pitfalls. If you ever enable sqlx TLS (needs a C/cmake
# toolchain) or otherwise add `apt-get`, see the apt-over-HTTPS note at the bottom.
#
# RUNTIME: listens on $PORT (main.rs reads PORT; the chart sets it from the component port).
# distroless/cc:nonroot provides glibc + ca-certificates, runs as uid 65532 (non-root),
# ships no shell/package manager, and is read-only-root friendly.

# ---- build stage (compile release binary) ----
#
# B4: base images resolve through the platform's Harbor pull-through cache
# (dockerhub-proxy) instead of Docker Hub directly -- avoids Docker Hub rate
# limits across every team's CI, verified working end-to-end (cache-hit proof
# in artifacts/implementation/b4-harbor-proxy-cache.evidence.yaml). Same image,
# same tag, different registry host -- purely a pull-path change.
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/rust:1-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

# ---- runtime stage (distroless cc, non-root) ----
FROM gcr.io/distroless/cc-debian12:nonroot AS final
WORKDIR /app
COPY --from=build /src/target/release/app /app/app

# Matches the chart securityContext (runAsUser: 65532, runAsNonRoot, readOnlyRootFilesystem).
USER 65532:65532
ENV PORT=${{ values.port }}

# Documentation only — the real port is $PORT (chart containerPort = component `port`).
EXPOSE ${{ values.port }}

ENTRYPOINT ["/app/app"]

# ============================================================================
# ADDING apt PACKAGES (or sqlx TLS) TO A DEBIAN BASE? Read this first (platform lesson #4).
# ============================================================================
# This image needs NO apt. BUT the moment you add `apt-get` to a Debian base (e.g. to add
# cmake/clang for sqlx TLS), your CI build WILL break on the platform runners unless you use
# the bootstrap block below:
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
