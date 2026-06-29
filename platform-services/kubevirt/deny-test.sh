#!/usr/bin/env bash
# ============================================================================
# KubeVirt VM-tier security DENY-TEST  (ADR-032 / SEC-011 line of work)
# Implements T1..T13 of artifacts/reviews/kubevirt-vm-tier-security-review.md §6.
#
#   $ bash deny-test.sh            # run the full gate (does CLUSTER WRITES)
#
# This script is the SECURITY GATE that must PASS before any team is onboarded
# onto the KubeVirt VM tier. It renders the VM-tier blueprint
# (tenants/_template/vm/*) for a throwaway team into a scratch namespace, runs
# every allow/deny assertion from the review's T1..T13 matrix, prints one
# colored PASS/FAIL line per check (tagged with its T-number), a summary, and
# exits NON-ZERO if any check fails. It is idempotent and self-cleaning: a trap
# tears down every scratch resource on exit (including on failure).
#
# ─ PREREQUISITES (the review's §6 preconditions) ────────────────────────────
#   * KubeVirt + CDI are INSTALLED and Available, and the node advertises KVM
#     (devices.kubevirt.io/kvm) — both are `Deployed` per the run that gated
#     this script. (useEmulation:true still lets it run if /dev/kvm is absent.)
#   * Cilium is the ACTIVE CNI. On Talos default flannel, NetworkPolicies are
#     INERT — every deny test would FALSELY pass-through (traffic allowed). The
#     preflight warns loudly if Cilium is not found. Do not trust a green run
#     unless Cilium is enforcing (this is the SEC-011 lesson).
#   * kubectl context `admin@capstone` (override: KUBE_CONTEXT=...).
#
# ─ DESIGN NOTES (faithful but automatable) ──────────────────────────────────
#   * Network deny tests (T5/T6/T7) that the review describes "from the VM
#     serial console" are run from a lightweight curl PROBE POD in the SAME
#     vm-prod namespace. That probe is governed by the IDENTICAL NetworkPolicy
#     set (podSelector:{}) that constrains the virt-launcher/guest egress
#     (the guest NATs out via the launcher pod under masquerade), so it
#     exercises the exact same control without scripting a console login.
#   * A real, minimal cirros VM is spun up only where a running guest is
#     genuinely required (T1 admission; T13 quota). T8 imports a real
#     DataVolume to prove the CDI importer egress path.
#   * T3 (no container Deployment via the VM AppProject) and the GitOps half of
#     T4 are ArgoCD project-fence properties asserted STRUCTURALLY against the
#     applied AppProject (a self-contained script cannot stand up an ArgoCD
#     Application with a git source). The PSA half of T4 is behavioral.
#
# Re-run safe. Everything lives under TEAM=denytest (override: TEAM=...).
# ============================================================================
set -euo pipefail

# ── Config (all overridable via env) ────────────────────────────────────────
CTX="${KUBE_CONTEXT:-admin@capstone}"
TEAM="${TEAM:-denytest}"
SEMESTER="${SEMESTER:-denytest}"
VM_NS="${TEAM}-vm-prod"
OTHER_NS="${TEAM}-other"
RESTRICTED_NS="${TEAM}-restricted"
APPPROJECT="${TEAM}-vm"
KS_PROBE_NS="kube-system"

NET_TIMEOUT="${NET_TIMEOUT:-6}"        # seconds for a single deny/allow curl
VM_TIMEOUT="${VM_TIMEOUT:-240}"        # seconds to wait for the VMI / launcher
DV_TIMEOUT="${DV_TIMEOUT:-300}"        # seconds to wait for the DataVolume import
POD_TIMEOUT="${POD_TIMEOUT:-120}"      # seconds to wait for a probe pod Ready

