# syntax=docker/dockerfile:1
#
# ${{ values.appName }} BACKEND image (build context: ./backend).
#
# Two-stage build: install dependencies into a venv in a build stage, then copy ONLY the
# venv + app source into a slim final stage that runs gunicorn. Runs as a NON-ROOT UID with
# a read-only root filesystem (the platform pod securityContext, .devops/chart) — nothing is
# written to disk at runtime. Built by the platform CI (Kaniko, rootless) on the self-hosted
# ARC runners. Build context = this dir (.devops/ci + resolve-components.sh set context).
#
# NO apt is needed: PyMySQL is pure-Python and Flask/gunicorn install as wheels, so there is
# no compiler/system-lib step (and no :443 apt gotcha — see the note at the bottom).

# ---- build stage: resolve deps into an isolated venv ----
FROM python:3.12-slim AS build
ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# ---- final stage: slim runtime, non-root, read-only-fs friendly ----
FROM python:3.12-slim AS final
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    PORT=${{ values.port }}
WORKDIR /app

# Bring in the resolved dependencies (built once, copied read-only) and the app source.
COPY --from=build /opt/venv /opt/venv
COPY wsgi.py ./
COPY app ./app

# Run as a non-root UID (distroless "nonroot" convention) for least privilege; matches the
# chart's runAsUser/runAsNonRoot. /opt/venv + /app are world-readable (COPY default).
USER 65532:65532

EXPOSE ${{ values.port }}

# The platform injects PORT (chart base envs PORT=8080); honor it, defaulting to the
# scaffolded port. `${PORT}` is a SHELL var (single brace) — nunjucks-safe. A single sync
# worker keeps memory low; raise --workers/--threads as your app grows.
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT} --workers 2 --threads 4 wsgi:app"]

# ============================================================================
# ADDING apt PACKAGES TO A DEBIAN/SLIM BASE? Read this first (platform lesson #4).
# ============================================================================
# This image needs NO apt (pure-Python deps), so none of this bites the starter. BUT the
# moment you add `apt-get` to a slim Debian base, your CI build WILL break on the platform
# runners unless you use the bootstrap block below. Two platform facts:
#
#   1. The ARC runner egress NetworkPolicy allows external **:443 ONLY** (no external :80,
#      SEC-014). Debian apt defaults to http://deb.debian.org (:80) -> blocked. Rewrite the
#      apt sources to HTTPS.
#   2. Slim Debian bases ship NO ca-certificates bundle, so the first HTTPS fetch can't
#      verify the (legitimate) TLS cert. Bootstrap with peer-verify OFF for that ONE fetch
#      to install ca-certificates, then every later layer verifies normally.
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
# ============================================================================
