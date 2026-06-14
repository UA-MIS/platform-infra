# platform-infra Makefile — Phase-1 dev ergonomics (T2).
#
# Every target is idempotent: re-running it must not error. The cluster target
# is parameterized by TARGET (clusters/<TARGET>/) so the same Makefile drives
# local-k3d now and real-k3s later — the portability seam from §6.
#
# Quick start:
#   make cluster-up      # create the k3d cluster if absent (idempotent)
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
bootstrap: ## (T3) Install ArgoCD + apply the platform project & app-of-apps root (idempotent)
	@kubectl config use-context "k3d-$(CLUSTER_NAME)" >/dev/null
	@echo "==> installing ArgoCD (pinned v3.4.3) into ns argocd..."
	@kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
	@# Server-side apply: ArgoCD's applicationsets CRD exceeds the 256KB limit on
	@# the client-side `last-applied-configuration` annotation that plain
	@# `kubectl apply` writes (fails: "metadata.annotations: Too long"). SSA stores
	@# no such annotation. --force-conflicts lets us re-own fields on re-run, so it
	@# stays idempotent (the canonical ArgoCD install method for this reason).
	@kubectl apply -k bootstrap/argocd-install --server-side --force-conflicts
	@echo "==> waiting for ArgoCD CRDs to register..."
	@kubectl wait --for=condition=Established \
	  crd/applications.argoproj.io crd/appprojects.argoproj.io crd/applicationsets.argoproj.io \
	  --timeout=120s
	@echo "==> waiting for ArgoCD components to be Available..."
	@kubectl -n argocd rollout status deploy/argocd-server --timeout=300s
	@kubectl -n argocd rollout status deploy/argocd-applicationset-controller --timeout=300s
	@echo "==> applying the platform AppProject + app-of-apps root..."
	@kubectl apply -f bootstrap/platform-appproject.yaml
	@kubectl apply -f bootstrap/root-app.yaml
	@echo "bootstrap complete. Inspect:  kubectl -n argocd get applications,applicationsets"
	@echo "  admin pw:  kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
	@echo "  ACCEPTANCE (ADV-002): once ArgoCD generates the tenant pods, run \`make verify-image-pull\`"
	@echo "                        to assert they get PAST ImagePullBackOff (registry-mirror sanity)."

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

# ---- validation gate (T12 hardening) ---------------------------------------
# Catches the failure classes security flagged so they can't ship again:
#   (1) malformed/divergent tenant RBAC names (the SEC-001 blanket-sed bug),
#   (2) stray non-manifest files in tenant dirs that break recurse-sync (SEC-002),
#   (3) schema-invalid k8s objects.
# Run before committing tenancy changes; cluster-independent.
.PHONY: validate
validate: ## Static validation of tenant manifests (kubeconform + RBAC-name + stray-file guards)
	@command -v kubeconform >/dev/null || { echo "ERROR: kubeconform not found (install to ~/.local/bin)."; exit 1; }
	@echo "==> [1/3] kubeconform -strict on tenant namespace bundles..."
	@kubeconform -strict -summary -kubernetes-version 1.31.5 tenants/*/namespaces/*.yaml
	@echo "==> [2/3] RBAC-name guard: every Role/RoleBinding name must be 'team-developer'..."
	@bad=$$(grep -rnE '^\s+name:\s+team-[a-z0-9-]+eloper\b' tenants/ | grep -v 'team-developer' || true); \
	  if [ -n "$$bad" ]; then echo "FAIL: malformed RBAC names (SEC-001 regression):"; echo "$$bad"; exit 1; fi; \
	  echo "  OK — no malformed RBAC names"
	@echo "==> [3/3] stray-file guard: tenant dirs may contain only .yaml (recurse-sync safe)..."
	@stray=$$(find tenants -type f ! -name '*.yaml' ! -name 'README.md' || true); \
	  if [ -n "$$stray" ]; then echo "FAIL: non-manifest files in tenants/ (would break recurse sync):"; echo "$$stray"; exit 1; fi; \
	  echo "  OK — no stray non-manifest files"
	@echo "validate: PASS"