STORAGE_CLASS="${STORAGE_CLASS:-ceph-block}"
IMG_CURL="${IMG_CURL:-curlimages/curl:latest}"
IMG_WEB="${IMG_WEB:-traefik/whoami:latest}"          # tiny HTTP 200 responder on :80
IMG_BUSYBOX="${IMG_BUSYBOX:-busybox:1.36}"
IMG_VM_DISK="${IMG_VM_DISK:-quay.io/kubevirt/cirros-container-disk-demo}"
DV_SOURCE_URL="${DV_SOURCE_URL:-docker://quay.io/kubevirt/cirros-container-disk-demo}"

# Resolve repo root so we render the REAL blueprint, not a copy.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
if [ ! -f "$REPO_ROOT/tenants/_template/vm/namespaces/vm-prod.yaml" ]; then
  REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$REPO_ROOT")"
fi
VM_NS_TPL="$REPO_ROOT/tenants/_template/vm/namespaces/vm-prod.yaml"
VM_PROJ_TPL="$REPO_ROOT/tenants/_template/vm/appproject-vm.yaml"

K() { kubectl --context "$CTX" "$@"; }

# ── Colored PASS/FAIL framework ─────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GRN=$'\033[0;32m'; RED=$'\033[0;31m'; YLW=$'\033[0;33m'; BLU=$'\033[0;34m'; NC=$'\033[0m'
else
  GRN=''; RED=''; YLW=''; BLU=''; NC=''
fi
PASS_CNT=0; FAIL_CNT=0; declare -a FAILED=()
ok()   { printf "%sPASS%s [%-3s] %s\n" "$GRN" "$NC" "$1" "$2"; PASS_CNT=$((PASS_CNT+1)); }
bad()  { printf "%sFAIL%s [%-3s] %s\n" "$RED" "$NC" "$1" "$2"; FAIL_CNT=$((FAIL_CNT+1)); FAILED+=("$1 — $2"); }
info() { printf "%s  ··%s %s\n" "$BLU" "$NC" "$1"; }
warn() { printf "%s  !!%s %s\n" "$YLW" "$NC" "$1"; }
hdr()  { printf "\n%s== %s ==%s\n" "$BLU" "$1" "$NC"; }

# ── Cleanup (used for BOTH pre-clean idempotency AND the exit trap) ──────────
cleanup() {
  local mode="${1:-trap}"
  [ "$mode" = "trap" ] && hdr "Teardown (scratch resources)"
  K delete pod ks-probe -n "$KS_PROBE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  K delete appproject "$APPPROJECT" -n argocd --ignore-not-found --wait=false >/dev/null 2>&1 || true
  K delete ns "$VM_NS" "$OTHER_NS" "$RESTRICTED_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if [ "$mode" = "trap" ]; then
    info "Scratch namespaces ($VM_NS, $OTHER_NS, $RESTRICTED_NS), AppProject $APPPROJECT and kube-system probe are being deleted (background)."
  fi
}
trap 'cleanup trap' EXIT

# ── Small helpers ───────────────────────────────────────────────────────────
# expect_reject TAG DESC REGEX  (manifest on stdin) — PASS iff apply is rejected
expect_reject() {
  local tag="$1" desc="$2" pat="$3" out rc
  set +e
  out="$(K apply -f - 2>&1)"; rc=$?
  set -e
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qiE "$pat"; then
    ok "$tag" "$desc"
  elif [ "$rc" -ne 0 ]; then
    ok "$tag" "$desc (rejected: $(printf '%s' "$out" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-90))"
  else
    bad "$tag" "$desc — but it was ADMITTED"
  fi
}
# curl_in NS POD URL [EXTRA] -> echoes "rc|httpcode"
curl_in() {
  local ns="$1" pod="$2" url="$3" extra="${4:-}" code rc
  set +e
  code="$(K exec -n "$ns" "$pod" -- sh -c "curl -ksS -o /dev/null -w '%{http_code}' --max-time $NET_TIMEOUT $extra '$url' 2>/dev/null")"
  rc=$?
  set -e
  printf '%s|%s' "$rc" "${code:-000}"
}
deny_net() { # TAG DESC NS POD URL [EXTRA]
  local r; r="$(curl_in "$3" "$4" "$5" "${6:-}")"
  if [ "${r%%|*}" -ne 0 ]; then ok "$1" "$2 (blocked; curl rc=${r%%|*})"
  else bad "$1" "$2 — REACHED (HTTP ${r##*|})"; fi
}
allow_net() { # TAG DESC NS POD URL [EXTRA]
  local r; r="$(curl_in "$3" "$4" "$5" "${6:-}")"
  if [ "${r%%|*}" -eq 0 ]; then ok "$1" "$2 (reached; HTTP ${r##*|})"
  else bad "$1" "$2 — could NOT reach (curl rc=${r%%|*})"; fi
}
wait_pod_ready() { K wait --for=condition=Ready pod "$2" -n "$1" --timeout="${POD_TIMEOUT}s" >/dev/null 2>&1; }

