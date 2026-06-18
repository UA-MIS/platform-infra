# syntax=docker/dockerfile:1
#
# Multi-stage build: a statically-linked, std-lib-only Go binary copied into a
# scratch image for the smallest footprint + fastest cold start. Built by the
# platform CI (Kaniko, rootless) on the self-hosted ARC runners. Edit if your app
# needs more — but keep it rootless + minimal.

# ---- build stage ----
FROM golang:1.26-alpine AS build
WORKDIR /src

COPY go.mod ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath -ldflags="-s -w" \
    -o /out/app .

# ---- final stage ----
FROM scratch

# Run as a non-root UID (distroless "nonroot" convention) for least privilege.
USER 65532:65532

COPY --from=build /out/app /app

EXPOSE ${{ values.port }}
ENTRYPOINT ["/app"]
