# platform-infra Makefile — Phase-1 dev ergonomics (T2).
#
# Every target is idempotent: re-running it must not error. The cluster target
# is parameterized by TARGET (clusters/<TARGET>/) so the same Makefile drives
# local-k3d now and real-k3s later — the portability seam from §6.
#
# Quick start:
#   make cluster-up      # create the k3d cluster if absent (idempotent)
#   make cluster-start   # restart a STOPPED cluster + registry (post-reboot)
#   make cluster-stop    # stop the cluster + registry without deleting
#   make cluster-info    # show nodes + registry + ingress URL
#   make cluster-down    # delete the k3d cluster
#   make bootstrap       # (T3) apply the ArgoCD root app-of-apps
#   make seal SECRET=... # (T4) kubeseal helper
#
# CONTAINER RUNTIME: this Makefile auto-detects Docker vs rootless Podman. With
# Podman it points k3d at the rootless user socket and bind-mounts that socket
# into the k3d nodes (DOCKER_SOCK), avoiding the root-owned /var/run/docker.sock.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# ---- target cluster selection (portability seam) ---------------------------
TARGET      ?= local-k3d
CLUSTER_DIR := clusters/$(TARGET)
VALUES_ENV  := $(CLUSTER_DIR)/values.env
K3D_CONFIG  := $(CLUSTER_DIR)/k3d-config.yaml

# Load CLUSTER_NAME/REGISTRY/etc. from the selected target's values.env.
ifneq (,$(wildcard $(VALUES_ENV)))
include $(VALUES_ENV)
export
endif
CLUSTER_NAME ?= capstone

# kube-context the cluster-acting targets use (bootstrap/reapply + harbor-* onboarding).
# Defaults to the real Talos cluster's context (`admin@capstone`) — k3d is dead, so
# defaulting to a k3d-* context here was a footgun: bootstrap-reapply would silently
# try to reach a nonexistent 127.0.0.1 k3d apiserver instead of failing loud. Local
# k3d runs (if ever needed again) override explicitly on the CLI together with the
# Talos kubeconfig, e.g.
#   make bootstrap TARGET=real-talos KUBE_CONTEXT=admin@capstone \
#     KUBECONFIG=clusters/real-talos/talos-kubeconfig
#   make harbor-push-robot NAME=backstage KUBE_CONTEXT=admin@capstone \
#     KUBECONFIG=clusters/real-talos/talos-kubeconfig > harbor-push-sealed.yaml
# (Talos is provisioned out-of-band, so the k3d cluster-up/down targets don't apply
# there — only the cluster-acting targets take this override.)
KUBE_CONTEXT ?= admin@capstone

# ---- container runtime auto-detection (Docker or rootless Podman) -----------
# If a real Docker daemon answers, use it. Otherwise (rootless Podman, detected
# by "podman" appearing in `docker info`) fall back to the rootless Podman user
# socket and tell k3d to bind-mount *that* socket into nodes (DOCKER_SOCK),
# avoiding the root-owned /var/run/docker.sock symlink k3d would otherwise mount.
PODMAN_SOCK := /run/user/$(shell id -u)/podman/podman.sock
IS_PODMAN   := $(shell docker info 2>/dev/null | grep -qi podman && echo yes)
RUNTIME_ENV := $(shell \
  if [ "$(IS_PODMAN)" = "yes" ] && [ -S "$(PODMAN_SOCK)" ]; then \
    echo "DOCKER_HOST=unix://$(PODMAN_SOCK) DOCKER_SOCK=$(PODMAN_SOCK)" ; \
  fi )

# k3d needs the registry name resolvable from the host for `docker push`.
# REGISTRY_HOST is the FINAL container/DNS name (== the in-cluster containerd
# mirror key, == the `image:` prefix the overlays use). `k3d registry create`
# ALWAYS prepends `k3d-` to its NAME arg, so we pass REGISTRY_CREATE_NAME (the
# host minus that prefix); k3d re-adds `k3d-` to land back on REGISTRY_HOST.
# Getting this wrong yields a double-prefixed `k3d-k3d-registry.localhost` mirror
# key that does NOT match `k3d-registry.localhost:5000/...` images -> in-cluster
# ImagePullBackOff ("lookup k3d-registry.localhost: no such host").
REGISTRY_HOST := k3d-registry.localhost
REGISTRY_CREATE_NAME := registry.localhost
REGISTRY_PORT := 5000

# The container network k3d creates for this cluster. We pre-create it (and the
# registry, on it) under rootless Podman because Podman has NO default "bridge"
# network — k3d's inline `registries.create` tries to attach the registry node
# to "bridge" before the cluster network exists and fails with
# `unable to find network with name or ID bridge`. k3d's documented Podman path
# is: create the network + registry first, then `cluster create --registry-use`
# (https://k3d.io/.../usage/advanced/podman/). Native Docker keeps the inline
# config path unchanged (the "bridge" network exists there).
CLUSTER_NETWORK := k3d-$(CLUSTER_NAME)

.PHONY: help
help: ## Show this help
	@echo "platform-infra targets (TARGET=$(TARGET)):"
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Runtime env injected into k3d: $(if $(RUNTIME_ENV),$(RUNTIME_ENV),<native docker>)"

# ---- preflight -------------------------------------------------------------
.PHONY: preflight
preflight: ## Verify required tools + host prerequisites (cpuset cgroup delegation)
	@command -v k3d    >/dev/null || { echo "ERROR: k3d not found (https://k3d.io). Install to ~/.local/bin."; exit 1; }
	@command -v kubectl >/dev/null || { echo "ERROR: kubectl not found."; exit 1; }
	@command -v docker >/dev/null || { echo "ERROR: docker (or podman-docker shim) not found."; exit 1; }
	@# k3s inside k3d REQUIRES the cpuset cgroup-v2 controller. Rootless Podman
	@# only exposes it if systemd delegates cpuset to the user manager. Detect the
	@# gap early with an actionable message instead of a 5-minute hang + cryptic
	@# "failed to find cpuset cgroup (v2)" deep in the k3s logs.
	@if [ -n "$(RUNTIME_ENV)" ]; then \
	  ctrl="/sys/fs/cgroup/user.slice/user-$$(id -u).slice/user@$$(id -u).service/cgroup.controllers"; \
	  if [ -r "$$ctrl" ] && ! grep -qw cpuset "$$ctrl"; then \
	    echo "ERROR: rootless cgroup-v2 'cpuset' controller is NOT delegated to your user."; \
	    echo "       k3s cannot start without it (you'd hit: failed to find cpuset cgroup (v2))."; \
	    echo ""; \
	    echo "  One-time ROOT fix (then log out/in or reboot):"; \
	    echo "    sudo mkdir -p /etc/systemd/system/user@.service.d"; \
	    echo "    printf '[Service]\\nDelegate=cpu cpuset io memory pids\\n' | \\"; \
	    echo "      sudo tee /etc/systemd/system/user@.service.d/delegate.conf"; \
	    echo "    sudo systemctl daemon-reload"; \
	    echo "    # then: loginctl terminate-user $$(id -un)   (or reboot)"; \
	    echo ""; \
	    exit 1; \
	  fi; \
	  start="$$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null || echo 1024)"; \
	  if [ "$$start" -gt 80 ]; then \
	    echo "ERROR: rootless Podman cannot bind the ingress ports 80/443 (host"; \
	    echo "       net.ipv4.ip_unprivileged_port_start=$$start, must be <= 80)."; \
	    echo "       k3d's serverlb would fail: 'rootlessport cannot expose privileged port 80'."; \
	    echo "       The cluster maps 80/443 -> host so *.$(PLATFORM_DOMAIN) reaches Traefik"; \
	    echo "       on standard ports with no port suffix (D-003/D-010)."; \
	    echo ""; \
	    echo "  One-time ROOT fix (persists across reboot):"; \
	    echo "    echo 'net.ipv4.ip_unprivileged_port_start=80' | \\"; \
	    echo "      sudo tee /etc/sysctl.d/99-k3d-unprivileged-ports.conf"; \
	    echo "    sudo sysctl --system"; \
	    echo ""; \
	    exit 1; \
	  fi; \
	fi
	@echo "preflight OK (TARGET=$(TARGET), runtime=$(if $(RUNTIME_ENV),rootless-podman,docker))"

# ---- cluster lifecycle -----------------------------------------------------
.PHONY: cluster-up
# (Podman only) Pre-create the cluster network + a standalone k3d-managed
# registry on it, so `cluster create` can `--registry-use` it instead of the
# inline `registries.create` that hard-fails on Podman's missing "bridge"
# network. Idempotent: skips the network/registry if they already exist.
.PHONY: _ensure-registry-podman
_ensure-registry-podman:
	@if [ "$(IS_PODMAN)" = "yes" ]; then \
	  if ! docker network inspect "$(CLUSTER_NETWORK)" >/dev/null 2>&1; then \
	    echo "creating podman network '$(CLUSTER_NETWORK)' for k3d..."; \
	    docker network create "$(CLUSTER_NETWORK)" >/dev/null; \
	  fi; \
	  if ! env $(RUNTIME_ENV) k3d registry list 2>/dev/null | awk 'NR>1{print $$1}' | grep -qx "$(REGISTRY_HOST)"; then \
	    echo "creating standalone k3d registry '$(REGISTRY_HOST)' on '$(CLUSTER_NETWORK)'..."; \
	    env $(RUNTIME_ENV) k3d registry create "$(REGISTRY_CREATE_NAME)" \
	      --default-network "$(CLUSTER_NETWORK)" --port "0.0.0.0:$(REGISTRY_PORT)"; \
	  else \
	    echo "k3d registry '$(REGISTRY_HOST)' already exists"; \
	  fi; \
	fi