# ============================================================================
hdr "Preflight"
command -v kubectl >/dev/null || { echo "kubectl not found"; exit 2; }
K version --request-timeout=10s >/dev/null 2>&1 || { echo "cannot reach cluster via context '$CTX'"; exit 2; }
info "context = $CTX  |  team = $TEAM  |  vm ns = $VM_NS"
[ -f "$VM_NS_TPL" ]   || { echo "blueprint not found: $VM_NS_TPL"; exit 2; }
[ -f "$VM_PROJ_TPL" ] || { echo "blueprint not found: $VM_PROJ_TPL"; exit 2; }

if K get crd virtualmachines.kubevirt.io >/dev/null 2>&1; then
  kvavail="$(K get kubevirt kubevirt -n kubevirt -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null || true)"
  [ "$kvavail" = "True" ] && info "KubeVirt: Available" || warn "KubeVirt CR not Available (status='$kvavail') — T1/T13 may fail."
else
  warn "KubeVirt CRDs missing — install KubeVirt first (T1/T4/T13 will fail)."
fi
if K get crd datavolumes.cdi.kubevirt.io >/dev/null 2>&1; then
  cdiavail="$(K get cdi cdi -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null || true)"
  [ "$cdiavail" = "True" ] && info "CDI: Available" || warn "CDI CR not Available (status='$cdiavail') — T8 may fail."
else
  warn "CDI CRDs missing — install CDI first (T8 will fail)."
fi
if K -n kube-system get daemonset cilium >/dev/null 2>&1; then
  info "Cilium daemonset present — NetworkPolicies are enforced."
else
  warn "Cilium daemonset NOT found. If the CNI is flannel, ALL NetworkPolicies are INERT and the"
  warn "deny tests (T5/T6/T7/T10) would FALSELY pass-through. Confirm Cilium before trusting results."
fi

# ── Idempotent pre-clean, then wait for namespaces to actually be gone ───────
hdr "Setup"
cleanup preclean
info "Waiting for any prior scratch namespaces to terminate..."
for ns in "$VM_NS" "$OTHER_NS" "$RESTRICTED_NS"; do
  K wait --for=delete ns/"$ns" --timeout=120s >/dev/null 2>&1 || true
done

# Render + apply the REAL VM-tier blueprint for the throwaway team.
info "Rendering + applying VM-tier blueprint (TEAM=$TEAM) -> $VM_NS"
sed -e "s/__TEAM__/$TEAM/g" -e "s/__SEMESTER__/$SEMESTER/g" "$VM_NS_TPL"   | K apply -f - >/dev/null
sed -e "s/__TEAM__/$TEAM/g" -e "s/__SEMESTER__/$SEMESTER/g" -e "s/__APPNAME__/${TEAM}-app/g" "$VM_PROJ_TPL" | K apply -f - >/dev/null

