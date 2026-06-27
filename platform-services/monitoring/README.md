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
  datasources. **⚠ admin password is the chart default (`admin` / `prom-operator`) and
  Grafana is internet-reachable via the Cloudflare tunnel — ROTATE IT** (set
  `grafana.adminPassword` from a SealedSecret, or `grafana.admin.existingSecret`,
  before/just after go-live).
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

## ⚠ Wiring a notification channel (the receiver stub)

Today alerts group, dedupe, and show in the **Alertmanager UI**, but are **not pushed
anywhere** — the `platform-oncall` receiver is intentionally empty. To wire a real
channel, edit `alertmanager.alertmanagerSpec.config.receivers` in
`applicationsets/kube-prometheus-stack-app.yaml`:

```yaml
receivers:
  - name: 'null'
  - name: 'platform-oncall'
    slack_configs:            # or webhook_configs / email_configs / pagerduty_configs
      - api_url_file: /etc/alertmanager/secrets/alertmanager-slack/url
        channel: '#platform-alerts'
        send_resolved: true
```

Put the webhook URL / Slack token / SMTP password in a **SealedSecret** and mount it
via `alertmanager.alertmanagerSpec.secrets: [alertmanager-slack]` (it lands under
`/etc/alertmanager/secrets/`). **Never inline the URL/token** in the values. The route
already sends `severity =~ critical|warning` to `platform-oncall`.

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