cluster-up: preflight ## Create the k3d cluster from $(K3D_CONFIG) if it does not exist (idempotent)
	@test -f "$(K3D_CONFIG)" || { echo "ERROR: $(K3D_CONFIG) not found (TARGET=$(TARGET) has no k3d-config; real-k3s is provisioned out-of-band)."; exit 1; }
	@$(MAKE) --no-print-directory _ensure-registry-hosts
	@$(MAKE) --no-print-directory _ensure-registry-insecure
	@if env $(RUNTIME_ENV) k3d cluster list 2>/dev/null | awk 'NR>1{print $$1}' | grep -qx "$(CLUSTER_NAME)"; then \
	  echo "cluster '$(CLUSTER_NAME)' already exists — ensuring it is started"; \
	  env $(RUNTIME_ENV) k3d cluster start "$(CLUSTER_NAME)" >/dev/null 2>&1 || true; \
	elif [ "$(IS_PODMAN)" = "yes" ]; then \
	  $(MAKE) --no-print-directory _ensure-registry-podman; \
	  tmpcfg="$$(mktemp --suffix=.k3d.yaml)"; \
	  awk 'BEGIN{skip=0} /^registries:/{skip=1; next} skip && /^[^[:space:]#]/{skip=0} skip{next} {print}' \
	    "$(K3D_CONFIG)" > "$$tmpcfg"; \
	  echo "creating k3d cluster '$(CLUSTER_NAME)' (podman path: pre-created registry on '$(CLUSTER_NETWORK)', inline registry stripped)..."; \
	  env $(RUNTIME_ENV) k3d cluster create --config "$$tmpcfg" \
	    --network "$(CLUSTER_NETWORK)" --registry-use "$(REGISTRY_HOST):$(REGISTRY_PORT)" \
	    --k3s-arg "--kubelet-arg=feature-gates=KubeletInUserNamespace=true@server:*" \
	    --k3s-arg "--kubelet-arg=feature-gates=KubeletInUserNamespace=true@agent:*"; \
	  rm -f "$$tmpcfg"; \
	else \
	  echo "creating k3d cluster '$(CLUSTER_NAME)' from $(K3D_CONFIG)..."; \
	  env $(RUNTIME_ENV) k3d cluster create --config "$(K3D_CONFIG)"; \
	fi
	@echo "waiting for node(s) to be Ready..."
	@kubectl --context "k3d-$(CLUSTER_NAME)" wait --for=condition=Ready nodes --all --timeout=180s
	@$(MAKE) --no-print-directory cluster-info

.PHONY: cluster-down
cluster-down: ## Delete the k3d cluster (idempotent — no error if absent)
	@if env $(RUNTIME_ENV) k3d cluster list 2>/dev/null | awk 'NR>1{print $$1}' | grep -qx "$(CLUSTER_NAME)"; then \
	  echo "deleting k3d cluster '$(CLUSTER_NAME)'..."; \
	  env $(RUNTIME_ENV) k3d cluster delete "$(CLUSTER_NAME)"; \
	else \
	  echo "cluster '$(CLUSTER_NAME)' not present — nothing to delete"; \
	fi

# One-command post-reboot recovery. A host reboot leaves the k3d cluster +
# registry containers STOPPED (not deleted), so `cluster-up` is overkill — we
# don't want to recreate, just restart the existing containers and wait for the
# API to come back. `cluster-start` does exactly that, injecting RUNTIME_ENV so
# the rootless-Podman socket is wired automatically (the manual `DOCKER_HOST=...`
# export you'd otherwise repeat by hand). Idempotent: starting already-running
# containers is a no-op.
#
# ORDER MATTERS: start the registry FIRST. It is a standalone container on the
# cluster network (the Podman path pre-creates it there); the k3d serverlb and
# node containerd resolve `$(REGISTRY_HOST)` on that network, so bringing it up
# before the cluster avoids a transient pull/DNS miss while nodes settle. k3d has
# no `registry start`, so we `docker start` the registry container by name
# (== $(REGISTRY_HOST), the name `k3d registry create` lands on).
.PHONY: cluster-start
cluster-start: ## Restart a STOPPED cluster + registry in one command (post-reboot recovery)
	@if ! env $(RUNTIME_ENV) k3d cluster list 2>/dev/null | awk 'NR>1{print $$1}' | grep -qx "$(CLUSTER_NAME)"; then \
	  echo "ERROR: cluster '$(CLUSTER_NAME)' does not exist — run 'make cluster-up' to create it."; \
	  exit 1; \
	fi
	@if env $(RUNTIME_ENV) k3d registry list 2>/dev/null | awk 'NR>1{print $$1}' | grep -qx "$(REGISTRY_HOST)"; then \
	  echo "starting registry '$(REGISTRY_HOST)'..."; \
	  env $(RUNTIME_ENV) docker start "$(REGISTRY_HOST)" >/dev/null 2>&1 || true; \
	else \
	  echo "NOTE: registry '$(REGISTRY_HOST)' not found — image pulls from it will fail until 'make cluster-up' recreates it."; \
	fi
	@echo "starting k3d cluster '$(CLUSTER_NAME)'..."
	@env $(RUNTIME_ENV) k3d cluster start "$(CLUSTER_NAME)"
	@echo "waiting for node(s) to be Ready..."
	@kubectl --context "k3d-$(CLUSTER_NAME)" wait --for=condition=Ready nodes --all --timeout=180s
	@kubectl config use-context "k3d-$(CLUSTER_NAME)" >/dev/null 2>&1 || true
	@$(MAKE) --no-print-directory cluster-info
	@echo "cluster-start: done. (ArgoCD apps may take a minute to re-settle to Healthy after restart.)"

.PHONY: cluster-stop
cluster-stop: ## Stop the cluster + registry without deleting (inverse of cluster-start)
	@if env $(RUNTIME_ENV) k3d cluster list 2>/dev/null | awk 'NR>1{print $$1}' | grep -qx "$(CLUSTER_NAME)"; then \
	  echo "stopping k3d cluster '$(CLUSTER_NAME)'..."; \
	  env $(RUNTIME_ENV) k3d cluster stop "$(CLUSTER_NAME)"; \
	else \
	  echo "cluster '$(CLUSTER_NAME)' not present — nothing to stop"; \
	fi
	@if env $(RUNTIME_ENV) k3d registry list 2>/dev/null | awk 'NR>1{print $$1}' | grep -qx "$(REGISTRY_HOST)"; then \
	  echo "stopping registry '$(REGISTRY_HOST)'..."; \
	  env $(RUNTIME_ENV) docker stop "$(REGISTRY_HOST)" >/dev/null 2>&1 || true; \
	fi

.PHONY: cluster-info
cluster-info: ## Show nodes, registry, and the ingress base URL
	@echo "=== nodes ==="
	@kubectl --context "k3d-$(CLUSTER_NAME)" get nodes -o wide 2>/dev/null || echo "(cluster not reachable)"
	@echo "=== registry ==="
	@env $(RUNTIME_ENV) k3d registry list 2>/dev/null || true
	@echo "=== ingress base ==="
	@echo "  http(s)://<app>.<team>.$(PLATFORM_DOMAIN)  (Traefik on host :80/:443)"

# ADV-002 (REG-001 regression guard): POSITIVE acceptance assertion that a tenant
# app pod actually PULLS its image — i.e. the in-cluster registry mirror key
# matches the overlays' image prefix. A "Synced/Healthy Application" is NOT enough:
# REG-001 shipped with every Application green while every POD was ImagePullBackOff
# (mirror key double-prefixed). This target FAILS LOUDLY if any tenant app pod is
# stuck on image pull, so that class can never regress to a silent green sign-off.
# Secret-not-found / CreateContainerConfigError do NOT fail this check — those are
# the expected pre-re-seal states; only image-pull failures are fatal here.
.PHONY: verify-image-pull
verify-image-pull: ## (ADV-002) Assert tenant app pods get PAST ImagePullBackOff (registry mirror sanity)
	@echo "==> ADV-002: asserting tenant app pods pull their image (no ImagePullBackOff)..."
	@ctx="k3d-$(CLUSTER_NAME)"; bad=0; found=0; \
	for ns in $$(kubectl --context "$$ctx" get ns -l platform.capstone/team -o name 2>/dev/null | cut -d/ -f2); do \
	  for i in $$(seq 1 24); do \
	    reasons="$$(kubectl --context "$$ctx" get pods -n "$$ns" -l app.kubernetes.io/name=sample \
	      -o jsonpath='{range .items[*]}{.status.containerStatuses[*].state.waiting.reason} {end}' 2>/dev/null)"; \
	    [ -z "$$reasons" ] && { sleep 5; continue; }; \
	    found=1; \
	    if echo "$$reasons" | grep -qE 'ImagePullBackOff|ErrImagePull'; then \
	      if [ "$$i" -ge 24 ]; then echo "  FAIL [$$ns]: pod stuck on image pull ($$reasons)"; bad=1; break; fi; \
	      sleep 5; continue; \
	    fi; \
	    echo "  OK   [$$ns]: image pull resolved (state: $$reasons running/secret-pending)"; break; \
	  done; \
	done; \
	if [ "$$found" = 0 ]; then echo "  (no tenant app pods found yet — run after ArgoCD has generated them)"; fi; \
	if [ "$$bad" = 1 ]; then echo "verify-image-pull: FAIL (REG-001 class — registry mirror key mismatch)"; exit 1; fi; \
	echo "verify-image-pull: PASS"

# Ensure `k3d-registry.localhost` resolves on the host so `docker push` works.
# Idempotent: only appends the hosts line if missing, and only if writable.
.PHONY: _ensure-registry-hosts
_ensure-registry-hosts:
	@if ! getent hosts "$(REGISTRY_HOST)" >/dev/null 2>&1; then \
	  if [ -w /etc/hosts ]; then \
	    echo "127.0.0.1 $(REGISTRY_HOST)" >> /etc/hosts && echo "added $(REGISTRY_HOST) to /etc/hosts"; \
	  else \
	    echo "NOTE: '$(REGISTRY_HOST)' does not resolve. Add once (needs root):"; \
	    echo "      echo '127.0.0.1 $(REGISTRY_HOST)' | sudo tee -a /etc/hosts"; \
	  fi; \
	else true; fi

# Mark the k3d registry as INSECURE for the host container engine so `docker/
# podman push` uses plain HTTP (the k3d built-in registry has no TLS). Without
# this the host push fails with `https://.../v2/: http: server gave HTTP
# response to HTTPS client`. The in-cluster containerd pull side is handled by
# k3d's registry wiring, not here. User-owned path -> no root needed. Idempotent.
.PHONY: _ensure-registry-insecure
_ensure-registry-insecure:
	@if [ "$(IS_PODMAN)" = "yes" ]; then \
	  conf="$$HOME/.config/containers/registries.conf.d/k3d.conf"; \
	  if [ ! -f "$$conf" ]; then \
	    mkdir -p "$$(dirname "$$conf")"; \
	    printf '[[registry]]\nlocation = "%s"\ninsecure = true\n' "$(REGISTRY)" > "$$conf" \
	      && echo "wrote rootless-podman insecure-registry config: $$conf"; \
	  else true; fi; \
	else \
	  echo "NOTE: native Docker detected. If host push hits an HTTPS error, add"; \
	  echo "      \"insecure-registries\": [\"$(REGISTRY)\"] to /etc/docker/daemon.json and restart docker."; \
	fi

