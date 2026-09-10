# syntax=docker/dockerfile:1
#
# Multi-stage build for the ASP.NET Core (.NET 8) Web API: restore + publish on the
# full SDK image, then copy ONLY the framework-dependent publish output onto the small
# aspnet runtime image. Built by the platform CI (Kaniko, rootless) on the self-hosted
# ARC runners. Known-good + non-root by design — 90% of org .NET repos lack a working
# Dockerfile; this is the canonical one. Edit if your app needs more, but keep it
# rootless + minimal.

# ---- build stage ----
#
# Base images resolve through the platform's Harbor MCR pull-through cache
# (mcr-proxy) instead of mcr.microsoft.com directly — same reason every other
# fragment goes through dockerhub-proxy: on the CI build pool's slower node
# (100Mbit NIC), a direct ~800MB SDK pull inside Kaniko times out
# ("failed to get filesystem from image"). This bit the first .NET tenant
# (next-up) hard enough to be the dominant CI failure mode for that repo.
#
# FLOATING TAG, not digest-pinned — deliberately, to match every sibling
# fragment (dockerhub-proxy/library/node, /python, /golang, etc. all use a
# floating tag through the proxy; none of them pin). A digest baked into a
# SCAFFOLDER TEMPLATE is a different problem than one in a single repo: it
# freezes at whatever moment this file was last edited, with no owner and no
# refresh signal, so every team scaffolded after that point silently starts
# on an aging .NET base with nothing prompting a bump. A floating tag through
# the proxy fixes the actual root cause (bandwidth/timeout, not Docker Hub
# rate limits) without introducing that orphaned-pin problem. (Contrast:
# UA-MIS/next-up's OWN backend/Dockerfile digest-pins this — that repo's CI
# already digest-pins every base/tool image it pulls as an established
# per-repo security posture, so it correctly keeps that convention. This
# template's convention, inherited by every future team, is the proxied
# floating tag every other stack here already uses.)
FROM harbor.capstone.uamishub.com/base-images/dotnet/sdk:8.0 AS build
WORKDIR /src

# Restore first (cached layer) — copy only the project file so a code-only change does
# not bust the restore cache.
COPY App.csproj ./
RUN dotnet restore App.csproj

# Now the rest of the source, then publish a Release build to /app/publish.
COPY . .
RUN dotnet publish App.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false

# ---- final stage ----
#
# Same mcr-proxy + floating-tag rationale as the build stage above.
FROM harbor.capstone.uamishub.com/base-images/dotnet/aspnet:8.0 AS final
WORKDIR /app

# Run as a non-root UID. The k8s securityContext pins runAsUser 65532 +
# readOnlyRootFilesystem; this USER keeps the image itself non-root for any other
# runtime (the .devops chart mounts an emptyDir at /tmp so the read-only rootfs still
# has a writable temp dir for .NET).
USER 65532:65532

COPY --from=build /app/publish ./

# Kestrel binds the container PORT (Program.cs reads PORT; the .devops Deployment sets
# PORT=8080 and the Service/Ingress target it). Default here matches the scaffolded port.
ENV PORT=${{ values.port }} \
    ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_EnableDiagnostics=0 \
    TMPDIR=/tmp

EXPOSE ${{ values.port }}

ENTRYPOINT ["dotnet", "App.dll"]
