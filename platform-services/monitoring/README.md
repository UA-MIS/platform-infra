# Observability stack (retro #3 — "we run a multi-tenant platform blind")

Metrics, logs, and alerting for the platform. Closes the retro gap where the only
telemetry was `metrics-server` and there was **no alert even on "Vault sealed"**.

| Component | What | How shipped |
| --- | --- | --- |
| **kube-prometheus-stack** | Prometheus + Alertmanager + Grafana + node-exporter + kube-state-metrics + the operator/CRDs | `applicationsets/kube-prometheus-stack-app.yaml` (Helm, chart `87.3.0`) |
| **Loki** | Log store, **single-binary** mode, filesystem on Ceph | `applicationsets/loki-app.yaml` (Helm, chart `6.55.0`) |
| **Alloy** | Log shipper (DaemonSet) → Loki | `applicationsets/alloy-app.yaml` (Helm, chart `1.10.0`) |
| **monitoring** ns + alerts + scrape configs | this dir | `platform-svc-monitoring` (platform-services-appset) |

**Anti-gold-plate (per the retro):** single Prometheus with 15d local retention (NO
Thanos/Mimir, NO remote-write); Loki **single-binary** (NO SSD/microservices split, NO
MinIO/S3, NO caches, NO gateway). Scale up later via values if volume ever demands it.

## Access

- **Grafana** — `https://grafana.capstone.uamishub.com` (Traefik ingress + wildcard
  TLS, same pattern as Harbor/Backstage/ArgoCD). Prometheus + Loki are pre-wired
  datasources. Admin creds come from the **`grafana-admin` SealedSecret**
  (`grafana.admin.existingSecret`), NOT the chart default. **⚠ it ships as a placeholder
  that does not decrypt — reseal real values before go-live** (runbook below); until
  then the Grafana pod stays `CreateContainerConfigError`.
- **Prometheus / Alertmanager** — ClusterIP only (internal ops). Port-forward:
  `kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090` /
  `... svc/kube-prometheus-stack-alertmanager 9093`.

## Alerts (`alerts.yaml`)

Six failure modes this platform has actually hit, routed to Alertmanager:

| Alert | Fires when | Severity | Signal source |
| --- | --- | --- | --- |
| `VaultSealedOrDown` | vault StatefulSet 0 ready replicas (sealed/down) 5m | critical | kube-state-metrics |
| `ExternalSecretSyncError` | an ExternalSecret Ready=False 10m | warning | ESO /metrics |
| `ClusterSecretStoreNotReady` | the ClusterSecretStore Ready=False 10m | critical | ESO /metrics |
| `SecretStoreNotReady` | a namespaced SecretStore Ready=False 10m | warning | ESO /metrics |
| `ArgoCDAppDegraded` | an Argo app Degraded 10m | warning | ArgoCD /metrics |
| `ArgoCDAppStuckOutOfSync` | an Argo app OutOfSync 15m (excl. the SEC-011 netpol) | warning | ArgoCD /metrics |
| `PodCrashLoopOrImagePullBackOff` | a container CrashLoop/ImagePull/ErrImagePull 10m | warning | kube-state-metrics |
| `CertManagerCertExpiringSoon` | a cert expires < 14d 1h | warning | cert-manager /metrics |
| `NodeNotReady` | a node NotReady 10m | critical | kube-state-metrics |

The Vault/CrashLoop/Node alerts use **kube-state-metrics**, which ships with the
stack, so they work day-one. The ESO/ArgoCD/cert-manager alerts need those components'
`/metrics` scraped — handled by `servicemonitors.yaml` (a ServiceMonitor for ArgoCD's
`argocd-metrics` Service, a ServiceMonitor for cert-manager's metrics Service, and a
PodMonitor for the ESO controller pod). kube-prometheus-stack's own `defaultRules` add
broad k8s/node/kubelet/etcd/apiserver coverage on top of these.

## Admin dashboards (dashboards-as-code)

Five operator-facing Grafana dashboards, each shipped as a `ConfigMap` labeled
`grafana_dashboard: "1"` — the Grafana chart's default k8s-sidecar (`sidecar.dashboards`,
chart default ON) watches for that label and auto-provisions the JSON, no manual
Grafana import. Every panel's datasource is a `${datasource}` template variable
(type `datasource`, query `prometheus`) rather than a hardcoded UID, so provisioning
doesn't depend on the exact UID the chart generates for the built-in Prometheus
datasource.

