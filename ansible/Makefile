# Convenience targets for the Debian Mac-Mini worker onboarding play.
# Run from the ansible/ directory.

LIMIT ?= mac-debian-01
VAULT  ?= --ask-vault-pass

.PHONY: help
help:
	@echo "Targets:"
	@echo "  make syntax          - ansible-playbook syntax check"
	@echo "  make lint            - ansible-lint (if installed)"
	@echo "  make check           - dry run against \$$LIMIT (--check --diff)"
	@echo "  make run             - onboard \$$LIMIT (default mac-debian-01)"
	@echo "  make run-all         - onboard the whole mac_workers group"
	@echo "  make show-cluster-facts - print the live cluster values baked into group_vars"
	@echo "  make fetch-ca        - refresh roles/kubelet_join/files/cluster-ca.crt from the live cluster"

.PHONY: syntax
syntax:
	ansible-playbook site.yml --syntax-check

.PHONY: lint
lint:
	ansible-lint site.yml roles/ || true

.PHONY: check
check:
	ansible-playbook site.yml --limit $(LIMIT) $(VAULT) --check --diff

.PHONY: run
run:
	ansible-playbook site.yml --limit $(LIMIT) $(VAULT)

.PHONY: run-all
run-all:
	ansible-playbook site.yml $(VAULT)

# Read-only helpers (need a working kubeconfig for the cluster).
.PHONY: show-cluster-facts
show-cluster-facts:
	@echo "server version:"; kubectl version -o json | python3 -c "import json,sys;print('  '+json.load(sys.stdin)['serverVersion']['gitVersion'])"
	@echo "api endpoint:"; kubectl cluster-info | sed -n '1p'
	@echo "kube-dns clusterIP:"; kubectl -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}'; echo
	@echo "cilium image:"; kubectl -n kube-system get ds cilium -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
	@echo "control-plane InternalIPs (Cilium VXLAN underlay):"; kubectl get nodes -o jsonpath='{range .items[*]}  {.metadata.name}={.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}'

.PHONY: fetch-ca
fetch-ca:
	kubectl -n kube-system get cm kube-root-ca.crt -o jsonpath='{.data.ca\.crt}' > roles/kubelet_join/files/cluster-ca.crt
	@echo "refreshed roles/kubelet_join/files/cluster-ca.crt"
	@openssl x509 -in roles/kubelet_join/files/cluster-ca.crt -noout -subject -dates
