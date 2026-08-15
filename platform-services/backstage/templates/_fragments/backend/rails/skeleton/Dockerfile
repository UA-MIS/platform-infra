# syntax=docker/dockerfile:1
#
# Two-stage build: compile gems (incl. the Trilogy native extension) in a build stage,
# then copy ONLY the installed gems + app source into a slim final stage. Runs as a
# NON-ROOT UID with a read-only root filesystem (the platform pod securityContext,
# .devops/chart) — so nothing is written to disk at runtime (Rails logs to stdout,
# bootsnap is disabled, Puma writes no pidfile, the cache is in-memory). Built by the
# platform CI (Kaniko, rootless) on the self-hosted ARC runners. Build context = this
# skeleton dir (the engine sets context + dockerfile).

# ---- build stage: install gems (Trilogy needs a C toolchain to compile its extension) ----
#
# B4: base images resolve through the platform's Harbor pull-through cache
# (dockerhub-proxy) instead of Docker Hub directly -- avoids Docker Hub rate
# limits across every team's CI, verified working end-to-end (cache-hit proof
# in artifacts/implementation/b4-harbor-proxy-cache.evidence.yaml). Same image,
# same tag, different registry host -- purely a pull-path change.
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/ruby:3.3-slim AS build
ENV BUNDLE_PATH=/usr/local/bundle \
    BUNDLE_WITHOUT="development:test" \
    BUNDLE_DEPLOYMENT=1
WORKDIR /app

# The slim base ships no compiler. Install build-essential over HTTPS (the runner egress
# is :443-only — see the note at the bottom). Trilogy needs only a compiler at BUILD time;
# at RUNTIME it needs NO libmysqlclient, so the final stage stays apt-free and slim.
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    apt-get -o Acquire::https::Verify-Peer=false update && \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
    apt-get update && \
    apt-get install -y --no-install-recommends build-essential libssl-dev pkg-config && \
    rm -rf /var/lib/apt/lists/*

COPY Gemfile Gemfile.lock ./
RUN bundle install && \
    rm -rf "${BUNDLE_PATH}"/ruby/*/cache "${BUNDLE_PATH}"/ruby/*/bundler/gems/*/.git

# ---- final stage: slim runtime, non-root, read-only-fs friendly ----
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/ruby:3.3-slim AS final
ENV BUNDLE_PATH=/usr/local/bundle \
    BUNDLE_WITHOUT="development:test" \
    BUNDLE_DEPLOYMENT=1 \
    RAILS_ENV=production \
    RAILS_LOG_TO_STDOUT=1 \
    PORT=${{ values.port }}
WORKDIR /app

# Resolved gems (built once, copied read-only) + the app source.
COPY --from=build /usr/local/bundle /usr/local/bundle
COPY . .

# Run as a non-root UID (distroless "nonroot" convention) for least privilege; matches
# the chart's runAsUser/runAsNonRoot.
USER 65532:65532

EXPOSE ${{ values.port }}

# Puma binds to $PORT (config/puma.rb reads ENV["PORT"]). `${PORT}` is a SHELL var
# (single brace) — nunjucks-safe. No pidfile (PIDFILE unset), so nothing is written.
CMD ["sh", "-c", "exec bundle exec puma -C config/puma.rb"]

# ============================================================================
# ⚠ ADDING apt PACKAGES TO A DEBIAN/SLIM BASE? Read this first (platform lesson #4).
# ============================================================================
# The build stage above already uses the proven pattern. Two platform facts:
#
#   1. The ARC runner egress NetworkPolicy allows external **:443 ONLY** (no external
#      :80, SEC-014). Debian apt defaults to http://deb.debian.org (:80) -> blocked.
#   2. Slim Debian bases ship NO ca-certificates bundle, so the first HTTPS fetch can't
#      verify the (legitimate) TLS cert. Bootstrap with peer-verify OFF for that ONE
#      fetch to install ca-certificates, then every later layer verifies normally. apt
#      still verifies PACKAGE integrity via its Signed-By GPG keyring, so this is safe.
#
# The block to copy into any apt-using stage:
#
#   RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
#           /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
#       apt-get -o Acquire::https::Verify-Peer=false update && \
#       apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
#       apt-get update && \
#       apt-get install -y --no-install-recommends <your-packages-here> && \
#       rm -rf /var/lib/apt/lists/*
#
# Note: the runner netpol is inert (flannel) today, so a build WITHOUT this block may
# pass now — but it breaks the moment platform-netpol-runners is enforced (Cilium).
# ============================================================================