| Dashboard | File | Covers | Signal source |
| --- | --- | --- | --- |
| **Cluster Overview** | `dashboard-cluster-overview.yaml` | Node CPU/mem/disk/load/PSI pressure (3 Talos boxes), pod counts by phase/namespace | node-exporter + kube-state-metrics — real metrics, day-one |
| **Per-Tenant Usage vs Quota** | `dashboard-tenant-quota.yaml` | CPU/memory/pods/services used vs `ResourceQuota` hard limits per tenant namespace, PVC storage usage | `kube_resourcequota` (kube-state-metrics) — real metrics, day-one. The `namespace` variable is populated FROM `kube_resourcequota` itself, so it lists tenant namespaces without needing custom labels allow-listed |
| **Platform Health** | `dashboard-platform-health.yaml` | ArgoCD Synced/Healthy counts + apps needing attention (real); Vault/Harbor/ARC (**proxies** — pod/deployment/statefulset status via kube-state-metrics, not each component's own `/metrics`); Crossplane has a real `/metrics` PodMonitor as of this PR but the panel still reads the proxy (rewiring the panel is a follow-up) | ArgoCD + Crossplane ServiceMonitor/PodMonitor (real) + kube-state-metrics (proxy for Vault/Harbor/ARC) |
| **Tenant CI/CD** | `dashboard-tenant-cicd.yaml` | `arc-runners` pod activity (all teams combined — real, but no per-team breakdown), tenant ArgoCD app deploy status (real); image pushes / per-team runner usage — **not shown**, see follow-ups panel in-dashboard | kube-state-metrics + ArgoCD |
| **Cost Allocation** | `dashboard-cost-allocation.yaml` | Per-namespace CPU/RAM/storage $/hr and est. monthly cost, cluster-wide hourly/monthly totals, per-node pricing sanity check | OpenCost `/metrics` (real, day-one once `platform-opencost` is Healthy) — see "Cost allocation (OpenCost)" below |

**Done in this PR:** Crossplane's controller-runtime `/metrics` is now scraped (a
`PodMonitor` in `servicemonitors.yaml`, confirmed live 2026-07-02 via
`kubectl -n crossplane-system port-forward deploy/crossplane 8080:8080` + `curl
:8080/metrics` — `controller_runtime_*`/`circuit_breaker_events_total`/`workqueue_*`
present). The port isn't declared on the pod spec, so the monitor anchors discovery
on the declared `readyz` port and relabels `__address__` onto `:8080`. The Platform
Health dashboard panel itself hasn't been rewired to the real metrics yet (still
reads the kube-state-metrics proxy) — that's a follow-up, not this PR.

**Follow-ups — metrics that aren't scraped today** (none of these were invented; the
dashboards above show only what a real Prometheus query returns):

- **Vault true seal status** — `VaultSealedOrDown` and the Platform Health panel both
  use `kube_statefulset_status_replicas_ready` as a proxy (0 ready ⇒ sealed/crash-
  looping/down). The real signal (`vault_core_unsealed` etc.) needs Vault's
  `telemetry` stanza enabled — confirmed not present in `vault-config` today.
  Enabling it needs an HCL config change + a restart of the single-node,
  manual-unseal `vault-0` pod, so it's deliberately not a drive-by fix (Vault-DR
  roadmap item).
- **Harbor** — no ServiceMonitor exists; confirmed via `helm show values
  goharbor/harbor --version 1.19.1` that `metrics.enabled: false` (core/registry/
  jobservice all default off, and the chart's own `metrics.serviceMonitor.enabled`
  toggle is off too). Turning it on also deploys a new `harbor-exporter` component,
  so it's a `harbor-app.yaml` values change for its own PR. The Platform Health
  dashboard proxies with `kube_deployment_status_replicas_ready`/`_spec_replicas` in
  the `harbor` ns.