# ---- ArgoCD bootstrap (T3) -------------------------------------------------
.PHONY: bootstrap
bootstrap: ## (T3) Install ArgoCD + apply the platform project & app-of-apps root (idempotent). Override KUBE_CONTEXT for non-k3d clusters.
	@# Target KUBE_CONTEXT explicitly per-call (does NOT mutate the user's current-context).
	@# Default k3d-$(CLUSTER_NAME); for the Talos cluster pass KUBE_CONTEXT=admin@capstone.
	@kubectl config get-contexts "$(KUBE_CONTEXT)" >/dev/null 2>&1 \
	  || { echo "ERROR: kube-context '$(KUBE_CONTEXT)' not found. For the Talos cluster set KUBECONFIG=clusters/real-talos/talos-kubeconfig and KUBE_CONTEXT=admin@capstone."; exit 1; }
	@echo "==> installing ArgoCD (pinned v3.4.3) into ns argocd on context '$(KUBE_CONTEXT)'..."
	@kubectl --context "$(KUBE_CONTEXT)" create namespace argocd --dry-run=client -o yaml | kubectl --context "$(KUBE_CONTEXT)" apply -f -
	@# Server-side apply: ArgoCD's applicationsets CRD exceeds the 256KB limit on
	@# the client-side `last-applied-configuration` annotation that plain
	@# `kubectl apply` writes (fails: "metadata.annotations: Too long"). SSA stores
	@# no such annotation. --force-conflicts lets us re-own fields on re-run, so it
	@# stays idempotent (the canonical ArgoCD install method for this reason).
	@kubectl --context "$(KUBE_CONTEXT)" apply -k bootstrap/argocd-install --server-side --force-conflicts
	@# ── FRESH-CLUSTER DEADLOCK BREAKER (theme ConfigMap) ──────────────────────
	@# The install patch above volume-mounts `argocd-ui-theme-cm` into argocd-server,
	@# but that ConfigMap is GENERATED by the GitOps platform-svc-argocd-config app —
	@# which cannot sync until argocd-server is Running. On a FRESH cluster that is a
	@# deadlock: argocd-server stays ContainerCreating ("configmap argocd-ui-theme-cm
	@# not found") forever. (k3d never hit it because the cm pre-existed from a prior
	@# sync.) Create the cm here, at install time, from the SAME source-of-truth css so
	@# the mount resolves immediately. INVARIANT-SAFE: the theme cm is a SEPARATE object
	@# from argocd-cm's `ui.cssurl` key — this touches ONLY the standalone cm, never
	@# argocd-cm (so it cannot trip the CSA->SSA ui/oidc wipe). The platform-service
	@# keeps its own generator (same bare name + identical content); ArgoCD adopts the
	@# cm on first sync with zero drift. Idempotent (dry-run|apply).
	@echo "==> creating argocd-ui-theme-cm (fresh-cluster theme mount; platform-svc-argocd-config adopts it on sync)..."
	@kubectl --context "$(KUBE_CONTEXT)" -n argocd create configmap argocd-ui-theme-cm \
	  --from-file=ua-mis.css=platform-services/argocd-config/ua-mis.css \
	  --dry-run=client -o yaml \
	  | kubectl --context "$(KUBE_CONTEXT)" apply --server-side --force-conflicts -f -
	@echo "==> waiting for ArgoCD CRDs to register..."
	@kubectl --context "$(KUBE_CONTEXT)" wait --for=condition=Established \
	  crd/applications.argoproj.io crd/appprojects.argoproj.io crd/applicationsets.argoproj.io \
	  --timeout=120s
	@echo "==> waiting for ArgoCD components to be Available..."
	@kubectl --context "$(KUBE_CONTEXT)" -n argocd rollout status deploy/argocd-server --timeout=300s
	@kubectl --context "$(KUBE_CONTEXT)" -n argocd rollout status deploy/argocd-applicationset-controller --timeout=300s
	@echo "==> applying the platform AppProject + app-of-apps root..."
	@kubectl --context "$(KUBE_CONTEXT)" apply -f bootstrap/platform-appproject.yaml
	@kubectl --context "$(KUBE_CONTEXT)" apply -f bootstrap/root-app.yaml
	@echo "bootstrap complete. Inspect:  kubectl --context $(KUBE_CONTEXT) -n argocd get applications,applicationsets"
	@echo "  admin pw:  kubectl --context $(KUBE_CONTEXT) -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
	@echo "  ACCEPTANCE (ADV-002): once ArgoCD generates the tenant pods, run \`make verify-image-pull\`"
	@echo "                        to assert they get PAST ImagePullBackOff (registry-mirror sanity)."

# Re-apply ONLY the INSTALL-OWNED bootstrap objects to the live cluster. WHY THIS
# EXISTS: bootstrap/argocd-install/ (the upstream ArgoCD install + our argocd-server
# patches) and bootstrap/platform-appproject.yaml are applied ONCE by `make bootstrap`
# and are NOT GitOps-reconciled — by design. The argocd-server Deployment and the
# `platform` AppProject are the chicken-and-egg roots ArgoCD's own apps live in/run
# on, so the application-controller does not manage them. Consequence: when a PR
# MERGES a change under bootstrap/ (e.g. an argocd-server volume mount, a
# server.insecure flag, or a new sourceRepos allowlist entry), git is updated but the
# CLUSTER stays stale until someone re-applies. We hit this twice: the Harbor chart
# blocked on a missing `helm.goharbor.io` sourceRepos entry, and the UI-theme CSS
# 404'd because the argocd-server volume mount never reached the live Deployment.
#
# RUN THIS after merging ANY PR that touches bootstrap/ (and after the human confirms
# the merge landed). Idempotent + safe to run repeatedly: server-side apply with
# --force-conflicts re-owns fields without the client-side last-applied annotation
# (the same flags `make bootstrap` uses for the install — see that target for why
# SSA is required). It does NOT change the manifests, only reconciles the live
# objects to match git. It does NOT touch root-app or any GitOps-synced platform
# service (those self-heal via ArgoCD).
#
# ⚠ argocd-cm LAYERING — THE OUTAGE THIS TARGET MUST PREVENT (verified live 2026-06-16):
# argocd-cm is CO-MANAGED. The install (this target) ships ONLY the
# `resource.customizations.*` / `resource.exclusions` keys; the GitOps
# `platform-svc-argocd-config` app owns the `ui.*` (theme/banner) + `oidc.*` (SSO) keys.
# A STANDALONE `kubectl apply -k bootstrap/argocd-install --server-side --force-conflicts`
# WIPED the ENTIRE argocd-cm.data live (oidc.config, url, ALL ui.* gone -> SSO login
# broke), because the live argocd-cm carried a stale
# `kubectl.kubernetes.io/last-applied-configuration` annotation (written by ArgoCD's
# legacy client-side apply) that LISTED the ui.*/oidc keys: the CSA->SSA migration that
# `--force-conflicts` performs PRUNES any last-applied field absent from the applied
# manifest. `make bootstrap` only survives this because the GitOps app applies the
# ui/oidc keys AFTER the install apply — a standalone re-apply has no such follow-up, so
# it strips them and DOES NOT self-heal (passive selfHeal did NOT restore; only a
# FORCE-sync of platform-svc-argocd-config did). So this target must actively re-assert.
#
# ORDER IS LOAD-BEARING:
#   0. STRIP the stale CSA annotation first  -> removes the prune trigger entirely.
#   1. apply bootstrap/argocd-install (SSA)  -> may still touch resource.customizations.*.
#   2. apply platform-appproject (SSA).
#   3. FORCE-SYNC platform-svc-argocd-config -> re-asserts ui.*/oidc from git (the PROVEN
#      restore; a hard refresh / passive selfHeal is NOT enough). BEFORE the rollout.
#   4. THEN rollout-restart argocd-server     -> so it reads the RESTORED oidc.config
#      (restarting before re-assert would serve a wiped config = SSO down in the window).
#   5. ASSERT oidc.config AND ui.cssurl are present live -> FAIL LOUDLY otherwise.
.PHONY: bootstrap-reapply
bootstrap-reapply: ## Re-apply install-owned bootstrap objects after a bootstrap/ change; force-re-asserts + verifies argocd-cm theme/SSO keys (wipe-safe). Override KUBE_CONTEXT for non-k3d clusters.
	@ctx="$(KUBE_CONTEXT)"; \
	echo "==> [0/5] stripping any stale last-applied-configuration annotation on argocd-cm (removes the CSA->SSA prune trigger)..."; \
	kubectl --context "$$ctx" -n argocd annotate cm argocd-cm kubectl.kubernetes.io/last-applied-configuration- >/dev/null 2>&1 || true; \
	echo "==> [1/5] re-applying bootstrap/argocd-install (server-side, force-conflicts)..."; \
	kubectl --context "$$ctx" apply -k bootstrap/argocd-install --server-side --force-conflicts; \
	echo "==> [1.5/5] ensuring argocd-ui-theme-cm exists (the install patch mounts it; absent -> the step-4 rollout would deadlock on a cluster missing the cm)..."; \
	kubectl --context "$$ctx" -n argocd create configmap argocd-ui-theme-cm \
	  --from-file=ua-mis.css=platform-services/argocd-config/ua-mis.css \
	  --dry-run=client -o yaml | kubectl --context "$$ctx" apply --server-side --force-conflicts -f - >/dev/null; \
	echo "==> [2/5] re-applying bootstrap/platform-appproject.yaml (server-side, force-conflicts)..."; \
	kubectl --context "$$ctx" apply -f bootstrap/platform-appproject.yaml --server-side --force-conflicts; \
	echo "==> [3/5] FORCE-syncing platform-svc-argocd-config to re-assert argocd-cm theme/SSO keys (BEFORE the rollout)..."; \
	if kubectl --context "$$ctx" -n argocd get application platform-svc-argocd-config >/dev/null 2>&1; then \
	  kubectl --context "$$ctx" -n argocd patch application platform-svc-argocd-config --type merge \
	    -p '{"operation":{"initiatedBy":{"username":"bootstrap-reapply"},"sync":{"syncStrategy":{"apply":{"force":true}}}}}' >/dev/null; \
	  echo "    waiting for the force-sync to complete..."; \
	  for i in $$(seq 1 24); do \
	    ph="$$(kubectl --context "$$ctx" -n argocd get application platform-svc-argocd-config -o jsonpath='{.status.operationState.phase}' 2>/dev/null)"; \
	    case "$$ph" in Succeeded) echo "    force-sync Succeeded."; break;; Failed|Error) echo "    force-sync $$ph"; break;; esac; \
	    sleep 5; \
	  done; \
	else \
	  echo "    (platform-svc-argocd-config app not found — skipping re-assert; run after \`make bootstrap\`)"; \
	fi; \
	echo "==> [4/5] rolling argocd-server so it re-reads the restored oidc.config + any Deployment-spec change (no-op if unchanged)..."; \
	kubectl --context "$$ctx" -n argocd rollout restart deploy/argocd-server; \
	kubectl --context "$$ctx" -n argocd rollout status deploy/argocd-server --timeout=180s; \
	echo "==> [5/5] ASSERTING argocd-cm GitOps keys survived (theme + SSO)..."; \
	ok=1; css=""; oidc=""; \
	for i in $$(seq 1 12); do \
	  css="$$(kubectl --context "$$ctx" -n argocd get cm argocd-cm -o jsonpath='{.data.ui\.cssurl}' 2>/dev/null)"; \
	  oidc="$$(kubectl --context "$$ctx" -n argocd get cm argocd-cm -o jsonpath='{.data.oidc\.config}' 2>/dev/null)"; \
	  if [ -n "$$css" ] && [ -n "$$oidc" ]; then ok=0; break; fi; \
	  sleep 5; \
	done; \
	if [ "$$ok" != 0 ]; then \
	  echo "  FAIL: argocd-cm is MISSING GitOps keys after reapply (ui.cssurl='$$css'; oidc.config empty=$$([ -z "$$oidc" ] && echo yes || echo no)). SSO/theme would be DOWN."; \
	  echo "        Recover now:  kubectl -n argocd patch app platform-svc-argocd-config --type merge -p '{\"operation\":{\"sync\":{\"syncStrategy\":{\"apply\":{\"force\":true}}}}}'"; \
	  exit 1; \
	fi; \
	echo "  OK — ui.cssurl='$$css' present and oidc.config present (theme + SSO intact)."; \
	echo "bootstrap-reapply complete. AppProject (sourceRepos) + argocd-server (mounts/flags) match git; argocd-cm theme/SSO keys force-re-asserted + verified."; \
	echo "  Verify a sourceRepos change:  kubectl -n argocd get appproject platform -o jsonpath='{.spec.sourceRepos}'"; \
	echo "  Verify the UI-theme mount:    curl -sk https://argocd.$(PLATFORM_DOMAIN)/custom/ua-mis.css | head"

