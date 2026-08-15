# syntax=docker/dockerfile:1
#
# Two-stage build: install dependencies into a venv in a build stage, then copy ONLY
# the venv + app source into a slim final stage. Runs as a NON-ROOT UID with a
# read-only root filesystem (the platform pod securityContext, .devops/chart) — so
# nothing is written to disk at runtime. Built by the platform CI (Kaniko, rootless)
# on the self-hosted ARC runners. Build context = this `app/` dir (.devops/ci +
# resolve-components.sh set context=app, dockerfile=Dockerfile).
#
# NO apt is needed: PyMySQL is pure-Python and uvicorn[standard] installs as wheels,
# so there is no compiler/system-lib step (and no :443 apt gotcha — see the note at
# the bottom if you ever add one).

# ---- build stage: resolve deps into an isolated venv ----
#
# B4: base images resolve through the platform's Harbor pull-through cache
# (dockerhub-proxy) instead of Docker Hub directly -- avoids Docker Hub rate
# limits across every team's CI, verified working end-to-end (cache-hit proof
# in artifacts/implementation/b4-harbor-proxy-cache.evidence.yaml). Same image,
# same tag, different registry host -- purely a pull-path change.
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/python:3.12-slim AS build
ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# ---- final stage: slim runtime, non-root, read-only-fs friendly ----
FROM harbor.capstone.uamishub.com/dockerhub-proxy/library/python:3.12-slim AS final
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    PORT=${{ values.port }}
WORKDIR /app

# Bring in the resolved dependencies (built once, copied read-only) and the app source.
COPY --from=build /opt/venv /opt/venv
COPY app ./app

# Run as a non-root UID (distroless "nonroot" convention) for least privilege; matches
# the chart's runAsUser/runAsNonRoot. /opt/venv + /app are world-readable (COPY default).
USER 65532:65532

EXPOSE ${{ values.port }}

# The platform injects PORT (chart base envs PORT=8080); honor it, defaulting to the
# scaffolded port. `${PORT}` is a SHELL var (single brace) — nunjucks-safe.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]

# ============================================================================
# ⚠ ADDING apt PACKAGES TO A DEBIAN/SLIM BASE? Read this first (platform lesson #4).
# ============================================================================
# This image needs NO apt (pure-Python deps), so none of this bites the starter. BUT
# the moment you add `apt-get` to a slim Debian base, your CI build WILL break on the
# platform runners unless you use the bootstrap block below. Two platform facts:
#
#   1. The ARC runner egress NetworkPolicy allows external **:443 ONLY** (no external
#      :80, SEC-014). Debian apt defaults to http://deb.debian.org (:80) -> blocked.
#      Rewrite the apt sources to HTTPS.
#   2. Slim Debian bases ship NO ca-certificates bundle, so the first HTTPS fetch
#      can't verify the (legitimate) TLS cert. Bootstrap with peer-verify OFF for that
#      ONE fetch to install ca-certificates, then every later layer verifies normally.
#      This stays :443-only (netpol-compliant); apt still verifies PACKAGE integrity
#      via its Signed-By GPG keyring independent of TLS, so the bootstrap is safe.
#
# COPY THIS PATTERN VERBATIM into any apt-using stage (the proven platform block):
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
# Use the pattern from the start. See docs/index.md for the full note.
# ============================================================================
