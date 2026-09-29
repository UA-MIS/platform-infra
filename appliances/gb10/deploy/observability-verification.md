# Observability — verification the integrator must run before trusting this

Authored without deploying anything: I do not own `docker-compose.yml` and
was told not to run `docker compose` or restart any container on
`promaxgb10-d62a` — another agent owns that file and is deploying the key
portal in parallel, and `gb10-vllm` takes ~9 minutes to cold start and was
actively in use. Everything below that says CONFIRMED was read directly off
a running `/metrics` endpoint or `nvidia-smi` on the box on 2026-09-29 (via
read-only SSH — no state changed). Everything marked GUESSED was never
observed running and must be checked before anyone pages on it.

## What was actually proven, and how

- `prometheus/prometheus.yml` — `docker run --rm --entrypoint promtool prom/prometheus:latest check config` (run locally on this dev machine, not the box): **SUCCESS**, valid syntax, both scrape config and the one rule file load.
- `prometheus/alert-rules.yml` — same tool, `check rules`: **SUCCESS**, 9 rules found, all parse as valid PromQL.
- `alertmanager/alertmanager.yml.template` — rendered with a fake webhook URL and checked with `docker run --rm --entrypoint amtool quay.io/prometheus/alertmanager:latest check-config` (locally): **SUCCESS** — 1 receiver, valid config shape.
- `render-config.sh` — `bash -n` (syntax check only, not executed against real `.env`) and confirmed the sed substitution logic against the actual template. Marked executable (`chmod +x`, mode preserved by the commit).
- `deploy/observability-services.yml` merged against the box's actual `docker-compose.yml` (as of commit `07e901c`) with `docker compose ... config -q` **run locally on this dev machine, never against the box** — merges cleanly, no YAML/variable errors.
- `grafana/dashboards/gb10-appliance.json` — valid JSON (`python3 -m json`-style parse). Never opened in an actual Grafana — panel layout/behavior unverified beyond that.

None of the above proves the *deployed* stack works — only that the config files are syntactically correct and would be accepted by their respective tools. Runtime behavior (does Prometheus actually scrape all 5 targets, does Alertmanager actually deliver to Slack, does Grafana actually render live data) is unverified and listed below as steps for whoever deploys this.

## Metric names: CONFIRMED vs. GUESSED

Read directly off the box's running containers on 2026-09-29 (`curl -sL http://localhost:4000/metrics` for litellm, `curl -sL http://localhost:8000/metrics` for vllm):

| Metric | Status | Notes |
|---|---|---|
| `up` | CONFIRMED | built into Prometheus, not exporter-dependent |
| `litellm_in_flight_requests` | CONFIRMED | gauge, live sample seen (`1.0`) |
| `litellm_proxy_failed_requests_metric_total` | CONFIRMED (shape) | HELP/TYPE present, counter; no samples yet because nothing has failed |
| `litellm_output_tokens_metric_total` | CONFIRMED | counter — **note the plan's original draft used `litellm_output_tokens_metric` without the `_total` suffix; the real name has it** |
| `litellm_request_total_latency_metric` / `_bucket` | CONFIRMED | TYPE histogram |
| `litellm_spend_metric_total` | CONFIRMED | live sample seen, labeled `team`/`team_alias` among others |
| `litellm_remaining_team_budget_metric`, `litellm_team_max_budget_metric` | CONFIRMED | live sample seen: `team_alias="faculty"`, max=200.0, remaining=200.0 |
| `vllm:kv_cache_usage_perc` | CONFIRMED | gauge, HELP/TYPE present on vllm's own `/metrics` |
| `nvidia_smi_temperature_gpu` | **GUESSED** | nvidia_gpu_exporter was never deployed; this name is inferred from the exporter's documented `nvidia-smi field → nvidia_smi_<field>` convention. The underlying `nvidia-smi --query-gpu=temperature.gpu` field **is** confirmed to return real data (51°C at read time) |
| `nvidia_smi_memory_used_bytes`, `nvidia_smi_memory_total_bytes` | **GUESSED, and probably does not exist** | see below — dropped from the alert rules entirely rather than shipped broken |
| `node_filesystem_avail_bytes`, `node_filesystem_size_bytes` | Standard node_exporter convention, not deployed/observed here | long-stable metric/label names, lower-risk guess than the GPU ones, but still unverified on this specific box |

### The important one: GPU memory metrics almost certainly don't exist on this hardware

```
$ nvidia-smi --query-gpu=name,temperature.gpu,power.draw,memory.used,memory.total,utilization.gpu,utilization.memory --format=csv
name, temperature.gpu, power.draw [W], memory.used [MiB], memory.total [MiB], utilization.gpu [%], utilization.memory [%]
NVIDIA GB10, 51, 12.98 W, [N/A], [N/A], 5 %, 0 %
```

`memory.used` and `memory.total` came back `[N/A]` — confirmed live, not inferred. This is the GB10's unified CPU/GPU memory (Grace Blackwell) architecture: the discrete "VRAM used/total" NVML query that `nvidia_gpu_exporter` (and `nvidia-smi` itself) normally reports isn't populated the same way it is on a regular discrete GPU. `nvidia_gpu_exporter` builds its Prometheus metric set dynamically from whichever `nvidia-smi` query fields come back non-`N/A` — so `nvidia_smi_memory_used_bytes`/`nvidia_smi_memory_total_bytes` will most likely simply be absent from its `/metrics` output on this box, not present-but-wrong.