- **ARC runner scale-set activity (queued/running/per-team)** — the
  `gha-runner-scale-set-controller` + listener expose their own metrics, but the live
  controller pod is confirmed running with `--metrics-addr=0`/`--listener-metrics-addr=0`
  (metrics explicitly OFF — matches the chart's own `values.yaml` comment: "If
  metrics: object is not provided ... This will disable metrics"). Fix is a
  `metrics: {controllerManagerAddr: ":8080", listenerAddr: ":8080", listenerEndpoint:
  "/metrics"}` block in `arc-controller-app.yaml` helm values (declares a named
  `metrics` containerPort — the chart creates no Service, so a PodMonitor would
  target it) + a PodMonitor. Low-risk (stateless, single-replica controller) but
  nothing to scrape until that values change lands, so left as a follow-up rather
  than shipped unverified. Runner/build pods also carry no Prometheus-visible label
  for their owning team (`actions.github.com/scale-set-name` would need
  `kube-state-metrics --metric-labels-allowlist=pods=[...]`, a cardinality tradeoff
  to weigh, not just a scrape addition). Tenant CI/CD proxies with all-teams-combined
  `arc-runners` pod counts by phase.
- **Image push counts per team** — same Harbor gap as above; would come from Harbor's
  registry/webhook metrics once scraped.
- **Tenant storage ResourceQuota** — the per-tenant dashboard's storage row is
  usage-only (`kubelet_volume_stats_*`); there is no storage `ResourceQuota` on
  tenant namespaces yet (tracked in the resource-governance backlog, ties to #199).

Adding any of the above is: ship a `ServiceMonitor`/`PodMonitor` in this dir (same
pattern as `servicemonitors.yaml`) pointed at the component's metrics port, confirm
Prometheus picks it up (`kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090`,
check Status → Targets), then extend the relevant dashboard panel.

## Cost allocation (OpenCost)

**Component:** OpenCost, `applicationsets/opencost-app.yaml` (Helm, chart `2.5.26`,
own `platform-opencost` Application + dedicated `opencost` namespace — same
Helm-source pattern as Goldilocks/VPA, not part of this `monitoring` kustomize dir).
It points at the existing `kube-prometheus-stack-prometheus` Service in this
namespace (no second Prometheus) and re-exposes derived cost metrics
(`node_cpu_hourly_cost`, `node_ram_hourly_cost`, `node_total_hourly_cost`,
`pv_hourly_cost`, `container_cpu_allocation`, `container_memory_allocation_bytes`,
`pod_pvc_allocation`, ...) back to that same Prometheus via a `ServiceMonitor` —
picked up automatically because `serviceMonitorSelectorNilUsesHelmValues: false` is
already set (see the header comment on `kube-prometheus-stack-app.yaml`). The
**Cost Allocation** dashboard above reads those metrics.

### Why custom pricing, and why it isn't cloud list pricing

This is **owned hardware**, not a cloud account — OpenCost's built-in "default"
pricing model assumes a GCP us-central1 cluster (`$0.031611`/vCPU-hr, `$0.004237`
/GiB-hr RAM, `$0.0000548`/GiB-hr storage). Left as-is, every namespace's "cost"
would just be a fixed multiple of its requests — not a reflection of what this
platform actually costs to run. `opencost.customPricing` in the Application
overrides CPU/RAM/storage with a **flat, blended** rate derived from this fleet's
real electricity draw plus an amortized hardware-replacement cost.

**Fleet** (confirmed live via `kubectl get nodes`, 2026-07-07):

| Node type | Count | vCPU each | RAM each |
| --- | --- | --- | --- |
| Dell OptiPlex 7080 (Talos control-plane) | 3 | 16 | 16 GiB |
| Mac Mini, Late-2014 (Debian worker) | 3 | 4 | 8 GiB |
| **Fleet total** | 6 | **60 vCPU** | **72 GiB** |

**Per-node hourly cost = electricity + amortized hardware**, both editable
assumptions (this hardware is already-owned/surplus capstone equipment — the
"hardware" term is a replacement-value estimate for TCO/showback purposes, not a
real recurring invoice):

| | OptiPlex 7080 | Mac Mini (Late-2014) |
| --- | --- | --- |
| Avg sustained power draw | 40 W (SFF, always-on, moderate k8s load) | 12 W (famously low-power) |
| Electricity rate | $0.16/kWh (blended US retail average) | same |
| → electricity $/hr | 0.040 kW × 0.16 = **$0.0064** | 0.012 kW × 0.16 = **$0.00192** |
| Replacement value | $250 (refurb SFF i7/16GB/512GB market estimate) | $50 (EOL/surplus estimate) |
| Amortization | 4 yr (35,040 h) | 3 yr (26,280 h) — shorter remaining life |
| → hardware $/hr | 250/35,040 = **$0.007135** | 50/26,280 = **$0.001903** |
| **Node total $/hr** | **$0.013535** | **$0.003823** |
| ×3 nodes | $0.040605 | $0.011469 |

**Fleet hourly total** = 0.040605 + 0.011469 = **$0.052074/hr**.

That total is split into a CPU pool and a RAM pool — OpenCost's on-prem custom
pricing wants one flat `$/vCPU-hr` and one flat `$/GiB-hr` number, not a lump sum,
and there's no market price signal to split them by for capacity you already own.
This PR uses a documented **70% CPU / 30% RAM** split (a commodity-desktop BOM
approximation — CPU/board/PSU dominate, RAM is the smaller line item); change the
ratio in the Application's header comment if you disagree with the weighting:

- CPU pool: `0.70 × $0.052074 = $0.036452/hr ÷ 60 vCPU = $0.000608/vCPU-hr`
- RAM pool: `0.30 × $0.052074 = $0.015622/hr ÷ 72 GiB = $0.000217/GiB-hr`

**Storage** is priced separately (so it isn't double-counted against the node price
above): only the 3 OptiPlex nodes carry the Ceph OSD disk (a 500GB SATA SSD
alongside the NVMe boot disk, per the Phase-4 hardware runbook). Rook-Ceph
replicates 3× (replica-3), so 3 raw 500GB devices buy 500GB of *usable* capacity:
3 × $35 (budget 500GB SATA SSD estimate) = $105, amortized over 4yr (35,040h) =
$0.002997/hr ÷ 500 GB = **$0.000006/GiB-hr**. (Electricity for the OSD disk is
already folded into the 40W/node figure above — its incremental draw over a bare
board is small enough that separating it out isn't worth the added complexity.)

**Wired into `opencost.customPricing.costModel`:**

| Rate | Value | Unit |
| --- | --- | --- |
| CPU | `0.000608` | $ / vCPU-hour |
| RAM | `0.000217` | $ / GiB-hour |
| storage | `0.000006` | $ / GiB-hour |

⚠ **Limitations, stated plainly:**
- This is **one flat rate for the whole cluster** — OpenCost's on-prem custom
  pricing has no concept of "this node type costs more than that one". The
  dashboard's node-pricing-sanity table will show the *same* `$/vCPU-hr` on every
  node, OptiPlex or Mac Mini. Good for relative namespace-to-namespace showback,
  not a precise per-node bill.
- Every number above is a **documented default**, not a measured fact — local
  electricity rate, real acquisition/replacement prices, and amortization horizon
  will differ per operator. Re-derive with your own numbers using the same method
  (electricity $/hr + hardware $/hr, split 70/30 CPU/RAM, storage priced
  separately against usable-after-replication capacity).

### Access

OpenCost's own UI has **no authentication** (unlike Grafana's admin/password
SealedSecret), so — same posture as Prometheus/Alertmanager — it is **not** exposed
on the Cloudflare tunnel. Reach it with:

```
kubectl -n opencost port-forward svc/opencost 9090:9090
```

then open `http://localhost:9090`. Day-to-day, use the **Cost Allocation** Grafana
dashboard instead (behind Grafana's own auth).

### Deploy note

Same as every other Helm-source platform app: `make bootstrap-reapply` after merge
adds `https://opencost.github.io/opencost-helm-chart` to the **install-owned**
`platform` AppProject `sourceRepos` — else `platform-opencost` `InvalidSpecError
"repo not permitted"`. VERIFY it took.

## Notification channel (the `platform-oncall` webhook receiver)

Alerts at `severity =~ critical|warning` route to the **`platform-oncall`** receiver,
a **generic webhook** (`webhook_configs`) whose endpoint is read from the
**`alertmanager-webhook` SealedSecret** — never inlined in the Helm values. Wiring
(already in place, `applicationsets/kube-prometheus-stack-app.yaml`):

- `alertmanager.alertmanagerSpec.secrets: [alertmanager-webhook]` mounts the secret at
  `/etc/alertmanager/secrets/alertmanager-webhook/`.
- the receiver reads it: `webhook_configs[].url_file:
  /etc/alertmanager/secrets/alertmanager-webhook/url` (+ `send_resolved: true`).

A generic webhook is the simplest destination that needs no channel/token in the
values — point the URL at a Slack/Discord incoming-webhook relay, a PagerDuty Events
API bridge, or an Alertmanager→chat forwarder. To use native `slack_configs` /
`email_configs` instead, keep the same posture: put the URL/token in the SealedSecret
and reference it by `*_file` (e.g. `slack_configs[].api_url_file`), not inline.

### Reseal runbook — the Alertmanager webhook URL (LOCAL shell, **fish**)

The committed `sealedsecret-alertmanager-webhook.yaml` holds a **placeholder** that
does not decrypt (so no notifications are sent until you do this). Reseal with a real
URL against the live cluster's controller. **Correct controller coordinates:**
`--controller-namespace kube-system --controller-name sealed-secrets-controller`.

```fish
# repo root of platform-infra, on a branch (never commit a reseal straight to main)

# read the URL WITHOUT it landing in shell history (fish: -s = silent)
read -s -P "Alertmanager webhook URL: " AM_URL

kubectl create secret generic alertmanager-webhook \
    --namespace monitoring \
    --from-literal=url=$AM_URL \
    --dry-run=client -o yaml \
  | kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
      --format yaml > platform-services/monitoring/sealedsecret-alertmanager-webhook.yaml

set -e AM_URL      # clear the URL from the session
```

This **overwrites** the placeholder with a real, cluster-decryptable seal. Commit it on
a branch + PR. After it syncs, Alertmanager remounts the secret; test with `amtool` or
by port-forwarding `svc/kube-prometheus-stack-alertmanager 9093`.

## Rotating the Grafana admin password

Grafana reads `grafana.admin.existingSecret: grafana-admin` (keys `admin-user` /
`admin-password`) instead of the chart default. The committed
`sealedsecret-grafana-admin.yaml` holds a **placeholder** that does not decrypt — until
you reseal real values the Grafana pod stays `CreateContainerConfigError`.

### Reseal runbook — the Grafana admin creds (LOCAL shell, **fish**)

```fish
# repo root of platform-infra, on a branch

# generate a strong random password (url-safe, no shell-special chars)
set GRAFANA_PW (openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)

kubectl create secret generic grafana-admin \
    --namespace monitoring \
    --from-literal=admin-user=admin \
    --from-literal=admin-password=$GRAFANA_PW \
    --dry-run=client -o yaml \
  | kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
      --format yaml > platform-services/monitoring/sealedsecret-grafana-admin.yaml

echo "Grafana admin password (store in your password manager NOW): $GRAFANA_PW"
set -e GRAFANA_PW
```

This **overwrites** the placeholder with a real seal. Commit on a branch + PR. After it
syncs, the `grafana-admin` Secret appears and the Grafana pod starts; log in at
`https://grafana.capstone.uamishub.com` as `admin` / `<the password printed above>`.
(If Grafana already created its own admin user from a prior password, delete the
`kube-prometheus-stack-grafana` pod so it re-reads the secret, or reset via
`grafana-cli admin reset-admin-password` inside the pod.)

## Deploy notes

- `make bootstrap-reapply` after merge to add the two chart repos
  (`prometheus-community.github.io/helm-charts`, `grafana.github.io/helm-charts`) to
  the **install-owned** `platform` AppProject sourceRepos — else the apps
  `InvalidSpecError "repo not permitted"`. VERIFY it took.
- First sync: `platform-svc-monitoring` may briefly fail until
  `platform-kube-prometheus-stack` installs the PrometheusRule/ServiceMonitor/PodMonitor
  CRDs; ArgoCD retry/selfHeal converges it.
- Storage: Prometheus 20Gi, Alertmanager 2Gi, Grafana 5Gi, Loki 10Gi — all on
  `ceph-block` (replica-3, survives node loss). Bump if needed.
