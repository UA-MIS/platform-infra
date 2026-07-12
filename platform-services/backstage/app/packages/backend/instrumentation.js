// OpenTelemetry bootstrap for "The Process" Backstage backend (OBSERVABILITY, ADR-032).
//
// WHY A HAND-WRITTEN FILE (not @opentelemetry/auto-instrumentations-node/register):
// the meta-package pulls EVERY instrumentation (mongo/mysql/redis/aws/gcp/kafka/…) +
// their transitive deps — ~80 @opentelemetry packages, and that node_modules bloat was
// tipping the (marginal) Kaniko image build over its memory limit. This wires only the
// TWO instrumentations Backstage's backend actually exercises — http + express — which
// is the minimum to emit incoming-request SERVER spans (what populates Grafana → Drilldown
// → Traces). Add more later ONLY if a real need appears (e.g. instrumentation-pg for DB
// spans); keep this list tight.
//
// STILL FULLY ENV-DRIVEN: NodeSDK + the OTLP exporter read their config from the OTEL_*
// env the Helm values inject (applicationsets/backstage-process-app.yaml
// backstage.extraEnvVars) — so endpoint, service name, and sampler are tunable with NO
// rebuild:
//   OTEL_EXPORTER_OTLP_ENDPOINT → collector base URL (exporter appends /v1/traces)
//   OTEL_SERVICE_NAME           → resource service.name
//   OTEL_TRACES_SAMPLER / _ARG  → NodeSDK builds the sampler from these when none is passed
// Metrics and logs are DELIBERATELY not wired here (no metricReader/logRecordProcessor):
// Prometheus is near-OOM, and logs already ship via the Alloy DaemonSet → Loki.
//
// Loaded via `node --require /app/instrumentation.js …` (baked into NODE_OPTIONS in
// packages/backend/Dockerfile, alongside --no-node-snapshot). Backstage does NOT bundle
// its node_modules (skeleton + `yarn workspaces focus --production`), so require-in-the-
// middle can patch the real http/express modules — auto-instrumentation works.

// Guard against double-init in worker threads (isolated-vm / the scaffolder spins them up).
const { isMainThread } = require('node:worker_threads');

if (isMainThread) {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const {
    OTLPTraceExporter,
  } = require('@opentelemetry/exporter-trace-otlp-http');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const {
    ExpressInstrumentation,
  } = require('@opentelemetry/instrumentation-express');

  const sdk = new NodeSDK({
    // No url/headers here — the exporter reads OTEL_EXPORTER_OTLP_ENDPOINT (and the
    // OTLP defaults) from env. No `sampler` here — NodeSDK builds it from
    // OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG. No `serviceName` — resolved from
    // OTEL_SERVICE_NAME via the default resource.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
  });

  sdk.start();

  // Flush the final span batch on graceful shutdown so in-flight traces aren't lost.
  process.on('SIGTERM', () => {
    sdk.shutdown().finally(() => process.exit(0));
  });
}
