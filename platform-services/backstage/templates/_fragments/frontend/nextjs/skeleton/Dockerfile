# syntax=docker/dockerfile:1
#
# Multi-stage build for a Next.js (App Router) app in `output: 'standalone'` mode,
# composed as the `frontend` half of a frontend+backend project (no Prisma/DB here —
# see the paired backend component for that). Built by the platform CI (Kaniko,
# rootless) on the self-hosted ARC runners; the build context is THIS dir
# (.devops/ci resolves frontend-backend layout as context=frontend,
# dockerfile=Dockerfile). Stages: deps -> build -> minimal non-root runtime.
# Harvested verbatim from fullstack/nextjs's proven build/runtime stages, minus the
# migrator stage and every Prisma-specific step (build/runtime scope for fastapi in
# fragment.yaml).
#
#   deps     install node_modules (cache-friendly: only package.json changes bust it)
#   build    next build -> .next/standalone (self-contained server)
#   runtime  the standalone server.js on a slim, non-root image listening on $PORT

# B4: resolves through the platform's Harbor pull-through cache (dockerhub-proxy)
# instead of Docker Hub directly -- avoids Docker Hub rate limits across every
# team's CI (see fullstack/nextjs's Dockerfile for the full evidence pointer).
ARG NODE_IMAGE=harbor.capstone.uamishub.com/dockerhub-proxy/library/node:22-bookworm-slim

# ---- deps: install dependencies (cached unless package.json changes) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json* ./
# RETRIED (not left to npm's own fetch-retries alone — see ./.npmrc for why that
# layer is insufficient inside a Kaniko build). Same proven pattern as
# fullstack/nextjs / UA-MIS/ida-llm PRs #74-#75.
RUN n=1; until sh -c 'npm ci || npm install'; do \
      if [ "$n" -ge 4 ]; then echo "npm install failed 4 times -- not a blip" >&2; exit 1; fi; \
      echo "npm install failed (attempt $n/4) -- retrying in $((n * 15))s" >&2; \
      sleep $((n * 15)); n=$((n + 1)); \
    done

# ---- build: compile Next in standalone mode ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime: the standalone server on a slim, non-root image ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=${{ values.port }} \
    HOSTNAME=0.0.0.0
# HOSTNAME=0.0.0.0, NOT 127.0.0.1/localhost: the platform reaches this pod through a
# k8s Service (pod IP), not loopback. A standalone Next.js server bound to
# 127.0.0.1 accepts connections from inside its own container only -- the Service
# would see connection-refused/timeouts, which reads exactly like the well-known
# "Next standalone + HOSTNAME=127.0.0.1" self-proxy-loop failure (30s hangs, 500s,
# nothing in the logs). Binding all interfaces is the fix; keep it that way.

# ca-certificates for outbound TLS (this component makes none by default, but a team
# will likely add some). Same proven apt-over-:443 bootstrap as every other platform
# image (ARC runner egress is :443-only, SEC-014; slim Debian ships no ca bundle).
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    apt-get -o Acquire::https::Verify-Peer=false update && \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Run as a non-root UID (matches the .devops Deployment securityContext
# runAsUser: 65532). next build's standalone output is a self-contained server.js +
# the traced node_modules subset; static assets + public/ are copied alongside it.
COPY --from=build --chown=65532:65532 /app/.next/standalone ./
COPY --from=build --chown=65532:65532 /app/.next/static ./.next/static
COPY --from=build --chown=65532:65532 /app/public ./public

USER 65532:65532
EXPOSE ${{ values.port }}

# The standalone server listens on $PORT / $HOSTNAME (set above; the .devops
# Deployment also sets PORT). Locally: `PORT=3000 node server.js`.
CMD ["node", "server.js"]
