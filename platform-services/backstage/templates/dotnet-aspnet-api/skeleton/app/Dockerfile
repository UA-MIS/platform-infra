# syntax=docker/dockerfile:1
#
# Multi-stage build for the ASP.NET Core (.NET 8) Web API: restore + publish on the
# full SDK image, then copy ONLY the framework-dependent publish output onto the small
# aspnet runtime image. Built by the platform CI (Kaniko, rootless) on the self-hosted
# ARC runners. Known-good + non-root by design — 90% of org .NET repos lack a working
# Dockerfile; this is the canonical one. Edit if your app needs more, but keep it
# rootless + minimal.

# ---- build stage ----
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Restore first (cached layer) — copy only the project file so a code-only change does
# not bust the restore cache.
COPY App.csproj ./
RUN dotnet restore App.csproj

# Now the rest of the source, then publish a Release build to /app/publish.
COPY . .
RUN dotnet publish App.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false

# ---- final stage ----
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
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
