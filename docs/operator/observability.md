# Observability

Metrics, logs, traces, and alerting for the platform. This closes the retro gap
where the only telemetry was `metrics-server` and there was no alert even on
"Vault sealed" — and, as of this PR, closes two more: no tracing at all, and
Alertmanager routed to a dead `example.com` placeholder.

- Source of truth: `platform-services/monitoring/README.md`.
- **Anti-gold-plate, still:** single Prometheus, 7d local retention, no remote-write,
  no HA pairs; Loki + Tempo both **single-binary** (no SSD/microservices split, no
  caches, no gateway). Thanos/MinIO/OTel/ntfy are deliberate, scoped EXCEPTIONS added
  in this PR (long-term metrics, tracing, real alert delivery) — not speculative
  scale-up. Scale further only if volume ever actually demands it.

| Component | What | Application (Helm chart / raw manifests) |
| --- | --- | --- |
| kube-prometheus-stack | Prometheus + Alertmanager + Grafana + node-exporter + kube-state-metrics + operator/CRDs (+ Thanos sidecar) | `kube-prometheus-stack-app.yaml` (87.3.0) |
| Loki | log store, single-binary, filesystem on Ceph | `loki-app.yaml` (6.55.0) |
| Alloy | log shipper (DaemonSet) → Loki | `alloy-app.yaml` (1.10.0) |
| Tempo | trace store, single-binary, filesystem on Ceph (raw manifests — the chart is upstream deprecated) | `platform-services/monitoring/tempo.yaml` |
| OTel Collector | OTLP trace ingress, sampled 15%, → Tempo | `otel-collector-app.yaml` (0.162.0) |
| Thanos | long-term metrics: Query / Store Gateway / Compactor (raw manifests) | `platform-services/monitoring/thanos.yaml` — **hard-depends on MinIO** |
| MinIO | S3-compatible object store, standalone, the `dr-backup` bucket | `minio-app.yaml` (5.4.0) |
| ntfy | self-hosted push — the real Alertmanager destination | `platform-services/monitoring/ntfy.yaml` |
| monitoring ns + alerts + scrape configs | this dir | `platform-svc-monitoring` (platform-services-appset) |

Storage on `ceph-block` (replica-3): Prometheus 20Gi, Alertmanager 2Gi, Grafana 5Gi,
Loki 10Gi, Tempo 5Gi, Thanos Store Gateway 5Gi (cache), Thanos Compactor 10Gi
(scratch), ntfy 2Gi, MinIO 20Gi (the real long-term-metrics data).

---

## Access

- **Grafana** — `https://grafana.capstone.uamishub.com` (Traefik + wildcard TLS).
  Prometheus, Loki, Tempo, and Thanos (a second, long-term-history datasource) are
  pre-wired.
- **Prometheus / Alertmanager** — ClusterIP only. Port-forward:
  ```bash
  kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090
  kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093
  ```
- **ntfy** — `https://ntfy.capstone.uamishub.com` (public, phone-subscription only —
  see "Notification channel" below). MinIO + Thanos Query/Store Gateway/Compactor
  stay ClusterIP-only.

### Grafana admin password

Already rotated off the chart default (`admin` / `prom-operator`) and wired to a
SealedSecret via `grafana.admin.existingSecret` in
`applicationsets/kube-prometheus-stack-app.yaml` — verified live 2026-08-15 (login
with the stored credential returns HTTP 200, `isGrafanaAdmin: true`). Grafana **is**
internet-reachable via the Cloudflare tunnel, so this matters: never inline a
password in the values. To rotate again later, see the reseal runbook in
`platform-services/monitoring/README.md` ("Rotating the Grafana admin password").

---

## Alerts (`platform-services/monitoring/alerts.yaml`)

The failure modes this platform has actually hit, routed to Alertmanager:

| Alert | Fires when | Severity | Source |
| --- | --- | --- | --- |
| `VaultSealedOrDown` | vault StatefulSet 0 ready replicas 5m | critical | kube-state-metrics |
| `VaultHADegraded` | vault StatefulSet <3 of 3 ready replicas (Raft HA) 10m | warning | kube-state-metrics |
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