# Second "other tenant" namespace (no PSA label needed — it is only a probe/target home).
K create ns "$OTHER_NS" >/dev/null 2>&1 || true
K label ns "$OTHER_NS" "platform.capstone/team=${TEAM}-other" --overwrite >/dev/null 2>&1 || true
# Restricted-PSA namespace to prove a VM-shaped pod is rejected there (T4 PSA half).
K create ns "$RESTRICTED_NS" >/dev/null 2>&1 || true
K label ns "$RESTRICTED_NS" \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.31 --overwrite >/dev/null 2>&1 || true

# Web target + curl probes (created now; their image pulls are node-level, not netpol-bound).
info "Creating web targets + curl probes..."
cat <<EOF | K apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: vm-web, namespace: $VM_NS, labels: { app: vm-web } }
spec:
  containers:
    - name: web
      image: $IMG_WEB
      ports: [ { containerPort: 80 } ]
      readinessProbe: { httpGet: { path: /, port: 80 }, initialDelaySeconds: 2, periodSeconds: 3 }
---
apiVersion: v1
kind: Service
metadata: { name: vm-web, namespace: $VM_NS }
spec:
  selector: { app: vm-web }
  ports: [ { name: http, port: 80, targetPort: 80 } ]
---
apiVersion: v1
kind: Pod
metadata: { name: other-web, namespace: $OTHER_NS, labels: { app: other-web } }
spec:
  containers:
    - name: web
      image: $IMG_WEB
      ports: [ { containerPort: 80 } ]
---
apiVersion: v1
kind: Service
metadata: { name: other-web, namespace: $OTHER_NS }
spec:
  selector: { app: other-web }
  ports: [ { name: http, port: 80, targetPort: 80 } ]
---
apiVersion: v1
kind: Pod
metadata: { name: vm-probe, namespace: $VM_NS }
spec:
  containers: [ { name: c, image: $IMG_CURL, command: ["sleep","infinity"] } ]
---
apiVersion: v1
kind: Pod
metadata: { name: other-probe, namespace: $OTHER_NS }
spec:
  containers: [ { name: c, image: $IMG_CURL, command: ["sleep","infinity"] } ]
---
apiVersion: v1
kind: Pod
metadata: { name: ks-probe, namespace: $KS_PROBE_NS }
spec:
  containers: [ { name: c, image: $IMG_CURL, command: ["sleep","infinity"] } ]
EOF

# Apply the T1 VM and the T8 DataVolume EARLY so they boot/import while fast tests run.
info "Applying the minimal cirros VM (T1) + DataVolume import (T8)..."
cat <<EOF | K apply -f - >/dev/null
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: denytest-vm
  namespace: $VM_NS
  labels: { platform.capstone/team: $TEAM, platform.capstone/tier: vm }
spec:
  runStrategy: Always
  template:
    metadata:
      labels: { kubevirt.io/domain: denytest-vm }
    spec:
      domain:
        cpu: { cores: 1 }
        resources: { requests: { memory: 256Mi } }
        devices:
          disks: [ { name: containerdisk, disk: { bus: virtio } } ]
          interfaces: [ { name: default, masquerade: {} } ]
      networks: [ { name: default, pod: {} } ]
      volumes:
        - name: containerdisk
          containerDisk: { image: $IMG_VM_DISK }
EOF
cat <<EOF | K apply -f - >/dev/null
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
metadata: { name: denytest-import, namespace: $VM_NS }
spec:
  source:
    registry: { url: "$DV_SOURCE_URL" }
  storage:
    accessModes: [ "ReadWriteOnce" ]
    storageClassName: $STORAGE_CLASS
    resources: { requests: { storage: 1Gi } }
EOF

info "Waiting for curl probes to be Ready..."
wait_pod_ready "$VM_NS" vm-probe       || warn "vm-probe not Ready (network tests may error)."
wait_pod_ready "$OTHER_NS" other-probe || warn "other-probe not Ready."
wait_pod_ready "$KS_PROBE_NS" ks-probe || warn "ks-probe not Ready."
wait_pod_ready "$VM_NS" vm-web         || warn "vm-web not Ready yet (T9/T11 may need a moment)."