# ---- repoURL seam (single swappable git base) ------------------------------
# All ArgoCD sources hardcode https://github.com/UA-MIS/<repo> (the real home).
# For a local run where those repos aren't hosted yet, set GIT_BASE_URL in
# clusters/<target>/values.env and run `make set-repo-base` to rewrite every
# repoURL in one shot. See bootstrap/REPO-SEAM.md. Reversible by setting it back.
DEFAULT_GIT_BASE := https://github.com/UA-MIS

.PHONY: show-repo-base
show-repo-base: ## Show the git base URL currently wired into the manifests
	@echo "configured GIT_BASE_URL: $(GIT_BASE_URL)"
	@echo "occurrences in manifests:"
	@grep -rhoE 'https?://[^/]+/[A-Za-z0-9._-]+/(platform-infra|[A-Za-z0-9_-]+-app|sample-app)' \
	  bootstrap applicationsets tenants 2>/dev/null | sed -E 's#/(platform-infra|[A-Za-z0-9_-]+-app|sample-app)$$##' | sort -u | sed 's/^/  /'

.PHONY: set-repo-base
set-repo-base: ## Rewrite all repoURLs to $(GIT_BASE_URL) (the single swap seam)
	@test -n "$(GIT_BASE_URL)" || { echo "ERROR: GIT_BASE_URL is empty (set it in $(VALUES_ENV))."; exit 1; }
	@echo "rewriting repo base -> $(GIT_BASE_URL) ..."
	@# Match the full host/org prefix (https://HOST/ORG/REPO) and replace HOST/ORG
	@# with GIT_BASE_URL, preserving the repo name (group \1) and any .git suffix.
	@grep -rlE 'https?://[^/]+/[A-Za-z0-9._-]+/(platform-infra|[A-Za-z0-9_-]+-app)' \
	  bootstrap applicationsets tenants 2>/dev/null \
	  | xargs -r sed -i -E 's#https?://[^/]+/[A-Za-z0-9._-]+/(platform-infra|[A-Za-z0-9_-]+-app)#$(GIT_BASE_URL)/\1#g'
	@echo "done. Verify:  make show-repo-base"

# ---- Sealed Secrets helper (T4) --------------------------------------------
.PHONY: seal
seal: ## (T4) kubeseal helper: make seal SECRET=path/to/secret.yaml NS=<ns> > sealed.yaml
	@test -n "$(SECRET)" || { echo "usage: make seal SECRET=path/to/secret.yaml NS=<namespace> > sealed.yaml"; exit 1; }
	@command -v kubeseal >/dev/null || { echo "ERROR: kubeseal not found (install to ~/.local/bin)."; exit 1; }
	@# Seal against the live controller in kube-system. Strict (per-namespace)
	@# scope per D-008: the SealedSecret only decrypts in NS. Output goes to stdout
	@# so callers redirect it into the overlay's sealedsecret.yaml and commit it.
	@kubeseal \
	  --controller-namespace kube-system \
	  --controller-name sealed-secrets-controller \
	  $(if $(NS),--namespace $(NS),) \
	  --format yaml < "$(SECRET)"

# ---- Harbor per-team onboarding (P2.2, D-026) ------------------------------
# Two steps, both keyed on the SINGLE canonical `<name>` slug (D-026). See
# platform-services/harbor-onboarding/README.md.
HARBOR_NS       ?= harbor
# HARBOR_HOST is baked into the sealed docker-registry secret (--docker-server) and
# MUST equal the registry host the image is pushed/pulled at. It derives from
# PLATFORM_DOMAIN, which comes from the SELECTED TARGET's values.env — NOT from
# KUBE_CONTEXT. FOOTGUN (cost a failed M1 push, 2026-06-19): running a robot target
# with KUBE_CONTEXT=admin@capstone but WITHOUT TARGET=real-talos seals the LOCAL-k3d
# host (harbor.127-0-0-1.sslip.io) → the cred doesn't match harbor.capstone.uamishub.com
# → push/pull UNAUTHORIZED (anonymous fallback). The _check-harbor-target guard below
# fails loudly on that mismatch (KUBE_CONTEXT is non-k3d but HARBOR_HOST is still the
# k3d default).
HARBOR_HOST     ?= harbor.$(PLATFORM_DOMAIN)

# Guard: catch the "KUBE_CONTEXT points at a real cluster but TARGET (→ HARBOR_HOST)
# still defaults to local-k3d" mismatch before sealing a wrong-host robot secret.
.PHONY: _check-harbor-target
_check-harbor-target:
	@case "$(KUBE_CONTEXT)" in \
	  k3d-*) : ;; \
	  *) case "$(HARBOR_HOST)" in \
	       *sslip.io|*127-0-0-1*) \
	         echo "ERROR: KUBE_CONTEXT='$(KUBE_CONTEXT)' is a non-k3d cluster but HARBOR_HOST='$(HARBOR_HOST)'" >&2; \
	         echo "       is still the local-k3d default — you almost certainly forgot TARGET." >&2; \
	         echo "       The robot secret bakes --docker-server=HARBOR_HOST; a wrong host => push/pull UNAUTHORIZED." >&2; \
	         echo "       Re-run with the matching target, e.g.: make $(MAKECMDGOALS) NAME=$(NAME) TARGET=real-talos KUBE_CONTEXT=$(KUBE_CONTEXT)" >&2; \
	         exit 1 ;; \
	     esac ;; \
	esac
HARBOR_ONBOARD_JOB := platform-services/harbor-onboarding/onboard-team-job.yaml

.PHONY: harbor-onboard
harbor-onboard: ## (P2.2) Onboard team into Harbor: create project <name> + map OIDC group -> Developer. NAME=<name>. Override KUBE_CONTEXT for non-k3d clusters.
	@test -n "$(NAME)" || { echo "usage: make harbor-onboard NAME=<team-slug>"; exit 1; }
	@command -v kubectl >/dev/null || { echo "ERROR: kubectl not found."; exit 1; }
	@# Act on KUBE_CONTEXT (default k3d-$(CLUSTER_NAME); for Talos pass KUBE_CONTEXT=admin@capstone).
	@kubectl config get-contexts "$(KUBE_CONTEXT)" >/dev/null 2>&1 \
	  || { echo "ERROR: kube-context '$(KUBE_CONTEXT)' not found. For the Talos cluster set KUBECONFIG=clusters/real-talos/talos-kubeconfig and KUBE_CONTEXT=admin@capstone."; exit 1; }
	@# Substitute the __TEAM__ token and apply the idempotent onboarding Job into
	@# the harbor ns (admin creds stay in-cluster — read by the Job via secretKeyRef).
	@echo "==> onboarding team '$(NAME)' into Harbor (project + OIDC Developer mapping) on context '$(KUBE_CONTEXT)'..."
	@sed 's/__TEAM__/$(NAME)/g' "$(HARBOR_ONBOARD_JOB)" \
	  | kubectl --context "$(KUBE_CONTEXT)" apply -f -
	@echo "==> waiting for the onboarding Job to complete..."
	@kubectl --context "$(KUBE_CONTEXT)" -n "$(HARBOR_NS)" \
	  wait --for=condition=complete --timeout=300s job/harbor-onboard-$(NAME) \
	  || { echo "Job did not complete — logs:"; kubectl --context "$(KUBE_CONTEXT)" -n "$(HARBOR_NS)" logs job/harbor-onboard-$(NAME) --tail=40; exit 1; }
	@kubectl --context "$(KUBE_CONTEXT)" -n "$(HARBOR_NS)" logs job/harbor-onboard-$(NAME) --tail=20
	@echo "harbor-onboard: DONE for '$(NAME)'. NEXT: make harbor-robot NAME=$(NAME) ENV=dev > .../harbor-pull-sealed.yaml"

# Namespace the PULL secret seals into. Defaults to the tenant convention
# <name>-<env> (where team workloads run). Override PULL_NS for a PLATFORM service
# that runs in a fixed namespace (e.g. The Process: NAME=backstage PULL_NS=backstage),
# mirroring the RUNNER_NS override on harbor-push-robot — the pull secret must land in
# the namespace that actually consumes it, or the imagePullSecret is in the wrong ns.
PULL_NS ?= $(NAME)-$(ENV)