## Notification channel (`platform-oncall` receiver → self-hosted ntfy)

Alerts at `severity =~ critical|warning` route to `platform-oncall`, a generic
webhook receiver whose URL comes from the `alertmanager-webhook` SealedSecret. This
**used to be** a literal `example.com` placeholder — it now points at a self-hosted
**ntfy** server (`platform-services/monitoring/ntfy.yaml`) using ntfy's built-in
`?template=alertmanager` webhook format (renders firing/resolved notifications with
no separate bridge process). See `platform-services/monitoring/README.md`
"Notification channel" for the full wiring, the credential-rotation runbook, and
**phone-subscription instructions** (subscribe the ntfy app to
`https://ntfy.capstone.uamishub.com`, topic `platform-alerts`).

To point `platform-oncall` at something else instead (Slack/Discord/PagerDuty/
email), reseal `alertmanager-webhook` with a different URL — the receiver config
itself needs no change (README "Reseal runbook — the Alertmanager webhook URL,
generic form"). Any destination works as long as the URL/token lives in the
SealedSecret and is read via `*_file` — **never inline it** in the values.

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
kubectl -n argocd get app platform-kube-prometheus-stack platform-loki platform-alloy platform-otel-collector platform-minio platform-svc-monitoring
```

> The four chart repos (`prometheus-community.github.io/helm-charts`,
> `grafana.github.io/helm-charts`, `open-telemetry.github.io/opentelemetry-helm-charts`,
> `charts.min.io`) are install-owned in the `platform` AppProject `sourceRepos` —
> `make bootstrap-reapply` + verify after any `bootstrap/` change, or the apps
> `InvalidSpecError "repo not permitted"`.

⚠ **New ordering note (this PR):** Thanos (`platform-services/monitoring/thanos.yaml`)
hard-depends on `platform-minio` and its `dr-backup` bucket — check
`platform-minio` is Synced/Healthy first if the Thanos Store Gateway/Compactor/Query
pods are CrashLooping (README "Long-term metrics").

---

## Traces — instrumenting span producers (the repeatable pattern)

Tempo + the `otel-collector` are healthy but only store what apps SEND them. The
collector's span receiver is idle until at least one app is instrumented. **Backstage
("The Process") is the first wired producer** — it's the highest-value target (Node/TS,
platform-central, high traffic) and Backstage ships first-class OpenTelemetry support.

### The one canonical endpoint

Every app — platform or tenant — sends OTLP to the SAME collector, which samples 15%
and re-exports to Tempo:

```
OTLP gRPC : otel-collector.monitoring.svc.cluster.local:4317
OTLP HTTP : http://otel-collector.monitoring.svc.cluster.local:4318   ← use this by default
```

Send to the **collector**, never straight to Tempo — the collector owns batching,
the memory-limiter, and the global 15% `probabilistic_sampler`
(`kubectl -n monitoring get cm otel-collector -o yaml`).

> Alloy (the DaemonSet) is **logs-only** (`→ Loki`); it has no OTLP traces receiver.
> There is no NetworkPolicy between app namespaces and `monitoring` today, so egress to
> the collector is open. If per-namespace egress netpols are ever added, they must allow
> `monitoring/otel-collector:4318`.

### Node / TypeScript apps (Backstage, and the copy-paste pattern)

Three moving parts — a tiny bootstrap file, a baked require flag, and env that tunes it
(no rebuild to retune):

1. **Dependencies** (`packages/backend/package.json`) — a MINIMAL, explicit set, NOT the
   `@opentelemetry/auto-instrumentations-node` meta-package (its ~80 deps bloat
   node_modules and OOM'd the Kaniko build): `@opentelemetry/api`,
   `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`,
   `@opentelemetry/instrumentation-http`, `@opentelemetry/instrumentation-express`.
   Backstage does NOT bundle its node_modules (skeleton + `yarn workspaces focus
   --production`), so require-in-the-middle patches the real `http`/`express` libs.
   Add `@opentelemetry/instrumentation-pg` etc. ONLY if you actually need DB spans.
2. **Bootstrap file** (`packages/backend/instrumentation.js`) — ~15 lines: `new NodeSDK({
   traceExporter: new OTLPTraceExporter(), instrumentations: [new HttpInstrumentation(),
   new ExpressInstrumentation()] }).start()`. Pass NO url/sampler/serviceName — NodeSDK +
   the exporter read them from `OTEL_*` env, so the file never changes per-app/per-env.
   Copy it into the runtime image and load it (image `NODE_OPTIONS`, coexisting with any
   existing flags): `--require /app/instrumentation.js`.
   ⚠ Bake this in the Dockerfile, do NOT set `NODE_OPTIONS` via Helm — a Helm value
   REPLACES the whole var and would drop other flags (e.g. Backstage's `--no-node-snapshot`).
3. **Env** (Helm `backstage.extraEnvVars` / any Deployment `env:`) — copy verbatim,
   change only `OTEL_SERVICE_NAME`:

   ```yaml
   - { name: OTEL_SERVICE_NAME,           value: <app-name> }
   - { name: OTEL_EXPORTER_OTLP_ENDPOINT, value: http://otel-collector.monitoring.svc.cluster.local:4318 }
   - { name: OTEL_TRACES_SAMPLER,         value: parentbased_traceidratio }
   - { name: OTEL_TRACES_SAMPLER_ARG,     value: "0.5" }   # platform portal; tenants → "0.1"
   ```

   (Metrics/logs need no env — the bootstrap simply never wires them: Prometheus is
   near-OOM, and logs already ship via Alloy → Loki.)

**Sampling:** the app head-samples (`parentbased_traceidratio`) AND the collector tail-
samples 15%, so retained ≈ arg × 0.15. Keep the arg modest (never always-on 100% at
scale). Bump `OTEL_TRACES_SAMPLER_ARG` (env-only, no rebuild) for a denser demo.

**Other runtimes:** same endpoint + same `OTEL_*` env; swap the loader —
Python `opentelemetry-instrument`, Java `-javaagent:opentelemetry-javaagent.jar`,
.NET the OTel auto-instrumentation. The env contract above is identical across all.

**Follow-up — tenant apps / scaffolder:** fold this env block (with `SAMPLER_ARG=0.1`)
into the golden-path scaffolder templates
(`platform-services/backstage/templates/**`, per-runtime `_fragments`) so every new
tenant app emits traces by default. Tracked separately from this first slice.

### Verify spans are flowing

```bash
# 1) The collector's receiver counter goes > 0 AFTER the app takes real traffic.
#    (The counter does not exist until the first span — absence == zero producers.)
kubectl -n monitoring port-forward deploy/otel-collector 18888:8888 &
curl -s localhost:18888/metrics | grep -E 'otelcol_receiver_accepted_spans|otelcol_exporter_sent_spans'
# 2) Generate traffic: browse The Process (https://process.capstone.uamishub.com) — sign in,
#    open the catalog. Each backend request produces spans.
# 3) Grafana → Drilldown → Traces (or Explore → Tempo datasource), service.name="backstage-process".
# Confirm the loader is active on the pod (NODE_OPTIONS carries the --require):
kubectl -n backstage get deploy backstage -o jsonpath='{.spec.template.spec.containers[0].env}' | tr ',' '\n' | grep -i otel
```

---

## Day-2 checks

```bash
kubectl -n monitoring get pods                          # prometheus/alertmanager/grafana/loki/alloy/tempo/otel-collector/thanos-*/ntfy Running
kubectl -n minio get pods                                # minio Running
kubectl -n monitoring get prometheusrule,servicemonitor,podmonitor
# Grafana → Explore → Loki/Tempo datasources; "Thanos" datasource for long-term
# metrics; Prometheus targets page for scrape health.
```
