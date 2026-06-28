# Observability

Metrics, logs, and alerting for the platform. This closes the retro gap where the
only telemetry was `metrics-server` and there was no alert even on "Vault sealed."

- Source of truth: `platform-services/monitoring/README.md`.
- **Anti-gold-plate:** single Prometheus, 15d local retention (no Thanos/Mimir, no
  remote-write); Loki **single-binary** (no SSD split, no S3/MinIO, no gateway).
  Scale up via values only if volume ever demands it.

| Component | What | Application (Helm chart) |
| --- | --- | --- |
| kube-prometheus-stack | Prometheus + Alertmanager + Grafana + node-exporter + kube-state-metrics + operator/CRDs | `kube-prometheus-stack-app.yaml` (87.3.0) |
| Loki | log store, single-binary, filesystem on Ceph | `loki-app.yaml` (6.55.0) |
| Alloy | log shipper (DaemonSet) → Loki | `alloy-app.yaml` (1.10.0) |
| monitoring ns + alerts + scrape configs | this dir | `platform-svc-monitoring` (platform-services-appset) |

Storage on `ceph-block` (replica-3): Prometheus 20Gi, Alertmanager 2Gi, Grafana
5Gi, Loki 10Gi.

---

## Access

- **Grafana** — `https://grafana.capstone.uamishub.com` (Traefik + wildcard TLS).
  Prometheus + Loki are pre-wired datasources.
- **Prometheus / Alertmanager** — ClusterIP only. Port-forward:
  ```bash
  kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090
  kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093
  ```

### ⚠ Rotate the default Grafana admin password (do this at/just after go-live)

Grafana ships with the chart default `admin` / `prom-operator` **and is
internet-reachable via the Cloudflare tunnel**. Rotate it before anyone relies on
it: put a strong password in a SealedSecret and point the chart at it via
`grafana.admin.existingSecret` (or `grafana.adminPassword` from a sealed value) in
`applicationsets/kube-prometheus-stack-app.yaml`, then merge + sync. Never inline
the password in the values.

---

## Alerts (`platform-services/monitoring/alerts.yaml`)

The failure modes this platform has actually hit, routed to Alertmanager:

| Alert | Fires when | Severity | Source |
| --- | --- | --- | --- |
| `VaultSealedOrDown` | vault StatefulSet 0 ready replicas 5m | critical | kube-state-metrics |
| `ExternalSecretSyncError` | an ExternalSecret Ready=False 10m | warning | ESO /metrics |
| `ClusterSecretStoreNotReady` | the ClusterSecretStore Ready=False 10m | critical | ESO /metrics |
| `SecretStoreNotReady` | a namespaced SecretStore Ready=False 10m | warning | ESO /metrics |
| `ArgoCDAppDegraded` | an Argo app Degraded 10m | warning | ArgoCD /metrics |
| `ArgoCDAppStuckOutOfSync` | an Argo app OutOfSync 15m (**excludes the SEC-011 netpol**) | warning | ArgoCD /metrics |
| `PodCrashLoopOrImagePullBackOff` | a container CrashLoop/ImagePull/ErrImagePull 10m | warning | kube-state-metrics |
| `CertManagerCertExpiringSoon` | a cert expires < 14d | warning | cert-manager /metrics |
| `NodeNotReady` | a node NotReady 10m | critical | kube-state-metrics |

The Vault/CrashLoop/Node alerts use kube-state-metrics (ships with the stack), so
they work day-one. The ESO/ArgoCD/cert-manager alerts need those `/metrics`
scraped — handled by `servicemonitors.yaml` (a ServiceMonitor for ArgoCD's
`argocd-metrics` Service, a ServiceMonitor for cert-manager's metrics Service, and
a PodMonitor for the ESO controller pod). kube-prometheus-stack's `defaultRules`
add broad k8s/node/kubelet/etcd/apiserver coverage on top.

---

## ⚠ Wire a notification channel (`platform-oncall` receiver)

Today alerts group, dedupe, and show in the **Alertmanager UI**, but are **not
pushed anywhere** — the `platform-oncall` receiver is intentionally empty. The
route already sends `severity =~ critical|warning` to it. To wire a real channel,
edit `alertmanager.alertmanagerSpec.config.receivers` in
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

Put the webhook URL / Slack token / SMTP password in a **SealedSecret** and mount
it via `alertmanager.alertmanagerSpec.secrets: [alertmanager-slack]` (it lands
under `/etc/alertmanager/secrets/`). **Never inline the URL/token** in the values.

---

## ⚠ The kube-prometheus-stack ↔ monitoring-ns ordering

There is a sync ordering dependency that has deadlocked before (fixed in #127/#133):

- `platform-svc-monitoring` (the `monitoring` namespace + alerts + ServiceMonitors)
  and `platform-kube-prometheus-stack` (which installs the
  PrometheusRule/ServiceMonitor/PodMonitor **CRDs**) race on a fresh cluster.
- The stack app must `CreateNamespace=true` (the `monitoring` ns) and use
  `SkipDryRunOnMissingResource=true` so it can apply CRs whose CRDs are installed in
  the same sync. On first sync `platform-svc-monitoring` may briefly fail until the
  CRDs exist — ArgoCD retry/selfHeal converges it. If it stays red, sync the stack
  app first, then re-sync monitoring.

```bash
kubectl -n argocd get app platform-kube-prometheus-stack platform-loki platform-alloy platform-svc-monitoring
```

> The two chart repos (`prometheus-community.github.io/helm-charts`,
> `grafana.github.io/helm-charts`) are install-owned in the `platform` AppProject
> `sourceRepos` — `make bootstrap-reapply` + verify after any `bootstrap/` change,
> or the apps `InvalidSpecError "repo not permitted"`.

---

## Day-2 checks

```bash
kubectl -n monitoring get pods                          # prometheus/alertmanager/grafana/loki/alloy Running
kubectl -n monitoring get prometheusrule,servicemonitor,podmonitor
# Grafana → Explore → Loki datasource for logs; Prometheus targets page for scrape health.
```