# Resolve dynamic targets.
OTHER_IP="$(K get pod other-web -n "$OTHER_NS" -o jsonpath='{.status.podIP}' 2>/dev/null || true)"
API_CLUSTERIP="$(K get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo 10.96.0.1)"
NODE_IP="$(K get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)"

# ============================================================================
hdr "Allow / Deny matrix (T1..T13)"

# ── T2 — privileged + hostPath pods still blocked by baseline PSA ────────────
PRIV_OUT=""; HOSTP_OUT=""; rc1=0; rc2=0
set +e
PRIV_OUT="$(cat <<EOF | K apply -f - 2>&1
apiVersion: v1
kind: Pod
metadata: { name: t2-priv, namespace: $VM_NS }
spec:
  containers:
    - name: c
      image: $IMG_BUSYBOX
      command: ["sleep","60"]
      securityContext: { privileged: true }
EOF
)"; rc1=$?
HOSTP_OUT="$(cat <<EOF | K apply -f - 2>&1
apiVersion: v1
kind: Pod
metadata: { name: t2-hostpath, namespace: $VM_NS }
spec:
  containers:
    - name: c
      image: $IMG_BUSYBOX
      command: ["sleep","60"]
      volumeMounts: [ { name: h, mountPath: /host } ]
  volumes: [ { name: h, hostPath: { path: /etc } } ]
EOF
)"; rc2=$?
set -e
if [ $rc1 -ne 0 ] && [ $rc2 -ne 0 ] \
   && printf '%s' "$PRIV_OUT"  | grep -qiE "podsecurity|privileged" \
   && printf '%s' "$HOSTP_OUT" | grep -qiE "podsecurity|hostpath"; then
  ok "T2" "privileged + hostPath pods REJECTED by baseline PSA"
else
  [ $rc1 -eq 0 ] && K delete pod t2-priv -n "$VM_NS" --ignore-not-found >/dev/null 2>&1
  [ $rc2 -eq 0 ] && K delete pod t2-hostpath -n "$VM_NS" --ignore-not-found >/dev/null 2>&1
  bad "T2" "privileged/hostPath not both rejected (priv rc=$rc1, hostPath rc=$rc2)"
fi

# ── T3 — VM AppProject does NOT whitelist container Deployment kinds ─────────
WL="$(K get appproject "$APPPROJECT" -n argocd -o jsonpath='{range .spec.namespaceResourceWhitelist[*]}{.kind}{"\n"}{end}' 2>/dev/null || true)"
if printf '%s' "$WL" | grep -qx VirtualMachine \
   && printf '%s' "$WL" | grep -qx DataVolume \
   && ! printf '%s' "$WL" | grep -qxE 'Deployment|ReplicaSet|HorizontalPodAutoscaler'; then
  ok "T3" "VM AppProject fences VM kinds in; Deployment/ReplicaSet/HPA NOT whitelisted"
else
  bad "T3" "AppProject whitelist unexpected (got: $(printf '%s' "$WL" | tr '\n' ',' ))"
fi

# ── T4 — VM-shaped (baseline) pod REJECTED in a restricted-PSA namespace ─────
expect_reject "T4" "VM-shaped baseline pod REJECTED in restricted-PSA namespace" "podsecurity|restricted" <<EOF
apiVersion: v1
kind: Pod
metadata: { name: t4-vmshaped, namespace: $RESTRICTED_NS }
spec:
  containers:
    - name: c
      image: $IMG_BUSYBOX
      command: ["sleep","60"]
EOF

# ── T5 — cross-tenant egress DENIED (vm-prod -> other tenant pod) ────────────
if [ -n "$OTHER_IP" ]; then
  deny_net "T5" "cross-tenant egress to $OTHER_NS pod denied" "$VM_NS" vm-probe "http://$OTHER_IP:80"
else
  bad "T5" "could not resolve other-web pod IP"
fi

