# ida-llm on the GB10 appliance

The ida-llm benchmark harness, running as `docker compose` on
`promaxgb10-d62a` alongside the local-LLM appliance.

**Like its parent directory, this is NOT managed by ArgoCD.** There is no
Application that reconciles it, on purpose — `reconcile.sh` + a systemd timer
plays that role instead (see [Reconciling](#reconciling)).

> **Phase 1 status: this runs ALONGSIDE the live cluster tenant.** The cluster
> still serves `ida-llm.capstone.uamishub.com` and its `-dev` / `-staging` /
> `-agile` siblings, and nothing here repoints a single DNS record or touches
> the cluster. Retiring the cluster tenant is a separate, human-gated pass.
> Full design and the cutover procedure:
> `artifacts/design/ida-llm-gb10-relocation.md` in `Capstone-Modernization`.

## The two things most likely to surprise you

**1. This box is `aarch64` and every promoted ida-llm image is `amd64`.** So the
stack **builds its own images** from the commit it reconciles to. It is not a
stylistic choice:

```
$ docker manifest inspect --verbose harbor.../ida-llm/ida-llm-python-app:1.0.1
  → {'architecture': 'amd64', 'os': 'linux'}      # single-arch, no index
$ docker run --platform linux/amd64 alpine:3.20 uname -m        # on the box
  exec /bin/uname: exec format error              # no binfmt/QEMU registered
```

Installing binfmt needs root on the box. Until arm64 images are published, a
pulled image cannot execute here at all. `IDA_IMAGE_SOURCE=registry` exists for
the day that changes and refuses to deploy a non-arm64 image rather than leaving
you with a restart loop and an opaque error.

**2. `reconcile.sh` will never `git reset --hard`, and refuses to run against
`/opt/gb10-appliance-repo`.** That tree is 44 commits ahead of its remote with
the live LiteLLM routing sitting **uncommitted** in its working directory. A
reconciler that reset it would take the student model endpoint down and delete
the only copy of the config doing so. Drift there is **reported, never
corrected** — see [Appliance drift](#appliance-drift).

## Operating it

```bash
cd /opt/gb10-appliance-repo/appliances/gb10/ida-llm

# ⚠ BOTH --env-file flags, always. Image refs live in versions.env; omit it and
# every `image:` interpolates to empty. Don't redirect stderr while debugging —
# compose reports interpolation errors there and nowhere else.
docker compose --env-file .env --env-file versions.env ps
docker compose --env-file .env --env-file versions.env logs -f ida-api

sudo systemctl status  ida-llm              # the stack
sudo systemctl restart ida-llm
sudo systemctl status  ida-llm-reconcile.timer
sudo systemctl start   ida-llm-reconcile    # reconcile right now
journalctl -u ida-llm-reconcile -n 100
```

The frontend is on `http://127.0.0.1:3100` by default; set
`IDA_FRONTEND_BIND=100.103.27.65` in `.env` to reach it from the tailnet.
**Not port 3000** — `gb10-grafana` already publishes that.

Scale the workers (no `container_name`, so this works):

```bash
docker compose --env-file .env --env-file versions.env up -d --scale ida-runner=2
```

## What runs, and what it replaces

| Cluster (`.devops/chart/base/`) | Here | Note |
|---|---|---|
| `ida-llm-frontend` ×2 | `ida-frontend` ×1 | host `:3100`, not `:3000` |
| `ida-llm-api` ×2 + `migrate` initContainer | `ida-api` + `ida-migrate` | `alembic upgrade head`, same image |
| `ida-llm-runner` ×4 | `ida-runner` (scale to taste) | no healthcheck — queue consumer, as in the chart |
| `ida-llm-mock-model` (0 replicas) | `ida-mock-model`, `--profile mock` | off; prod must use real models |
| `ida-llm-object-store` (MinIO + 10Gi PVC) | **gone** → `IDA_ARTIFACT_BACKEND=local` | MinIO is amd64-only; see below |
| `ida-llm-redis` StatefulSet + 1Gi PVC | `ida-redis` + `redis-data` volume | `--appendonly yes` |
| CNPG tenant DB (PG 17.9) | `ida-db` (`postgres:17-alpine`) | **separate** from `gb10-postgres` (16.15) |
| 3 CronJobs, `suspend: true` | `--profile sweeps` one-shots | **no timer shipped** — D-43 |
| ESO ← Vault | `.env`, hand-seeded | see `.env.example` |
| Traefik Ingress + cert | host port on the tailnet | no new DNS in Phase 1 |
| `ida-llm-agile` | **stays on the cluster** | not in this chart — it is ArgoCD app `agile-board-ida-llm`, one of 13 per-team boards in the shared `agile` namespace |

### Why no MinIO

The only surviving MinIO source is Harbor's `base-images/minio/minio` mirror,
and that image is **amd64** — verified 2026-11-12. `quay.io` and `docker.io`
both 401 for `minio/minio` now, `dl.min.io` is 410 Gone, and `mc` has **no
mirror at all** (0 tags). Rather than invent a source, this stack uses the app's
own first-class `IDA_ARTIFACT_BACKEND=local`
(`ida_core.artifacts.LocalArtifactStore`) on a shared volume. On one box the
filesystem *is* the object store; MinIO existed in-cluster to put an S3 API in
front of ceph.

`ida-init` is the one-shot that makes that volume writable by uid 65532 — the
compose equivalent of the chart's `fsGroup`. A fresh named volume is root-owned
and both app images run as `65532:65532`, so without it
`LocalArtifactStore.ensure_bucket()` fails `EACCES` on first boot.

### Why a second Postgres

`gb10-postgres` is **16.15**; the cluster tenant DB this stack must receive is
**17.9**. A 17→16 dump/restore is a downgrade and is not supported. A dedicated
instance also keeps an ida-llm disk-fill or a bad migration away from the
LiteLLM database that gates student access to the model.

## The model route

`models.yaml`'s `qwen-local` entry carries `base_url_env: LOCAL_LLM_BASE_URL`
with the public Cloudflare hostname as its literal fallback. This stack sets
that variable to `http://litellm:4000/v1`, reaching LiteLLM over the
appliance's own docker network (`gb10-appliance_default`, joined `external`).
Verified: HTTP 401 from a container on that network — reachable, auth-gated.

**Through LiteLLM, never straight to Ollama.** Ollama on `:11434` has **no
authentication**, so addressing it directly would bypass keys, teams, budgets
and per-team quota entirely. Going through LiteLLM makes ida-llm's usage
metered, attributed and separately revocable.

Two constraints that shaped the cluster design are **gone** here, and the design
doc says so explicitly: there is no Cloudflare in this path (so no ~100s 524 on
a non-streamed completion) and no tenant `:443`-only egress fence.
`extra.stream: true` is nonetheless **kept** in `models.yaml` because it is
still required on the public route the cluster tenant uses.

### Minting the LiteLLM key

`LOCAL_LLM_API_KEY` must be a **dedicated virtual key on its own team** — never
`LITELLM_MASTER_KEY`, never a student or faculty key. That separation is the
entire reason for routing through LiteLLM. On the box:

```bash
cd /opt/gb10-appliance-repo/appliances/gb10
# LITELLM_MASTER_KEY is read from .env into the environment and never echoed.
set -a; . ./.env; set +a

curl -sS http://127.0.0.1:4000/team/new \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
  -d '{"team_alias":"ida-llm","models":["qwen3.8-27b"]}'

curl -sS http://127.0.0.1:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
  -d '{"team_id":"<id from above>","models":["qwen3.8-27b"],"key_alias":"ida-llm-harness"}'
```

Put the returned key in this directory's `.env` as `LOCAL_LLM_API_KEY`. Do not
paste it into a terminal you are screen-sharing, and do not `echo` it back.

## Reconciling

`reconcile.sh` (timer: every 10 min, `RandomizedDelaySec=90`) brings the stack
to the state of a git ref:

1. `flock` — one at a time; a concurrent run exits **0**, not as an error.
2. Report drift in the appliance checkout (never correct it).
3. Fetch into its **own clean clone** (`IDA_REPO_DIR`, default `/opt/ida-llm-repo`).
4. **Abort, changing nothing**, if that tree is dirty *or* carries local commits.
5. No-op if already at the target and the last deploy succeeded.
6. `git merge --ff-only` — never a reset; a force-push upstream fails loudly.
7. `pg_dump` **before** Alembic. A dump under 200 bytes is treated as *failed*,
   because a restore point that restores nothing is worse than none.
8. Build (or pull) images tagged with the commit; rewrite `versions.env`.
9. `compose up -d`, then wait for the api's `/readyz`.
10. Probe the model route with a **real `POST /v1/chat/completions`**.
11. On api-never-ready: roll back to the last-good SHA and exit non-zero.

**`/v1/models` is not a readiness probe on this box** — it has returned 200 at
104 s into a boot whose first real completion did not land until 373 s. Hence
step 10. The 4xx-vs-timeout split there is deliberate: a `401`/`404` means *our*
config is wrong and fails the deploy; a **timeout** means the shared model is
cold or busy serving a class, which this stack neither caused nor can fix, so it
warns and continues.

### What is deployed right now?

```bash
curl -s http://127.0.0.1:3100/api/version | python3 -m json.tool
```

```json
{ "frontend": { "label": "9b6ca79abc12", "identified": true },
  "api":      { "reachable": true, "version": "1.0.1", "gitSha": "9b6ca79abc12…" },
  "consistent": true }
```

This endpoint exists because **building on the box removes the one thing a
promoted Harbor digest gave us for free**: an answer to "what is running" that
does not require logging in. The frontend is the only published surface here (the
api is loopback-bound in every environment), so it carries the answer.

It reports **both** images deliberately — they are built as a pair from one
commit, so the failure worth seeing is them *disagreeing*: a half-applied deploy,
or a rollback that moved one tag and not the other. `consistent` is `null`, never
`false`, when it cannot tell (api unreachable, or a build with no `IDA_VERSION`):
not knowing must not look like a mismatch.

Deliberately **not** part of `/api/healthz`, which is the liveness path probed
every 10 s and must not do network I/O — folding them together would let a brief
api blip restart the frontend.

The reconciler also guarantees the other half of this: it asserts
`git rev-parse HEAD == <reconciled target>` **before building**, and aborts
without building anything if they differ. The build context is a directory, so a
tip that moved mid-run would otherwise produce an image tagged with a SHA whose
source it does not contain — and under build-on-the-box the tag *is* the
provenance.

```bash
# what the reconciler last successfully deployed
cat state/last-good-sha
```

### Why not bare `main`

`IDA_GIT_REF` defaults to `main`, but on a box with no staging environment in
front of it a **tag** or pinned SHA is safer: every push to `main` would
otherwise reach this stack within 10 minutes with no gate. Set
`IDA_GIT_REF=v1.0.1` to deploy deliberately.

### Appliance drift

Every run prints a line like:

```
drift gb10-appliance-repo dirty_files=6 unpushed_commits=44
```

Non-zero values are expected **today** and are not corrected by this script —
the drift *is* the live production config. Closing it means committing that
config to git (a PR, done as part of this work) and then reconciling the
appliance repo onto it. Until then the number is the honest measure of how much
of this box exists only on its own disk.

## Backups

This box has **no Velero, no ceph and no CNPG continuous archiving** — the
three things that made the cluster tenant recoverable.

* **Pre-migration dumps**: automatic, `state/pre-migration-<sha>-<ts>.sql.gz`,
  last 14 kept. These cover a bad migration, *not* disk loss — they are on the
  same disk as the database.
* **Off-box backups are NOT yet configured, and that is an open item.** Until
  one exists, treat this stack's data as recoverable only from the cluster
  tenant (which still holds it during Phase 1). The design doc carries the
  proposal and sizing; the current data is small (prod: **15 MB** database,
  **53 MB** artifacts — not 10 GB).

## Observability

The appliance's Prometheus scrapes the appliance's own services. This stack is
**not scraped yet**. `reconcile.sh` writes `state/reconcile.prom` in Prometheus
textfile format, but **nothing reads it**: `gb10-node-exporter` runs without
`--collector.textfile.directory`. Wiring it up is a two-line change to the
appliance compose file (add the flag, mount the directory). Until that lands,
the file is for humans and `journalctl` — **do not describe it as monitoring.**

## Tests

```bash
bash tests/test-reconcile.sh
```

Covers the reconciler's refusal paths (asserting the tree is **unchanged**, not
merely that the exit code was non-zero), idempotence, the lock, the
pre-migration dump including a truncated one, the readiness/rollback path, the
4xx-vs-timeout split, `.env` values being parsed rather than executed, the key
never reaching `argv` — and the compose/env contract: required variables,
profile membership, the `ida-` prefix that prevents an appliance DNS collision,
the frontend's port, Alembic-not-`bootstrap.py`, no MinIO, and that every
variable compose interpolates is documented in an example file.

git is **not** stubbed (each case builds a real bare origin and clone, so the
fast-forward/dirty/ahead logic is tested against real git); `docker` and `curl`
are.

## Installing on the box (owner, needs `sudo`)

```bash
cd /opt/gb10-appliance-repo/appliances/gb10/ida-llm
cp .env.example .env && chmod 600 .env     # then fill it in
cp versions.env.example versions.env

sudo cp deploy/ida-llm.service deploy/ida-llm-reconcile.service \
        deploy/ida-llm-reconcile.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ida-llm.service          # ⚠ enable, not link
sudo systemctl enable --now ida-llm-reconcile.timer
```

**`enable`, not `link`.** The appliance unit spent weeks `linked` rather than
`enabled`, which meant its containers only ever came back via Docker's
`restart: unless-stopped` — recovery was proven, persistence was not. Verify
with `systemctl is-enabled ida-llm` → it must print `enabled`.
