# node-exporter textfile metrics

Drop a `*.prom` file here and `gb10-node-exporter` exposes its contents, which
`gb10-prometheus` already scrapes (`node-exporter:9100`) — **no scrape-config
change needed**.

Mounted read-only into the exporter at `/host/textfile` by
`appliances/gb10/docker-compose.yml`. Writers write here on the host.

Rules that make this reliable rather than a source of confusing gaps:

* **Write atomically.** Write to `<name>.prom.tmp` in this directory, then
  `mv` it into place. node-exporter reads on every scrape and a half-written
  file is a parse error that drops the whole textfile batch, not just that one
  file.
* **Same filesystem for the temp file**, or `mv` is a copy and stops being
  atomic.
* **Always include a timestamp gauge.** A `*.prom` file that stops being
  updated keeps serving its last value forever — indistinguishable from a
  healthy constant. A `..._last_run_timestamp_seconds` lets an alert fire on
  *staleness*, which is the failure that actually happens.

Current writers:

| File | Written by |
|---|---|
| `ida-llm-reconcile.prom` | `appliances/gb10/ida-llm/reconcile.sh` |

`*.prom` is gitignored; this README and the directory are tracked so the bind
mount always has something to mount.