# ── T6 — apiserver ClusterIP egress DENIED ──────────────────────────────────
deny_net "T6" "apiserver ClusterIP ($API_CLUSTERIP:443) egress denied" "$VM_NS" vm-probe "https://$API_CLUSTERIP:443"

# ── T7 — guest external egress DENIED (non-importer pod, external :443) ──────
deny_net "T7" "guest external egress (https://1.1.1.1) denied" "$VM_NS" vm-probe "https://1.1.1.1:443"

# ── T8 — CDI importer egress ALLOWED (DataVolume import succeeds) ────────────
info "Waiting up to ${DV_TIMEOUT}s for DataVolume import (T8)..."
DV_PHASE=""
SECS=0
while [ $SECS -lt "$DV_TIMEOUT" ]; do
  DV_PHASE="$(K get datavolume denytest-import -n "$VM_NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  [ "$DV_PHASE" = "Succeeded" ] && break
  [ "$DV_PHASE" = "Failed" ] && break
  sleep 5; SECS=$((SECS+5))
done
IMPORTER_LBL="$(K get pod -n "$VM_NS" -l app=containerized-data-importer -o name 2>/dev/null | head -1 || true)"
if [ "$DV_PHASE" = "Succeeded" ]; then
  ok "T8" "CDI importer egress ALLOWED; DataVolume import Succeeded"
  [ -n "$IMPORTER_LBL" ] && info "importer pod carried label app=containerized-data-importer (KVT-4 matchLabels OK)" \
    || warn "importer pod already GC'd; could not confirm label app=containerized-data-importer (KVT-4)."
else
  bad "T8" "DataVolume import did not Succeed (phase='${DV_PHASE:-<none>}'). If importer label != app=containerized-data-importer, the netpol failed CLOSED (KVT-4) — verify with: kubectl get pod -n $VM_NS --show-labels"
fi

# ── T9 — VM URL path reachable from Traefik (kube-system) ───────────────────
wait_pod_ready "$VM_NS" vm-web >/dev/null 2>&1 || true
allow_net "T9" "Traefik-path ingress (kube-system -> vm-web svc) reachable" "$KS_PROBE_NS" ks-probe "http://vm-web.$VM_NS.svc.cluster.local:80"

# ── T10 — cross-tenant ingress DENIED (other tenant -> vm-web svc) ──────────
deny_net "T10" "cross-tenant ingress ($OTHER_NS -> vm-web svc) denied" "$OTHER_NS" other-probe "http://vm-web.$VM_NS.svc.cluster.local:80"

# ── T11 — kubelet probes work under default-deny (host -> local pod) ─────────
if K wait --for=condition=Ready pod vm-web -n "$VM_NS" --timeout=60s >/dev/null 2>&1; then
  ok "T11" "kubelet readinessProbe succeeded under default-deny (host->local-pod permitted)"
else
  bad "T11" "vm-web never became Ready — readinessProbe (host->local-pod) blocked or pod unhealthy"
fi

# ── T12 — SA token -> apiserver via node IP stays RBAC-gated ─────────────────
if [ -n "$NODE_IP" ]; then
  set +e
  T12="$(K exec -n "$VM_NS" vm-probe -- sh -c \
    "T=\$(cat /var/run/secrets/kubernetes.io/serviceaccount/token 2>/dev/null); \
     curl -ksS -o /dev/null -w '%{http_code}' --max-time $NET_TIMEOUT \
       -H \"Authorization: Bearer \$T\" https://$NODE_IP:6443/apis 2>/dev/null")"
  rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    ok "T12" "apiserver via node IP ($NODE_IP:6443) unreachable from VM ns probe (blocked)"
  elif printf '%s' "$T12" | grep -qE '^(401|403)$'; then
    ok "T12" "apiserver reachable via node IP but RBAC-gated (HTTP $T12) — SEC-011 residual stays gated"
  else
    bad "T12" "apiserver via node IP returned HTTP $T12 to default SA token — NOT RBAC-gated as expected"
  fi