Because of this, the alert rules and dashboard here **do not use GPU memory at all**. Temperature (confirmed populated) covers the thermal-safety concern for a fanless-ish office appliance; `vllm:kv_cache_usage_perc` (confirmed populated, read directly from vLLM's own `/metrics`) covers the "capacity ceiling" concern the design doc (§9.3) actually cares about, since that's the metric that tells you when the appliance itself is close to a real capacity wall — GPU memory percentage never was the only way to answer that question, just the default assumption in the original plan draft.

Also note: `nvidia-smi -q -d TEMPERATURE` on this box reports `GPU T.Limit Temp: 44 C`, which is *below* the concurrently-reported current temperature of 51°C — that field looks unpopulated/unreliable on this build (along with `Max Operating T.Limit Temp: 0 C`, obviously a placeholder). Don't wire an alert off the GPU's self-reported limit fields on this hardware; the thresholds in `alert-rules.yml` are fixed values grounded in the measured operating envelope (idle ~40-51°C, load ~62°C) instead.

## Verification steps to run once this is actually deployed

Run these **on the box**, after the integrator has merged `deploy/observability-services.yml` into `docker-compose.yml`, brought the five services up, and let vLLM warm up if it was cold.

**1. Confirm the real nvidia_gpu_exporter metric names — do this before trusting any GPU alert or dashboard panel:**

```bash
ssh uamis@promaxgb10-d62a.taile5d412.ts.net
curl -s http://localhost:9835/metrics | grep -i temperature
curl -s http://localhost:9835/metrics | grep -i memory
```

Expected: a line containing `nvidia_smi_temperature_gpu` (or note whatever the real name is if different — this is a guess, see above) with a numeric value in the 40s-60s range. For the memory grep: **expect no output at all** — if you *do* see `nvidia_smi_memory_used_bytes`/`nvidia_smi_memory_total_bytes` with real (non-zero, non-NaN) values, that's new information contradicting the `nvidia-smi` reading above — worth re-checking whether GPU-memory-based alerting should be added back in, but don't assume it's broken just because this doc predicted it would be.

If the temperature metric name differs from `nvidia_smi_temperature_gpu`, fix `prometheus/alert-rules.yml`'s `GB10GPUTemperatureWarning`/`GB10GPUTemperatureCritical` expressions and `grafana/dashboards/gb10-appliance.json`'s "GPU Temperature" panel query to match — both need the same fix.

**2. Confirm Prometheus is scraping all five jobs:**

```bash
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health}'
```

Expected: `litellm`, `node`, `nvidia-gpu`, `prometheus` all `"health": "up"`. `vllm` will read `"down"` until it finishes its ~9-minute cold start; it must read `"up"` after that window, scraped at `vllm:8000` (not `litellm:8000` — they no longer share a network namespace, see the comment in `docker-compose.yml`'s `vllm` service and in `prometheus/prometheus.yml`).

**3. Confirm `render-config.sh` actually makes the systemd unit pass verification** (this is the concrete thing that was broken before this task — `gb10-appliance.service` already referenced a script that didn't exist):

```bash
cd /opt/gb10-appliance-repo && git pull
systemd-analyze verify /etc/systemd/system/gb10-appliance.service
```

Expected: no output. If it still errors, check that `render-config.sh` kept its executable bit through the git pull (`ls -l render-config.sh` should show `-rwxr-xr-x` or similar; `chmod +x` it if not) and that `.env` has `ALERTMANAGER_SLACK_WEBHOOK_URL` set (the script's own `:?` guard will otherwise fail loudly, which is correct behavior, not a bug).

**4. Fire a synthetic alert end to end (Slack delivery):**

```bash
./render-config.sh   # requires .env with a real ALERTMANAGER_SLACK_WEBHOOK_URL
docker compose --env-file .env --env-file versions.env up -d alertmanager prometheus
curl -s -X POST http://localhost:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[{
  "labels": {"alertname":"GB10ObservabilityVerification","severity":"warning"},
  "annotations": {"summary":"gb10 observability verification","description":"synthetic alert fired manually during deploy verification"},
  "startsAt": "'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"
}]'
```

Expected: `#gb10-alerts` receives the message within `group_wait` (30s), and a "RESOLVED" follow-up a few minutes after you stop re-posting it (Alertmanager auto-resolves an alert with no fresh POST; `send_resolved: true` is set).

**5. Confirm Grafana renders live data and is tailnet-only:**

```bash
sudo tailscale serve --bg --https=3001 http://localhost:3000   # not run by this author — see deploy/observability-services.yml header
```

Then from a machine on tailnet `taile5d412`: open `https://promaxgb10-d62a.taile5d412.ts.net:3001`, log in `admin`/`$GRAFANA_ADMIN_PASSWORD`, open "GB10 Appliance". "Targets Up" should show all 5 scrape jobs; "vLLM KV Cache Usage" and "LiteLLM In-Flight Requests" should show real numbers once there's been any traffic.

From a machine NOT on the tailnet: `curl -sI https://promaxgb10-d62a.taile5d412.ts.net:3001` should fail to resolve/connect at all (MagicDNS is tailnet-private) — confirming Grafana never became reachable off the ops plane.

**6. Confirm the per-team budget alert's NaN-safety claim holds for real data**, once the `pending` team (zero budget by design, D11) exists:

```bash
curl -s http://localhost:9090/api/v1/query --data-urlencode 'query=litellm_remaining_team_budget_metric{team_alias="pending"} / litellm_team_max_budget_metric{team_alias="pending"}' | jq
```

Expected: the result is `NaN` (0/0), and `GB10TeamBudgetNearLimit` does not fire for `pending` — confirming the design note in `alert-rules.yml` is correct in practice, not just in theory.
