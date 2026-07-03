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