.PHONY: harbor-robot
harbor-robot: _check-harbor-target ## (P2.2) Create a pull robot for project <name> -> SealedSecret on stdout. NAME=<name> ENV=<env> [PULL_NS=<name>-<env>]. Override KUBE_CONTEXT (+ TARGET) for non-k3d clusters.
	@test -n "$(NAME)" || { echo "usage: make harbor-robot NAME=<team-slug> ENV=<env> [PULL_NS=<ns>] > harbor-pull-sealed.yaml"; exit 1; }
	@test -n "$(ENV)"  || { echo "usage: make harbor-robot NAME=<team-slug> ENV=<env> (e.g. dev/staging/prod); ENV still names the robot/file even when PULL_NS is set"; exit 1; }
	@command -v kubeseal >/dev/null || { echo "ERROR: kubeseal not found (install to ~/.local/bin)."; exit 1; }
	@kubectl config get-contexts "$(KUBE_CONTEXT)" >/dev/null 2>&1 \
	  || { echo "ERROR: kube-context '$(KUBE_CONTEXT)' not found. For the Talos cluster set KUBECONFIG=clusters/real-talos/talos-kubeconfig and KUBE_CONTEXT=admin@capstone." >&2; exit 1; }
	@# Create a project-scoped PULL robot via the Harbor API from INSIDE the cluster
	@# (a transient Job in the harbor ns) so the admin password is read from the
	@# in-cluster Secret via secretKeyRef and never touches the host shell/argv. The
	@# robot token is Harbor-generated + one-time, so this step is imperative (it
	@# cannot be GitOps). The Job logs the raw {name,secret} JSON; we capture it,
	@# build a docker-registry Secret, and kubeseal it (strict to <name>-<env>) to
	@# STDOUT for the caller to redirect into the team overlay + commit. All human-
	@# readable progress goes to STDERR so STDOUT is clean SealedSecret YAML.
	@set -e; \
	  job="harbor-robot-$(NAME)-$(ENV)"; ns="$(HARBOR_NS)"; ctx="$(KUBE_CONTEXT)"; \
	  echo "==> creating pull robot for project '$(NAME)' via in-cluster Job '$$job'..." >&2; \
	  kubectl --context "$$ctx" -n "$$ns" delete job "$$job" --ignore-not-found >/dev/null 2>&1 || true; \
	  printf '%s\n' \
	    'apiVersion: batch/v1' 'kind: Job' 'metadata:' "  name: $$job" "  namespace: $$ns" \
	    'spec:' '  backoffLimit: 3' '  ttlSecondsAfterFinished: 120' '  template:' '    spec:' \
	    '      restartPolicy: Never' '      containers:' '      - name: robot' \
	    '        image: curlimages/curl:8.11.1' \
	    '        env:' '        - name: HARBOR_ADMIN_PASSWORD' '          valueFrom:' \
	    '            secretKeyRef: { name: harbor-admin, key: HARBOR_ADMIN_PASSWORD }' \
	    '        command: ["/bin/sh","-eu","-c"]' \
	    '        args:' \
	    '        - >-' \
	    '          curl -sS -u "admin:$$HARBOR_ADMIN_PASSWORD"' \
	    '          -X POST http://harbor-core.harbor.svc:80/api/v2.0/robots' \
	    "          -H 'Content-Type: application/json'" \
	    "          -d '{\"name\":\"$(NAME)-pull\",\"duration\":-1,\"level\":\"project\",\"description\":\"per-team pull robot ($(NAME))\",\"permissions\":[{\"kind\":\"project\",\"namespace\":\"$(NAME)\",\"access\":[{\"resource\":\"repository\",\"action\":\"pull\"}]}]}'" \
	  | kubectl --context "$$ctx" apply -f - >&2; \
	  kubectl --context "$$ctx" -n "$$ns" wait --for=condition=complete --timeout=120s job/"$$job" >&2 \
	    || { echo "ERROR: robot Job failed:" >&2; kubectl --context "$$ctx" -n "$$ns" logs job/"$$job" >&2; exit 1; }; \
	  json=$$(kubectl --context "$$ctx" -n "$$ns" logs job/"$$job"); \
	  rname=$$(printf '%s' "$$json" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p'); \
	  rsec=$$(printf '%s'  "$$json" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p'); \
	  kubectl --context "$$ctx" -n "$$ns" delete job "$$job" --ignore-not-found >/dev/null 2>&1 || true; \
	  if [ -z "$$rname" ] || [ -z "$$rsec" ]; then echo "ERROR: could not parse robot {name,secret} from: $$json" >&2; exit 1; fi; \
	  echo "==> robot '$$rname' created (pull-only on '$(NAME)'); sealing into $(PULL_NS)..." >&2; \
	  kubectl create secret docker-registry harbor-pull \
	    --docker-server="$(HARBOR_HOST)" \
	    --docker-username="$$rname" --docker-password="$$rsec" \
	    -n "$(PULL_NS)" --dry-run=client -o yaml \
	  | kubeseal --controller-namespace kube-system \
	      --controller-name sealed-secrets-controller \
	      --namespace "$(PULL_NS)" --format yaml

# Namespace the CI PUSH secret seals into (where the ARC runner consumes it). The
# scale set runs in arc-runners (P2.3); override RUNNER_NS if the workflow mounts it
# elsewhere (contract with developer).
RUNNER_NS ?= arc-runners

# Name of the sealed PUSH Secret. Default `harbor-push` is the SHARED, single-team
# secret the org-wide `ua-mis-kaniko` scale set's hook-template mounts (last-write-
# wins across teams — retro #4). For the PER-TEAM model (multiple scale sets, one
# per team, each hook-template referencing its own secret) override this to
# `harbor-push-<team>` so two teams can hold push creds concurrently without
# collision — see platform-services/arc/per-team/README.md.
#   make harbor-push-robot NAME=v1check PUSH_SECRET_NAME=harbor-push-v1check ...
PUSH_SECRET_NAME ?= harbor-push

.PHONY: harbor-push-robot
harbor-push-robot: _check-harbor-target ## (P2.3) Create a CI PUSH robot for project <name> -> CI push SealedSecret on stdout. NAME=<name> [RUNNER_NS=arc-runners] [PUSH_SECRET_NAME=harbor-push]. Override KUBE_CONTEXT (+ TARGET) for non-k3d clusters.
	@test -n "$(NAME)" || { echo "usage: make harbor-push-robot NAME=<team-slug> [RUNNER_NS=arc-runners] [PUSH_SECRET_NAME=harbor-push-<team>] > harbor-push-sealed.yaml"; exit 1; }
	@command -v kubeseal >/dev/null || { echo "ERROR: kubeseal not found (install to ~/.local/bin)."; exit 1; }
	@kubectl config get-contexts "$(KUBE_CONTEXT)" >/dev/null 2>&1 \
	  || { echo "ERROR: kube-context '$(KUBE_CONTEXT)' not found. For the Talos cluster set KUBECONFIG=clusters/real-talos/talos-kubeconfig and KUBE_CONTEXT=admin@capstone." >&2; exit 1; }
	@# CI (Kaniko) PUSH robot — LEAST PRIVILEGE: scoped to project <name> ONLY, so a
	@# build can push to its OWN team's Harbor project and NO other. Harbor requires
	@# `pull` ALONGSIDE `push` (you can't push without pull), so the access list is
	@# pull+push on `repository` for project <name> — nothing cluster/system-wide.
	@# ALSO grants repository read+list, artifact read+list, and artifact-addition
	@# read (supply-chain hardening): the reusable CI's Trivy gate (supply-chain-
	@# verify composite action) (1) polls Harbor's own scan-on-push result via GET
	@# .../artifacts/<ref>?with_scan_overview=true — GetArtifact, which requires
	@# resource "artifact" action "read" (rbac/const.go ResourceArtifact) — then
	@# (2) reads the full per-CVE finding list via GET .../artifacts/<ref>/additions/
	@# vulnerabilities — GetVulnerabilitiesAddition, which requires resource
	@# "artifact-addition" action "read" (rbac/const.go ResourceArtifactAddition).
	@# ⚠ CORRECTED: an earlier pass on this target granted `{"resource":"scan",
	@# "action":"read"}` instead, which does NOT gate either of the above two calls
	@# (verified against goharbor/harbor's own RBAC source and against the live
	@# 403 on additions/vulnerabilities even with scan:read present) — dropped here.
	@# Still nothing beyond THIS team's own project. ⚠ Re-run this target for every
	@# ALREADY-onboarded team (re-seal the refreshed harbor-push-sealed.yaml) or
	@# their CI's Trivy-gate step 403s until re-minted — OR, to avoid rotating the
	@# robot's secret (which would break the already-sealed CI docker config), PUT
	@# the additional permissions onto the EXISTING robot instead: fetch its current
	@# `permissions` via GET /api/v2.0/robots/{id}, append the four new access
	@# entries below under its `kind:project,namespace:<team>` block, then PUT the
	@# full permissions array back (plus the unchanged description/disable/duration/
	@# level/name — Harbor 400s if level or name differ from the existing robot).
	@# Same in-cluster pattern as harbor-robot: admin pw read via secretKeyRef (never
	@# argv), token captured from the Job log, built into a docker-registry Secret
	@# named `harbor-push`, kubesealed (strict) into RUNNER_NS -> STDOUT (clean YAML;
	@# progress on STDERR). The CI robot is a CI-SYSTEM cred (not per-env): one push
	@# robot per team, consumed by the runner that builds that team's image.
	@set -e; \
	  job="harbor-pushrobot-$(NAME)"; ns="$(HARBOR_NS)"; ctx="$(KUBE_CONTEXT)"; \
	  echo "==> creating PUSH robot for project '$(NAME)' via in-cluster Job '$$job'..." >&2; \
	  kubectl --context "$$ctx" -n "$$ns" delete job "$$job" --ignore-not-found >/dev/null 2>&1 || true; \
	  printf '%s\n' \
	    'apiVersion: batch/v1' 'kind: Job' 'metadata:' "  name: $$job" "  namespace: $$ns" \
	    'spec:' '  backoffLimit: 3' '  ttlSecondsAfterFinished: 120' '  template:' '    spec:' \
	    '      restartPolicy: Never' '      containers:' '      - name: robot' \
	    '        image: curlimages/curl:8.11.1' \
	    '        env:' '        - name: HARBOR_ADMIN_PASSWORD' '          valueFrom:' \
	    '            secretKeyRef: { name: harbor-admin, key: HARBOR_ADMIN_PASSWORD }' \
	    '        command: ["/bin/sh","-eu","-c"]' \
	    '        args:' \
	    '        - >-' \
	    '          curl -sS -u "admin:$$HARBOR_ADMIN_PASSWORD"' \
	    '          -X POST http://harbor-core.harbor.svc:80/api/v2.0/robots' \
	    "          -H 'Content-Type: application/json'" \
	    "          -d '{\"name\":\"$(NAME)-ci-push\",\"duration\":-1,\"level\":\"project\",\"description\":\"per-team CI push robot ($(NAME), Kaniko)\",\"permissions\":[{\"kind\":\"project\",\"namespace\":\"$(NAME)\",\"access\":[{\"resource\":\"repository\",\"action\":\"pull\"},{\"resource\":\"repository\",\"action\":\"push\"},{\"resource\":\"repository\",\"action\":\"read\"},{\"resource\":\"repository\",\"action\":\"list\"},{\"resource\":\"artifact\",\"action\":\"read\"},{\"resource\":\"artifact\",\"action\":\"list\"},{\"resource\":\"artifact-addition\",\"action\":\"read\"}]}]}'" \
	  | kubectl --context "$$ctx" apply -f - >&2; \
	  kubectl --context "$$ctx" -n "$$ns" wait --for=condition=complete --timeout=120s job/"$$job" >&2 \
	    || { echo "ERROR: push-robot Job failed:" >&2; kubectl --context "$$ctx" -n "$$ns" logs job/"$$job" >&2; exit 1; }; \
	  json=$$(kubectl --context "$$ctx" -n "$$ns" logs job/"$$job"); \
	  rname=$$(printf '%s' "$$json" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p'); \
	  rsec=$$(printf '%s'  "$$json" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p'); \
	  kubectl --context "$$ctx" -n "$$ns" delete job "$$job" --ignore-not-found >/dev/null 2>&1 || true; \
	  if [ -z "$$rname" ] || [ -z "$$rsec" ]; then echo "ERROR: could not parse robot {name,secret} from: $$json" >&2; exit 1; fi; \
	  echo "==> robot '$$rname' created (pull+push on '$(NAME)' ONLY); sealing as '$(PUSH_SECRET_NAME)' into $(RUNNER_NS)..." >&2; \
	  kubectl create secret docker-registry "$(PUSH_SECRET_NAME)" \
	    --docker-server="$(HARBOR_HOST)" \
	    --docker-username="$$rname" --docker-password="$$rsec" \
	    -n "$(RUNNER_NS)" --dry-run=client -o yaml \
	  | kubeseal --controller-namespace kube-system \
	      --controller-name sealed-secrets-controller \
	      --namespace "$(RUNNER_NS)" --format yaml