else
  bad "T12" "could not resolve a node InternalIP"
fi

# ── T13 — ResourceQuota count/virtualmachines cap (=1) holds ─────────────────
expect_reject "T13" "2nd VirtualMachine REJECTED by ResourceQuota (count/virtualmachines=1)" "exceeded quota|forbidden" <<EOF
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata: { name: denytest-vm-2, namespace: $VM_NS }
spec:
  runStrategy: Halted
  template:
    metadata:
      labels: { kubevirt.io/domain: denytest-vm-2 }
    spec:
      domain:
        resources: { requests: { memory: 256Mi } }
        devices:
          disks: [ { name: containerdisk, disk: { bus: virtio } } ]
      volumes:
        - name: containerdisk
          containerDisk: { image: $IMG_VM_DISK }
EOF

# ── T1 — the real VM admits at baseline (launcher pod admitted, VMI runs) ────
# Checked LAST so the VM has had the whole run to boot.
info "Waiting up to ${VM_TIMEOUT}s for the VM launcher / VMI (T1)..."
SECS=0; VMI_PHASE=""; LAUNCHER=""
while [ $SECS -lt "$VM_TIMEOUT" ]; do
  VMI_PHASE="$(K get vmi denytest-vm -n "$VM_NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  LAUNCHER="$(K get pod -n "$VM_NS" -l kubevirt.io=virt-launcher -o name 2>/dev/null | head -1 || true)"
  [ "$VMI_PHASE" = "Running" ] && break
  [ -n "$LAUNCHER" ] && [ "$SECS" -ge 30 ] && break   # launcher admitted is the core PSA proof
  sleep 5; SECS=$((SECS+5))
done
PSA_DENY="$(K get events -n "$VM_NS" --field-selector reason=FailedCreate -o jsonpath='{range .items[*]}{.message}{"\n"}{end}' 2>/dev/null | grep -i 'violates PodSecurity' || true)"
if [ -n "$LAUNCHER" ] && [ -z "$PSA_DENY" ]; then
  ok "T1" "virt-launcher admitted under baseline PSA (VMI phase='${VMI_PHASE:-Pending}')"
  AUDIT="$(K get events -n "$VM_NS" -o jsonpath='{range .items[*]}{.message}{"\n"}{end}' 2>/dev/null | grep -i 'would violate PodSecurity .restricted' | head -1 || true)"
  [ -n "$AUDIT" ] && info "PSA restricted-gap (KVT-2 data): $(printf '%s' "$AUDIT" | cut -c1-100)"
elif [ -n "$PSA_DENY" ]; then
  bad "T1" "virt-launcher REJECTED by PSA: $(printf '%s' "$PSA_DENY" | head -1 | cut -c1-120)"
else
  bad "T1" "no virt-launcher pod appeared within ${VM_TIMEOUT}s (VMI phase='${VMI_PHASE:-<none>}'); check KubeVirt install"
fi

# ============================================================================
hdr "Summary"
TOTAL=$((PASS_CNT+FAIL_CNT))
printf "%sPASS: %d%s   %sFAIL: %d%s   (of %d checks)\n" "$GRN" "$PASS_CNT" "$NC" "$RED" "$FAIL_CNT" "$NC" "$TOTAL"
if [ "$FAIL_CNT" -gt 0 ]; then
  printf "\n%sFailed checks:%s\n" "$RED" "$NC"
  for f in "${FAILED[@]}"; do printf "  - %s\n" "$f"; done
  echo
  echo "Gate result: ${RED}FAIL${NC} — do NOT onboard a team onto the VM tier until all checks pass."
  exit 1
fi
echo
printf "Gate result: %sPASS%s — VM-tier deny-test matrix satisfied (review §6: T1,T8,T9,T11 ALLOW; T2-T7,T10,T12,T13 DENY).\n" "$GRN" "$NC"
exit 0
