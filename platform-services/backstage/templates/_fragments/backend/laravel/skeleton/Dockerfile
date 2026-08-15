# syntax=docker/dockerfile:1
#
# Two-stage build: resolve PHP deps with Composer in a vendor stage, then copy the app +
# vendor into a slim PHP runtime. Runs as a NON-ROOT UID with a read-only root filesystem
# (the platform pod securityContext, .devops/chart) — so nothing is written to disk at
# runtime (logs -> stderr, cache/session = array, no Blade views are compiled). Built by
# the platform CI (Kaniko, rootless) on the self-hosted ARC runners. Build context = this
# skeleton dir (the engine sets context + dockerfile).

# ---- vendor stage: install PHP dependencies (no dev) ----
FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
# Install without running scripts first (app code isn't copied yet), then bring the app
# in and dump an optimized autoloader (runs package:discover -> bootstrap/cache).
RUN composer install --no-dev --no-scripts --prefer-dist --no-interaction --no-progress --optimize-autoloader
COPY . .
RUN composer dump-autoload --optimize --no-dev

# ---- final stage: slim PHP runtime, non-root, read-only-fs friendly ----
FROM php:8.4-cli AS final
ENV PORT=${{ values.port }} \
    APP_ENV=production \
    APP_DEBUG=false \
    LOG_CHANNEL=stderr \
    CACHE_STORE=array \
    SESSION_DRIVER=array \
    QUEUE_CONNECTION=sync
WORKDIR /app

# Install the pdo_mysql extension. The base ships no compiler, so install the PHP build
# deps over HTTPS (runner egress is :443-only — see the note at the bottom), compile, then
# purge them. The compiled pdo_mysql.so needs NO system libs at runtime (mysqlnd is
# bundled), so the final image stays slim.
RUN set -eux; \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    apt-get -o Acquire::https::Verify-Peer=false update; \
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates; \
    apt-get update; \
    apt-get install -y --no-install-recommends $PHPIZE_DEPS; \
    docker-php-ext-install -j"$(nproc)" pdo_mysql; \
    apt-get purge -y --auto-remove $PHPIZE_DEPS; \
    rm -rf /var/lib/apt/lists/*

COPY --from=vendor /app /app

# Run as a non-root UID (distroless "nonroot" convention) for least privilege; matches the
# chart's runAsUser/runAsNonRoot.
USER 65532:65532

EXPOSE ${{ values.port }}

# Serve via the built-in PHP server through Laravel's front controller. `${PORT}` is a
# SHELL var (single brace) — nunjucks-safe. This single-process server is fine for the
# starter; for higher throughput swap in php-fpm + nginx, FrankenPHP, or Laravel Octane.
CMD ["sh", "-c", "exec php artisan serve --host=0.0.0.0 --port=${PORT}"]

# ============================================================================
# ⚠ ADDING apt PACKAGES TO A DEBIAN BASE? Read this first (platform lesson #4).
# ============================================================================
# The block above already uses the proven pattern. Two platform facts:
#
#   1. The ARC runner egress NetworkPolicy allows external **:443 ONLY** (no external
#      :80, SEC-014). Debian apt defaults to http://deb.debian.org (:80) -> blocked.
#   2. Slim Debian bases ship NO ca-certificates bundle, so the first HTTPS fetch can't
#      verify the (legitimate) TLS cert. Bootstrap with peer-verify OFF for that ONE
#      fetch to install ca-certificates, then every later layer verifies normally. apt
#      still verifies PACKAGE integrity via its Signed-By GPG keyring, so this is safe.
#
# Note: the runner netpol is inert (flannel) today, so a build WITHOUT this block may
# pass now — but it breaks the moment platform-netpol-runners is enforced (Cilium).
# ============================================================================