# ---- Vault per-tenant onboarding (ADR-030 B1, ESO+Vault) -------------------
# The READ-path glue the scaffolder (#106) doesn't do: per onboarded <team>-<env>,
# (1) create the per-tenant Vault role/policy (tenant-role.sh — scopes a tenant SA to
#     secret/data/tenants/<team>/* ONLY, least privilege), and
# (2) materialize the in-ns `vault-ca` ConfigMap (key ca.crt) the rendered SecretStore's
#     caProvider reads — a namespaced SecretStore can't cross-ns reference the
#     vault-server-tls Secret in ns `vault`, so each tenant ns needs its own copy of
#     the (public) CA. Idempotent; re-runnable. Override KUBE_CONTEXT for non-k3d.
# ⚠ The chart sets VAULT_ADDR but NOT VAULT_CACERT, so the in-pod exec is env-prefixed
#   with the mounted CA path (else x509 "unknown authority").
VAULT_NS         ?= vault
VAULT_CA_PATH    ?= /vault/userconfig/vault-server-tls/ca.crt
TENANT_ROLE_SH   := platform-services/external-secrets/vault-policies/tenant-role.sh

.PHONY: vault-onboard
vault-onboard: ## (ESO+Vault) Onboard a tenant for secrets: per-team Vault role + in-ns vault-ca ConfigMap. NAME=<team> ENV=<env>. Override KUBE_CONTEXT for non-k3d.
	@test -n "$(NAME)" || { echo "usage: make vault-onboard NAME=<team-slug> ENV=<env>"; exit 1; }
	@test -n "$(ENV)"  || { echo "usage: make vault-onboard NAME=<team-slug> ENV=<env> (dev/staging/prod/preview)"; exit 1; }
	@command -v kubectl >/dev/null || { echo "ERROR: kubectl not found."; exit 1; }
	@kubectl config get-contexts "$(KUBE_CONTEXT)" >/dev/null 2>&1 \
	  || { echo "ERROR: kube-context '$(KUBE_CONTEXT)' not found. For Talos set KUBECONFIG=clusters/real-talos/talos-kubeconfig and KUBE_CONTEXT=admin@capstone."; exit 1; }
	@ctx="$(KUBE_CONTEXT)"; tns="$(NAME)-$(ENV)"; \
	  echo "==> [1/2] creating per-tenant Vault role/policy (tenant-$(NAME)) via vault-0 on '$$ctx'..."; \
	  kubectl --context "$$ctx" -n "$(VAULT_NS)" exec -i vault-0 -- \
	    env VAULT_CACERT="$(VAULT_CA_PATH)" sh -s -- "$(NAME)" "$(ENV)" < "$(TENANT_ROLE_SH)"; \
	  echo "==> [2/2] materializing the vault-ca ConfigMap in ns '$$tns' (caProvider source for the SecretStore)..."; \
	  kubectl --context "$$ctx" create namespace "$$tns" --dry-run=client -o yaml | kubectl --context "$$ctx" apply -f - >/dev/null; \
	  ca=$$(kubectl --context "$$ctx" -n "$(VAULT_NS)" get secret vault-server-tls -o jsonpath='{.data.ca\.crt}' | base64 -d); \
	  if [ -z "$$ca" ]; then echo "ERROR: vault-server-tls ca.crt empty/not found in ns $(VAULT_NS)"; exit 1; fi; \
	  printf '%s' "$$ca" | kubectl --context "$$ctx" -n "$$tns" create configmap vault-ca --from-file=ca.crt=/dev/stdin \
	    --dry-run=client -o yaml | kubectl --context "$$ctx" apply -f -; \
	  echo "vault-onboard: DONE for '$$tns'. NEXT: apply the rendered SecretStore+ExternalSecret (scaffolder #106 / secretstore-template.yaml), then put values via the Backstage secrets-UX or 'vault kv put secret/tenants/$(NAME)/$(ENV)/app KEY=val'."

# ---- GitOps vault-ca (declarative alternative to vault-onboard's [2/2] step) ------
# Emits the per-tenant `vault-ca` ConfigMap (the PUBLIC Vault CA, git-safe — NOT secret
# material) to STDOUT so the operator can commit it into tenants/team-<team>/ and let
# ArgoCD reconcile it declaratively (selfHeal keeps the stable CA correct — safe ONLY
# because the value is the REAL CA, never a placeholder). This moves vault-ca off the
# imperative `make vault-onboard` path and into git, per the ESO+Vault onboarding goal.
# The Vault ROLE still needs the operator's keyboard (tenant-role.sh / vault-onboard);
# only the CA ConfigMap is GitOps-able. Reads the public CA from the cluster, so the
# OPERATOR runs this (a prod read) — agents are classifier-gated from prod secret reads.
#   make vault-ca-manifest NAME=v1check ENV=dev KUBE_CONTEXT=admin@capstone \
#     > tenants/team-v1check/vault-ca-dev.yaml   # then commit
.PHONY: vault-ca-manifest
vault-ca-manifest: ## (ESO+Vault) Emit the per-tenant `vault-ca` ConfigMap (public CA) for GitOps. NAME=<team> ENV=<env> > tenants/team-<team>/vault-ca-<env>.yaml. Override KUBE_CONTEXT for non-k3d.
	@test -n "$(NAME)" || { echo "usage: make vault-ca-manifest NAME=<team-slug> ENV=<env> > tenants/team-<team>/vault-ca-<env>.yaml" >&2; exit 1; }
	@test -n "$(ENV)"  || { echo "usage: make vault-ca-manifest NAME=<team-slug> ENV=<env> (dev/staging/prod/preview)" >&2; exit 1; }
	@kubectl config get-contexts "$(KUBE_CONTEXT)" >/dev/null 2>&1 \
	  || { echo "ERROR: kube-context '$(KUBE_CONTEXT)' not found. For Talos set KUBECONFIG=clusters/real-talos/talos-kubeconfig and KUBE_CONTEXT=admin@capstone." >&2; exit 1; }
	@ctx="$(KUBE_CONTEXT)"; tns="$(NAME)-$(ENV)"; \
	  echo "==> reading PUBLIC Vault CA (vault-server-tls) and emitting vault-ca ConfigMap for ns '$$tns'..." >&2; \
	  ca=$$(kubectl --context "$$ctx" -n "$(VAULT_NS)" get secret vault-server-tls -o jsonpath='{.data.ca\.crt}' | base64 -d); \
	  if [ -z "$$ca" ]; then echo "ERROR: vault-server-tls ca.crt empty/not found in ns $(VAULT_NS)" >&2; exit 1; fi; \
	  printf '%s' "$$ca" | kubectl --context "$$ctx" -n "$$tns" create configmap vault-ca \
	    --from-file=ca.crt=/dev/stdin --dry-run=client -o yaml \
	  | kubectl label --local -f - -o yaml --dry-run=client \
	      platform.capstone/team="$(NAME)" platform.capstone/env="$(ENV)" platform.capstone/component=tenant

