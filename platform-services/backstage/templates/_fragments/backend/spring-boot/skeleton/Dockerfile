# syntax=docker/dockerfile:1
#
# ${{ values.appName }} BACKEND image (build context: this skeleton root).
#
# Multi-stage: a Maven + Temurin JDK 21 stage compiles + packages the Spring Boot fat jar;
# a clean Temurin JRE stage runs it. Built by the platform CI (Kaniko, rootless) on the
# self-hosted ARC runners — ONE image per component.
#
# NO apt is needed (Maven pulls deps over HTTPS, the JRE base is prebuilt), so it sidesteps
# the platform's :443-only runner egress + missing-ca-certificates pitfalls. If you ever add
# `apt-get` to a Debian/slim base, see the apt-over-HTTPS note at the bottom of this file.
#
# RUNTIME: listens on $PORT (Spring `server.port=${PORT:8080}`; the chart sets PORT from the
# component port). Runs as non-root (uid 65532, matching the chart securityContext) under
# readOnlyRootFilesystem — the JVM only needs a writable temp dir, pointed at /tmp (the chart
# mounts an emptyDir there).

# ---- build stage (compile + package the fat jar) ----
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
# Resolve dependencies first (cached when only source changes). Best-effort (|| true):
# go-offline can miss the odd plugin artifact, and the later `package` runs ONLINE and
# fetches anything still missing — so a partial pre-fetch must not fail the build.
COPY pom.xml ./
RUN mvn -B -q -DskipTests dependency:go-offline || true
COPY src ./src
RUN mvn -B -q -DskipTests clean package

# ---- runtime stage (slim JRE, non-root) ----
FROM eclipse-temurin:21-jre AS final
WORKDIR /app
COPY --from=build /src/target/app.jar ./app.jar

# Run as a non-root UID (matches the chart securityContext runAsUser: 65532). Point the
# JVM temp dir at /tmp (the chart mounts a writable emptyDir there under read-only rootfs).
USER 65532:65532
ENV PORT=${{ values.port }} \
    TMPDIR=/tmp \
    JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=/tmp"

# Documentation only — the real port is $PORT (Spring reads server.port=${PORT:8080}).
EXPOSE ${{ values.port }}

ENTRYPOINT ["java", "-jar", "app.jar"]

# ============================================================================
# ADDING apt PACKAGES TO A DEBIAN/SLIM BASE? Read this first (platform lesson #4).
# ============================================================================
# This image needs NO apt. BUT the moment you add `apt-get` to a slim Debian base, your CI
# build WILL break on the platform runners unless you use the bootstrap block below:
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