# ---- validation gate (T12 hardening) ---------------------------------------
# Catches the failure classes security flagged so they can't ship again:
#   (1) malformed/divergent tenant RBAC names (the SEC-001 blanket-sed bug),
#   (2) stray non-manifest files in tenant dirs that break recurse-sync (SEC-002),
#   (3) schema-invalid k8s objects,
#   (4) duplicate CapstoneTenant claims for one team (the 2026-07-09 provider
#       apply-fight: two XRs co-managing the same team-keyed netpols churned
#       Cilium policy cluster-wide and starved the Vault raft leader's node),
#   (5) AppProject role groups that are not the group Dex emits (SEC-021/SEC-006 —
#       the same defect class twice: a role bound to a string no identity provider
#       ever produces, which fails SILENTLY as "inert role", never as an error).
# Run before committing tenancy changes; cluster-independent.
.PHONY: validate
validate: ## Static validation of tenant manifests (kubeconform + RBAC-name + stray-file + argocd-rbac-project + claim-uniqueness + dex-board-client + appproject-group + vm-guest-network guards + vm-slot-capacity guards)
	@command -v kubeconform >/dev/null || { echo "ERROR: kubeconform not found (install to ~/.local/bin)."; exit 1; }
	@# ---- preflight: assert every guard can actually READ its own subject ------
	@# Each guard below reduces to a `grep`/`find`/glob over a path. If that path
	@# is missing or renamed, every one of them finds nothing — and "found nothing"
	@# is indistinguishable from "nothing is wrong" unless someone checks. That is
	@# a third failure mode, distinct from the happy path and the defect path: not
	@# "the input is clean" and not "the input is bad", but "I could not read the
	@# input at all". It fails OPEN by default, which is the worst direction for a
	@# security guard, so it is asserted here once rather than six times.
	@fail=0; for p in tenants tenants/_claims tenants/_boards \
	    platform-services/argocd-config/argocd-rbac-cm.yaml \
	    platform-services/dex/configmap.yaml \
	    platform-services/dex/gen-board-clients.py \
	    hack/lint-argocd-rbac-projects.py \
	    hack/lint-appproject-sourcerepos.py \
	    hack/lint-vm-tier-bounds.py \
	    platform-services/backstage/templates/vm-app/template.yaml \
	    tenants/_template-vm/vm/namespaces/vm-prod.yaml \
	    hack/lint-workflow-shell.py \
	    hack/lint-vm-network-config.py \
	    hack/lint-vm-slot-capacity.py \
	    hack/vm-tier-capacity.yaml \
	    platform-services/backstage/templates/vm-app/skeleton-vm/.devops/chart/base/virtualmachine.yaml \
	    platform-services/backstage/templates/vm-app/skeleton-vm/.devops/chart/base/cloud-init.yaml \
	    applicationsets bootstrap; do \
	    [ -e "$$p" ] || { echo "FAIL: guard input missing: $$p"; fail=1; }; \
	  done; \
	  if [ "$$fail" = "1" ]; then \
	    echo "  A guard cannot pass over a subject it cannot find. If a path moved,"; \
	    echo "  update this preflight and the guard that reads it — do not let the"; \
	    echo "  guard silently check nothing."; exit 1; fi
	@echo "==> [1/12] kubeconform -strict on tenant namespace bundles..."
	@# The file list is built with `find`, NOT the glob `tenants/*/namespaces/*.yaml`
	@# this used to use. That glob is one directory too shallow: it matched only
	@# tenants/_template/namespaces/*.yaml and never saw the VM tier's
	@# tenants/*/vm/namespaces/*.yaml, so the only REAL tenant namespace manifest in
	@# the repo was never validated — `+ notAField: boom` in it passed cleanly.
	@files=$$(find tenants -path '*/namespaces/*.yaml' -type f | sort); \
	  [ -n "$$files" ] || { echo "FAIL: no tenant namespace manifests found under tenants/ —"; \
	    echo "      guard [1/12] had nothing to validate, which is not a pass."; exit 1; }; \
	  echo "$$files" | sed 's/^/      + /'; \
	  kubeconform -strict -summary -kubernetes-version 1.31.5 $$files
	@echo "==> [2/12] RBAC-name guard: every Role/RoleBinding name must be 'team-developer'..."
	@bad=$$(grep -rnE '^\s+name:\s+team-[a-z0-9-]+eloper\b' tenants/ | grep -v 'team-developer' || true); \
	  if [ -n "$$bad" ]; then echo "FAIL: malformed RBAC names (SEC-001 regression):"; echo "$$bad"; exit 1; fi; \
	  echo "  OK — no malformed RBAC names"
	@echo "==> [3/12] stray-file guard: tenant dirs may contain only .yaml (recurse-sync safe)..."
	@stray=$$(find tenants -type f ! -name '*.yaml' ! -name 'README.md' || true); \
	  if [ -n "$$stray" ]; then echo "FAIL: non-manifest files in tenants/ (would break recurse sync):"; echo "$$stray"; exit 1; fi; \
	  echo "  OK — no stray non-manifest files"
	@echo "==> [4/12] argocd-rbac project guard: every project token in a 'p, role:...' policy must be an existing AppProject (SEC-006)..."
	@# Was a `grep | sed | grep -v` pipeline. It parsed only the `<project>/<app>`
	@# object form with a `[a-z0-9-]+` token and DISCARDED everything else, so an
	@# underscore or uppercase letter in a slug — or the bare-project object form
	@# `p, role:x, projects, get, x, allow`, which is one of the very lines this
	@# guard was written to catch — vanished silently and the step reported OK.
	@# Unparseable input was indistinguishable from absent input, which is the
	@# SEC-006 defect wearing the guard's own uniform. Now parsed per line, in a
	@# script that can be read and tested. See its docstring.
	@python3 hack/lint-argocd-rbac-projects.py
	@echo "==> [5/12] claim-uniqueness guard: at most ONE CapstoneTenant claim per team+semester..."
	@dups=$$(for f in tenants/_claims/*.yaml; do \
	    [ -f "$$f" ] || continue; \
	    t=$$(sed -nE 's/^  team: *"?([A-Za-z0-9-]+)"?.*/\1/p' "$$f" | head -1); \
	    s=$$(sed -nE 's/^  semester: *"?([A-Za-z0-9-]+)"?.*/\1/p' "$$f" | head -1); \
	    echo "$$t/$$s $$f"; \
	  done | sort | awk '{c[$$1]++; files[$$1]=files[$$1]" "$$2} END {for (k in c) if (c[k]>1) print k":"files[k]}'); \
	  if [ -n "$$dups" ]; then \
	    echo "FAIL: multiple CapstoneTenant claims for the same team+semester."; \
	    echo "Team-keyed namespaces/netpols/quotas would be co-managed by two XRs — the"; \
	    echo "provider-kubernetes reconcile loops fight over the same objects the moment"; \
	    echo "their rendered specs diverge (2026-07-09 Vault/ESO incident). One claim per"; \
	    echo "team; a team's primary app is that claim's appName."; \
	    echo "$$dups"; exit 1; fi; \
	  echo "  OK — one CapstoneTenant claim per team+semester"
	@echo "==> [6/12] dex board-client guard: every tenants/_boards/ entry must have its Dex redirect URI (D-186)..."
	@# Dex has no wildcard redirect URIs, so a provisioned board whose callback is
	@# missing from platform-services/dex/configmap.yaml deploys, goes Ready, serves
	@# its landing page — and fails only when someone clicks "Sign in". Catch it here.
	@python3 platform-services/dex/gen-board-clients.py --check
	@echo "==> [7/12] appproject-group guard: every AppProject role group must be 'UA-MIS:<slug>' (SEC-021)..."
	@# SEC-006 and SEC-021 are the SAME defect in two places, four years of
	@# codebase apart: an ArgoCD role bound to a group string no identity provider
	@# emits. It never errors — the role is simply inert and users fall through to
	@# policy.default — so only a lint catches it. Dex's GitHub connector
	@# (teamNameField: slug, orgs set) emits ONLY `<org>:<team-slug>`.
	@# Covers both blueprint paths and the Crossplane generator.
	@python3 hack/lint-appproject-groups.py
	@# The format check above cannot see whether a slug is a REAL GitHub team, nor
	@# whether students are MEMBERS of it (repo collaborators get no group claim).
	@# Both are required for access to actually work. Cluster/GitHub-dependent, so
	@# it cannot live in this offline gate — `make verify-appproject-groups` does it.
	@echo "  NOTE: slug-resolves-to-a-real-GitHub-team is NOT checked here (needs the"
	@echo "        GitHub API) — run 'make verify-appproject-groups' for that."
	@echo "==> [8/12] appproject-sourceRepos guard: every Application's repoURL must be permitted by its AppProject..."
	@# SEC-006 (guard [4/12]) checks that a policy naming a project refers to an
	@# AppProject that EXISTS. This is the adjacent edge, and it was unguarded: an
	@# Application naming a real project that FORBIDS its repo. ArgoCD answers with
	@# InvalidSpecError and simply stops reconciling — and if the app synced even once
	@# before the restriction landed, it stays Healthy with lastOp "Succeeded" while
	@# every future change silently fails to deploy. That is how
	@# crimson-copies-stripped-vm-prod sat Unknown/Unknown on the live masters lab.
	@# Three outcomes, three messages: fine / project missing / project forbids the repo.
	@python3 hack/lint-appproject-sourcerepos.py
	@echo "==> [9/12] vm-tier bounds guard: the VM wizard's maxima must fit the VM tier's quota + LimitRange..."
	@# The scaffolder form and the namespace bundle are two documents that each look
	@# reasonable alone. On 2026-08-27 they disagreed — form maximum 16Gi against a
	@# tier ceiling of 6Gi — and nothing said so. paper-papas was scaffolded at 8Gi,
	@# the PR merged, ArgoCD synced, the 32Gi disk imported for ten minutes, and only
	@# THEN did the virt-launcher pod get refused at admission:
	@#   maximum memory usage per Container is 6Gi, but limit is 17064Mi
	@# with no pod to inspect and no CrashLoop, because the pod was never created.
	@# This guard moves that discovery from ten minutes into a provision to authoring
	@# time. It checks bounds, not style: raise either document and it fails until the
	@# other follows.
	@python3 hack/lint-vm-tier-bounds.py
	@echo "==> [10/12] workflow-shell guard: every embedded shell body must PARSE (dash/bash -n)..."
	@# A real team was blocked on their first day by ONE APOSTROPHE. A warning message in
	@# the contract's Python step contained the words 'pip install .' in single quotes,
	@# inside an `args: -c '...'` that is itself single-quoted. The apostrophes closed the
	@# quoting early, and every Python component's checks step died with
	@#     install: 1: Syntax error: Unterminated quoted string
	@# BEFORE installing anything or running any test — so build-and-push, bump-dev and
	@# bump-staging were all skipped.
	@#
	@# Every guard we had was green when that shipped: validate, sync-check, a 7/7 mutation
	@# matrix, a third independent implementation agreeing. None of them EXECUTED the tenant
	@# pipeline against a Python component. The gate was not blind to the defect; nothing ran
	@# the code path. This guard is the cheap version of running it: no cluster, no runner,
	@# no tenant — it only tries to parse.
	@python3 hack/lint-workflow-shell.py
	@echo "==> [11/12] VM guest-network guard: the VM scaffold's networking must not be MAC-pinned..."
	@# A VM tenant scaffolded without an explicit `networkData` works on its FIRST
	@# boot and loses all guest networking on its SECOND, permanently and silently.
	@# KubeVirt masquerade hands the guest the launcher POD's MAC, the CNI
	@# regenerates that MAC per pod, cloud-init's fallback netplan is pinned to the
	@# MAC it saw at first boot, and cloud-init does not re-apply network config
	@# unless the instance-id changes -- which a restart does not.
	@#
	@# Measured on paper-papas 2026-08-31: VMI Running, VMI Ready, ssh Service with
	@# a live Endpoint, sshd listening in the guest -- and the launcher tap device at
	@# RX 0 bytes / 0 packets for three days. Every layer above the guest looked
	@# healthy, which is why the search went to the tunnel, the NetworkPolicy and
	@# sshd first. This guard keeps the two fixes (name-matched networkData, and
	@# per-boot network re-application) from being edited away by anyone who has not
	@# spent that day.
	@python3 hack/lint-vm-network-config.py
	@echo "==> [12/12] VM slot guard: a VM tenant that cannot schedule fails SILENTLY..."
	@# The VM chart pins VMs to control-plane nodes and spreads them one per node
	@# with a REQUIRED podAntiAffinity, so the tenant past the last slot never
	@# schedules. It does not say so: the VirtualMachine sits at `Starting`, the
	@# VMI at `Pending`, NO launcher pod is ever created (so there is nothing to
	@# describe and no CrashLoopBackOff), and ArgoCD keeps reporting Synced. It
	@# looks like a slow boot, forever.
	@#
	@# The slot count is DECLARED in hack/vm-tier-capacity.yaml rather than read
	@# from a cluster, because this target is cluster-independent by design. A
	@# declared number can be wrong, but it is wrong visibly, in a diff. Bump it
	@# in the same PR that adds a control-plane node.
	@python3 hack/lint-vm-slot-capacity.py
	@echo "validate: PASS"

# ---- tenant credential audit (SEC-037) -------------------------------------
# DELIBERATELY NOT PART OF `validate`. That target is cluster-independent by
# design so it runs in CI and on a laptop with no kubeconfig; this one reads live
# Secrets and is meaningless without a cluster. Keeping them separate is what
# stops someone "fixing" a failing validate by deleting the check.
#
# WHAT IT CATCHES. A platform-shared credential sitting in a namespace a tenant
# can schedule pods in. SEC-037 (#134): the `ua-mis-backstage` App private key --
# org-wide administration/contents/workflows write, and a branch-protection
# bypass on this repo's main -- was in `ida-llm-prod`, which ArgoCD reconciles
# from a repository the students own, at HEAD. Any pod in a namespace may mount
# any Secret in it, so that is org-admin GitHub from one ordinary commit.
#
# It matches by VALUE FINGERPRINT, not by name or path, because that is how the
# finding was missed: the value had been copied into the tenant's OWN Vault
# subtree, so every path looked correctly scoped. Nothing prints key material.
.PHONY: audit-tenant-credentials
audit-tenant-credentials: ## Find platform-shared credentials in tenant-reachable namespaces (needs a cluster)
	@python3 hack/audit-tenant-credentials.py

# ---- AppProject group resolution (online companion to validate [7/12]) -------
# validate [7/12] proves the group STRING is well-formed. It cannot prove the two
# things that decide whether a student can actually sync:
#   (a) the slug is a real GitHub team, and
#   (b) the students are MEMBERS of that team (repo COLLABORATORS get no group
#       claim from Dex at all, so they hold no team-scoped ArgoCD access).
# Both failed silently for real tenants during the SEC-021 audit, so this target
# exists to make them loud. Needs `gh` authenticated + cluster read access.
.PHONY: verify-appproject-groups
verify-appproject-groups: ## Check every live AppProject role group resolves to a real GitHub team with members
	@python3 hack/verify-appproject-groups.py

# ---- server-side apply check (online companion to validate [8/12]) -----------
# THE LESSON THIS TARGET EXISTS FOR. An AppProject merged with a 337-character
# spec.description. `make validate` passed. `kubeconform -strict` passed. `kubectl apply
# --dry-run=CLIENT` passed. The API server then REJECTED it:
#     spec.description: Too long: may not be longer than 255
# so the object was never created, and the Application that had already been repointed at
# it named a project that did not exist. Structural schema validation is BLIND to a CRD's
# own field constraints — and kubeconform cannot even load a schema for AppProject
# ("could not find schema for AppProject"). Only --dry-run=SERVER sees it, because only
# the API server runs the CRD's validation.
#
# DELIBERATELY NOT PART OF `validate`, for the same reason as verify-appproject-groups
# above: `validate` is cluster-independent by design so it runs in CI and on a laptop with
# no kubeconfig. This one needs a live API server. validate [8/12] carries the cheap offline
# half (the known 255-char limit, read out of the live CRD); this is the authoritative
# check that also covers constraints nobody has hardcoded yet.
#
# Read-only: --dry-run=server changes nothing. Override KUBE_CONTEXT for Talos.
.PHONY: verify-argocd-apply
verify-argocd-apply: ## Server-side dry-run every ArgoCD Application/AppProject (catches CRD field limits kubeconform cannot). Needs a cluster.
	@echo "==> server-side dry-run of ArgoCD manifests (context: $(KUBE_CONTEXT))"
	@# `tenants/_*` is EXCLUDED, and not arbitrarily: those are the un-rendered blueprints
	@# (tenants/_template, tenants/_template-vm) carrying `__TEAM__` / `__APPNAME__`
	@# placeholders, which the API server rejects as invalid RFC-1123 names. The exclusion
	@# is the SAME rule ArgoCD itself applies — applicationsets/tenants-appset.yaml
	@# excludes `path: tenants/_*` from the tenant sync — so this checks exactly the set
	@# that actually reaches a cluster, and nothing that never could.
	@files=$$(grep -rl -E '^kind: (Application|AppProject)$$' --include='*.yaml' \
	    tenants applicationsets bootstrap 2>/dev/null | grep -v '^tenants/_' | sort); \
	  [ -n "$$files" ] || { echo "FAIL: found no Application/AppProject manifests to check —"; \
	    echo "      a dry-run over nothing is not a pass."; exit 1; }; \
	  n=0; bad=0; \
	  for f in $$files; do \
	    n=$$((n+1)); \
	    out=$$(kubectl --context "$(KUBE_CONTEXT)" apply --dry-run=server -f "$$f" 2>&1) || { \
	      echo "FAIL: $$f"; echo "$$out" | sed 's/^/        /'; bad=$$((bad+1)); }; \
	  done; \
	  echo "  checked $$n manifest(s), $$bad rejected by the API server"; \
	  [ "$$bad" -eq 0 ] || exit 1; \
	  echo "  OK — every Application/AppProject is accepted by the live API server"

# ---- reversible tenant on/off switch ---------------------------------------
# Pause a tenant (stop it running + make it VANISH from k9s) and bring it back,
# WITHOUT touching git/repo/Harbor/Vault. Purely imperative kubectl against live
# ArgoCD objects. All the logic (incl. the GitOps reversion-chain handling and
# the PVC data-loss guard) lives in hack/tenant-onoff.sh — see docs/operator/
# tenant-on-off-switch.md.
#
#   make tenant-off TEAM=sample                 # DRY-RUN: print the plan only
#   make tenant-off TEAM=sample DRY_RUN=false   # act (refuses if a ns has a PVC)
#   make tenant-off TEAM=sample DRY_RUN=false FORCE=true   # act + allow PVC loss
#   make tenant-on  TEAM=sample DRY_RUN=false   # reverse it
# For the real Talos cluster add: KUBE_CONTEXT=admin@capstone KUBECONFIG=clusters/real-talos/talos-kubeconfig
DRY_RUN         ?= true
FORCE           ?= false
ARGOCD_NS       ?= argocd
TENANT_ONOFF_SH := hack/tenant-onoff.sh

.PHONY: tenant-off
tenant-off: ## Reversibly PAUSE a tenant: neutralize ArgoCD + delete its namespaces. TEAM=<slug> [DRY_RUN=false] [FORCE=true]. Override KUBE_CONTEXT for Talos.
	@test -n "$(TEAM)" || { echo "usage: make tenant-off TEAM=<slug> [DRY_RUN=false] [FORCE=true]" >&2; exit 1; }
	@DRY_RUN="$(DRY_RUN)" FORCE="$(FORCE)" KUBE_CONTEXT="$(KUBE_CONTEXT)" ARGOCD_NS="$(ARGOCD_NS)" \
	  bash $(TENANT_ONOFF_SH) off "$(TEAM)"

.PHONY: tenant-on
tenant-on: ## Reverse tenant-off: re-enable ArgoCD so it recreates the tenant from git. TEAM=<slug> [DRY_RUN=false]. Override KUBE_CONTEXT for Talos.
	@test -n "$(TEAM)" || { echo "usage: make tenant-on TEAM=<slug> [DRY_RUN=false]" >&2; exit 1; }
	@DRY_RUN="$(DRY_RUN)" KUBE_CONTEXT="$(KUBE_CONTEXT)" ARGOCD_NS="$(ARGOCD_NS)" \
	  bash $(TENANT_ONOFF_SH) on "$(TEAM)"

# ---- multi-cluster: register a satellite cluster with the hub ArgoCD ------
# Wraps `argocd cluster add` with the naming+labelling CONTRACT the scaffolding in
# applicationsets/satellite-clusters-appset.yaml and bootstrap/platform-appproject.yaml
# depend on: the registered cluster NAME must start with `satellite-` (the AppProject
# destinations glob) and carry the label capstone.platform/tier=satellite (the
# ApplicationSet's cluster-generator selector). Get either wrong here and the
# Application is rejected ("cluster not permitted") rather than silently mis-scoped.
#
# This is an IMPERATIVE, one-time, install-owned action against the LIVE hub ArgoCD —
# like the AppProject sourceRepos adds, it is NOT GitOps-reconciled (a cluster
# registration Secret holds live credentials; it does not belong in git). Requires the
# `argocd` CLI already logged in to the hub (`argocd login argocd.$(PLATFORM_DOMAIN)`)
# and the satellite's kubeconfig context already merged locally.
#   make cluster-register CONTEXT=<satellite-kubeconfig-context> NAME=homelab-k3s
# See docs/operator/multi-cluster.md for the full runbook + verification steps.
# Namespaces the hub's argocd-manager ServiceAccount is scoped to on the SATELLITE
# (least privilege — without --namespace, `argocd cluster add` installs a cluster-admin
# argocd-manager on the target). Only the baseline namespace by default; widen with a
# repeat `make cluster-register ... NAMESPACES="capstone-satellite-baseline monitoring"`
# (or `argocd cluster set satellite-<name> --namespace ...`) once a real roadmap
# workload (docs/operator/multi-cluster.md) needs another namespace on that cluster.
NAMESPACES ?= capstone-satellite-baseline

.PHONY: cluster-register
cluster-register: ## Register a satellite cluster with the hub ArgoCD (naming+label contract + least-privilege namespace scope enforced). CONTEXT=<kubeconfig-context> NAME=<short-name> [NAMESPACES="ns1 ns2"].
	@test -n "$(CONTEXT)" || { echo "usage: make cluster-register CONTEXT=<satellite-kubeconfig-context> NAME=<short-name>" >&2; exit 1; }
	@test -n "$(NAME)" || { echo "usage: make cluster-register CONTEXT=<satellite-kubeconfig-context> NAME=<short-name>" >&2; exit 1; }
	@command -v argocd >/dev/null || { echo "ERROR: argocd CLI not found. Install it and 'argocd login argocd.$(PLATFORM_DOMAIN)' first." >&2; exit 1; }
	@kubectl config get-contexts "$(CONTEXT)" >/dev/null 2>&1 \
	  || { echo "ERROR: kube-context '$(CONTEXT)' not found locally. Merge the satellite's kubeconfig first (KUBECONFIG=... kubectl config view --flatten)." >&2; exit 1; }
	@echo "==> registering context '$(CONTEXT)' as ArgoCD cluster 'satellite-$(NAME)' (label capstone.platform/tier=satellite; namespace-scoped argocd-manager: $(NAMESPACES))..."
	@argocd cluster add "$(CONTEXT)" --name "satellite-$(NAME)" --label capstone.platform/tier=satellite \
	  $(foreach ns,$(NAMESPACES),--namespace $(ns)) --yes
	@echo "cluster-register: DONE. Verify: argocd cluster list | grep satellite-$(NAME)"
	@echo "  Then confirm the appset fired:  kubectl -n argocd get applications -l capstone.platform/satellite-cluster=satellite-$(NAME)"
	@echo "  ...and the baseline landed:     kubectl --context $(CONTEXT) -n capstone-satellite-baseline get cm cluster-registered"
