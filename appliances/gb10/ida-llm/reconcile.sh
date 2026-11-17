#!/usr/bin/env bash
# appliances/gb10/ida-llm/reconcile.sh
#
# Bring the ida-llm stack on this box to the state described by a git ref.
# Invoked by ida-llm-reconcile.timer; safe to run by hand.
#
# ══════════════════════════════════════════════════════════════════════════════
#  WHY THIS SCRIPT NEVER RUNS `git reset --hard`, AND NEVER TOUCHES
#  /opt/gb10-appliance-repo
# ══════════════════════════════════════════════════════════════════════════════
# The obvious reconciler is `git fetch && git reset --hard origin/main && up -d`.
# On THIS box that is an outage. Verified 2026-11-12, in /opt/gb10-appliance-repo:
#
#   * it is checked out on branch `gb10-appliance`, NOT main, and is **44
#     commits ahead** of its own remote branch;
#   * three of those commits (#708, #709, #710) are NOT ancestors of
#     origin/main, so main does not contain them;
#   * `litellm-config.yaml` has **uncommitted** changes (34 insertions, 47
#     deletions) and those changes ARE the live production model routing -- the
#     entire 2026-10-24 vLLM -> Ollama switch exists ONLY in that working tree
#     and in no git branch anywhere;
#   * there is a staged-but-uncommitted hunk in agentic-benchmark-2026-09-30.md,
#     and four untracked litellm-config.yaml.bak-* files.
#
# A `reset --hard origin/main` there would restore vLLM routing to a stopped
# vLLM container and take the student model endpoint down, destroying the only
# copy of the working config on the way. So:
#
#   1. This script operates on its OWN clean clone (IDA_REPO_DIR, default
#      /opt/ida-llm-repo). Nothing hand-edits that tree, so it is safe to
#      fast-forward. It REFUSES to run against /opt/gb10-appliance-repo.
#   2. Even there, it only ever FAST-FORWARDS, and it ABORTS -- loudly, changing
#      nothing -- if the tree is dirty or carries local commits. Drift is
#      reported, never overwritten. A reconciler that silently discards local
#      state is how you lose the one copy of something that matters.
#   3. The appliance's own drift is REPORTED, not corrected (see `report_drift`).
#      It cannot be corrected from here: the drift is the production config.
#      Closing it requires committing that config to git, which is a human's PR,
#      not a timer's job.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

REPO_URL="${IDA_REPO_URL:-https://github.com/UA-MIS/ida-llm.git}"
REPO_DIR="${IDA_REPO_DIR:-/opt/ida-llm-repo}"
GIT_REF="${IDA_GIT_REF:-main}"
IMAGE_SOURCE="${IDA_IMAGE_SOURCE:-build}"
STATE_DIR="${IDA_STATE_DIR:-$HERE/state}"
ENV_FILE="${IDA_ENV_FILE:-$HERE/.env}"
VERSIONS_FILE="${IDA_VERSIONS_FILE:-$HERE/versions.env}"
COMPOSE_FILE="${IDA_COMPOSE_FILE:-$HERE/docker-compose.yml}"
APPLIANCE_REPO="${IDA_APPLIANCE_REPO:-/opt/gb10-appliance-repo}"
LOCK_FILE="${IDA_LOCK_FILE:-$STATE_DIR/reconcile.lock}"
# Where node-exporter's textfile collector reads from. The appliance mounts
# this directory read-only into gb10-node-exporter, and gb10-prometheus already
# scrapes that exporter -- so writing here is the whole publish path.
TEXTFILE_DIR="${IDA_TEXTFILE_DIR:-$HERE/../textfile-metrics}"
# Seconds to wait for the api to become ready before rolling back.
READY_TIMEOUT="${IDA_READY_TIMEOUT:-180}"
# Seconds to wait for a real chat completion. Generous: a cold Ollama reload is
# ~10s, but the box is shared with students and may be mid-generation.
MODEL_TIMEOUT="${IDA_MODEL_TIMEOUT:-120}"

log()  { printf '%s reconcile: %s\n'  "$(date -Is)" "$*"; }
warn() { printf '%s reconcile: WARNING: %s\n' "$(date -Is)" "$*" >&2; }
die()  { printf '%s reconcile: FATAL: %s\n'   "$(date -Is)" "$*" >&2; exit 1; }

compose() {
  # BOTH --env-file flags, always. versions.env holds the image refs; drop it
  # and every `image:` interpolates to empty. Never redirect stderr here --
  # compose reports interpolation errors there and nowhere else.
  docker compose \
    --env-file "$ENV_FILE" \
    --env-file "$VERSIONS_FILE" \
    -f "$COMPOSE_FILE" "$@"
}

# Read ONE key out of an env file without `source`-ing it.
#
# `source .env` EXECUTES the file as shell. A value containing a shell
# metacharacter (`KEY=abc|def`) then runs as a pipeline, and under `set -e` that
# kills this script -- turning one malformed value into a total reconcile
# failure. This is the same finding that was fixed in the appliance's
# render-config.sh (security review round 4, finding 4); the fix belongs here
# too. Plain grep/cut, one matching pair of surrounding quotes stripped, because
# quoting a value in .env is conventional.
env_value() {
  local key="$1" file="$2" v
  [ -f "$file" ] || return 0
  v="$(grep -m1 "^${key}=" "$file" | cut -d= -f2- || true)"
  while [[ "$v" == *[[:space:]] ]]; do v="${v%?}"; done
  if { [[ "$v" == \"*\" ]] || [[ "$v" == \'*\' ]]; } && [ ${#v} -ge 2 ]; then
    v="${v:1:${#v}-2}"
    while [[ "$v" == *[[:space:]] ]]; do v="${v%?}"; done
  fi
  printf '%s' "$v"
}

# ── drift reporting for the APPLIANCE tree (never corrected from here) ───────
report_drift() {
  local repo="$1" label="$2" dirty ahead
  [ -d "$repo/.git" ] || { warn "$label: $repo is not a git checkout"; return 0; }
  dirty="$(git -C "$repo" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  ahead="$(git -C "$repo" log --oneline '@{upstream}..HEAD' 2>/dev/null | wc -l | tr -d ' ')"
  printf 'drift %s dirty_files=%s unpushed_commits=%s\n' "$label" "$dirty" "$ahead"
  if [ "$dirty" != "0" ] || [ "$ahead" != "0" ]; then
    warn "$label has drifted from git: ${dirty} modified/untracked file(s), ${ahead} unpushed commit(s)."
    warn "$label is NOT reconciled by this script -- reporting only. See this file's header."
  fi
}

main() {
  mkdir -p "$STATE_DIR"

  # ── single instance. A reconcile that overlaps itself can have two `compose
  # up` runs racing the same containers and two Alembic runs racing the same
  # schema (Alembic locks, so they serialise rather than corrupt -- but the
  # second is pure confusion in the logs).
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another reconcile holds the lock; exiting 0 (not an error)"
    exit 0
  fi

  [ -f "$ENV_FILE" ]      || die "$ENV_FILE not found. cp .env.example .env and fill it in."
  [ -f "$VERSIONS_FILE" ] || die "$VERSIONS_FILE not found. cp versions.env.example versions.env."
  [ -f "$COMPOSE_FILE" ]  || die "$COMPOSE_FILE not found."

  # ── GUARD: never operate on the hand-edited appliance tree ────────────────
  # Compared by resolved path so a symlink or a trailing slash cannot slip past.
  local resolved_repo resolved_appliance
  resolved_repo="$(readlink -f "$REPO_DIR" 2>/dev/null || printf '%s' "$REPO_DIR")"
  resolved_appliance="$(readlink -f "$APPLIANCE_REPO" 2>/dev/null || printf '%s' "$APPLIANCE_REPO")"
  if [ "$resolved_repo" = "$resolved_appliance" ]; then
    die "refusing to reconcile $REPO_DIR: that is the appliance's own hand-edited
checkout, and it holds the ONLY copy of the live LiteLLM routing config. Point
IDA_REPO_DIR at a dedicated clone (default /opt/ida-llm-repo)."
  fi

  report_drift "$resolved_appliance" "gb10-appliance-repo" || true

  # ── get / update our own clean clone ──────────────────────────────────────
  if [ ! -d "$REPO_DIR/.git" ]; then
    log "cloning $REPO_URL -> $REPO_DIR"
    git clone --quiet "$REPO_URL" "$REPO_DIR"
  fi
  git -C "$REPO_DIR" fetch --quiet --tags --prune origin

  # ── PREFLIGHT: abort on ANY local state. Report, never overwrite. ─────────
  local dirty
  dirty="$(git -C "$REPO_DIR" status --porcelain)"
  if [ -n "$dirty" ]; then
    printf '%s\n' "$dirty" >&2
    die "$REPO_DIR has local modifications (listed above). Refusing to touch it.
This script NEVER discards local state. Inspect, then either commit the change
upstream or remove it by hand once you are sure it is not the only copy."
  fi

  # Local commits that are not upstream. The appliance tree's `ahead 44` is the
  # live example of why this is checked rather than assumed away.
  local ahead
  ahead="$(git -C "$REPO_DIR" log --oneline "origin/${GIT_REF}..HEAD" 2>/dev/null || true)"
  if [ -n "$ahead" ]; then
    printf '%s\n' "$ahead" >&2
    die "$REPO_DIR carries commits not in origin/${GIT_REF} (listed above).
A fast-forward would not reach them and a reset would destroy them. Resolve by
hand."
  fi

  local target current
  target="$(git -C "$REPO_DIR" rev-parse --verify "origin/${GIT_REF}^{commit}" 2>/dev/null \
            || git -C "$REPO_DIR" rev-parse --verify "${GIT_REF}^{commit}")"
  current="$(git -C "$REPO_DIR" rev-parse HEAD)"
  local last_good; last_good="$(cat "$STATE_DIR/last-good-sha" 2>/dev/null || true)"

  log "ref=${GIT_REF} head=${current:0:12} target=${target:0:12} last_good=${last_good:0:12}"

  # ── IDEMPOTENCE. The timer fires on a schedule; most firings have nothing to
  # do and must cost nothing and change nothing.
  if [ "$current" = "$target" ] && [ "$last_good" = "$target" ]; then
    log "already at ${target:0:12} and last deploy succeeded; nothing to do"
    write_status "ok" "$target" "noop"
    exit 0
  fi

  if [ "$current" != "$target" ]; then
    log "fast-forwarding to ${target:0:12}"
    # --ff-only: if upstream was force-pushed or rebased this FAILS rather than
    # silently rewriting local history.
    git -C "$REPO_DIR" merge --ff-only "$target"
  fi

  deploy "$target" "$last_good"
}

# Build (or pull) the images for a commit and write them into versions.env.
resolve_images() {
  local sha="$1"
  local short="${sha:0:12}"
  local py="ida-llm-python-app:${short}" fe="ida-llm-frontend:${short}"

  # ⚠ BUILD THE COMMIT WE RECONCILED TO, NEVER "WHATEVER THE TREE IS NOW".
  # `target` was resolved from origin/<ref> once, near the top of this run, and
  # the build context below is a DIRECTORY -- so if anything moved HEAD in
  # between (a concurrent operator, a second fetch, a branch tip that advanced),
  # docker would happily build different source and tag it with this SHA. That
  # produces an image whose name is a lie, which is far worse than a failed
  # deploy: the whole point of build-on-the-box is that the tag IS the
  # provenance, now that there is no signed registry digest behind it.
  local head
  head="$(git -C "$REPO_DIR" rev-parse HEAD)"
  if [ "$head" != "$sha" ]; then
    die "refusing to build: $REPO_DIR is at ${head:0:12} but this run reconciled
to ${sha:0:12}. Something moved HEAD mid-run. Nothing has been built or
deployed; re-run once the tree is settled."
  fi

  if [ "$IMAGE_SOURCE" = "build" ]; then
    # ⚠ BUILT HERE, ON PURPOSE AND OUT OF NECESSITY. Every promoted Harbor image
    # is amd64-only and this box is aarch64 with no binfmt registered, so a
    # pulled image cannot exec at all. Both Dockerfiles parameterise their base
    # image, so this needs no fork of either -- just an arm64 base.
    local pybase nodebase
    pybase="$(env_value IDA_BUILD_PYTHON_BASE "$VERSIONS_FILE")"
    nodebase="$(env_value IDA_BUILD_NODE_BASE "$VERSIONS_FILE")"
    [ -n "$pybase" ]   || die "IDA_BUILD_PYTHON_BASE is unset in $VERSIONS_FILE"
    [ -n "$nodebase" ] || die "IDA_BUILD_NODE_BASE is unset in $VERSIONS_FILE"

    log "building $py (base $pybase)"
    docker build --quiet \
      --build-arg "PYTHON_IMAGE=${pybase}" \
      --build-arg "GIT_SHA=${sha}" \
      -f "$REPO_DIR/Dockerfile.python" -t "$py" "$REPO_DIR" >/dev/null
    log "building $fe (base $nodebase)"
    docker build --quiet \
      --build-arg "NODE_IMAGE=${nodebase}" \
      --build-arg "IDA_VERSION=${sha:0:12}" \
      -f "$REPO_DIR/frontend/Dockerfile" -t "$fe" "$REPO_DIR" >/dev/null
  else
    log "pulling images for ${short} from the registry"
    py="$(env_value IDA_PYTHON_IMAGE "$VERSIONS_FILE")"
    fe="$(env_value IDA_FRONTEND_IMAGE "$VERSIONS_FILE")"
    docker pull --quiet "$py" >/dev/null
    docker pull --quiet "$fe" >/dev/null
    # Guard the one failure mode that otherwise reaches `up` as an unreadable
    # "exec format error" inside a restart loop.
    local arch
    arch="$(docker image inspect "$py" --format '{{.Architecture}}')"
    [ "$arch" = "arm64" ] || die "pulled image $py is ${arch}, but this box is arm64.
A non-arm64 image cannot exec here. Set IDA_IMAGE_SOURCE=build, or publish arm64 images."
  fi

  set_versions_image IDA_PYTHON_IMAGE "$py"
  set_versions_image IDA_FRONTEND_IMAGE "$fe"
}

# Rewrite one KEY=value in versions.env in place, atomically.
set_versions_image() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp "${VERSIONS_FILE}.XXXXXX")"
  # Preserve everything else byte for byte; replace or append the one key.
  if grep -q "^${key}=" "$VERSIONS_FILE"; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "${key}="*) printf '%s=%s\n' "$key" "$val" ;;
        *)          printf '%s\n' "$line" ;;
      esac
    done < "$VERSIONS_FILE" > "$tmp"
  else
    cat "$VERSIONS_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  chmod --reference="$VERSIONS_FILE" "$tmp" 2>/dev/null || true
  mv "$tmp" "$VERSIONS_FILE"
}

backup_database() {
  # ⚠ TWO statements, not one. `local a="$1" b="...${a}..."` does NOT work:
  # `local` is a builtin, so ALL its arguments are expanded before any of the
  # assignments take effect -- `${sha}` would still be unbound (and fatal under
  # `set -u`). Caught by tests/test-reconcile.sh case 9.
  local sha="$1"
  local out="$STATE_DIR/pre-migration-${sha:0:12}-$(date +%Y%m%dT%H%M%SZ).sql.gz"
  # ⚠ BEFORE Alembic, every time. This box has no Velero, no ceph snapshot and
  # no CNPG continuous archiving -- the three things that made a bad migration
  # recoverable in the cluster. A dump taken here is the ONLY pre-migration
  # restore point that exists.
  if ! compose ps --status running --services 2>/dev/null | grep -qx 'ida-db'; then
    log "ida-db is not running yet (first deploy); no pre-migration dump to take"
    return 0
  fi
  log "pre-migration dump -> $out"
  local raw="${out%.gz}"
  if ! compose exec -T ida-db pg_dump -U ida -d ida > "$raw" 2>/dev/null; then
    rm -f "$raw"
    die "pre-migration pg_dump FAILED. Refusing to run migrations without a
restore point. Fix the database first."
  fi

  # ⚠ VERIFY BY CONTENT, NOT BY SIZE. The first version of this check compared
  # the size of the GZIPPED file against a floor, which is the wrong instrument
  # twice over: a few KB of repetitive SQL compresses below any sane floor (the
  # test suite caught exactly that), and a small-but-perfectly-valid dump would
  # have been rejected while a large file of garbage would have passed.
  #
  # pg_dump always writes this header comment, and nothing else here does. So
  # this asks the question that matters -- "is this actually a dump?" -- rather
  # than a proxy for it. A truncated or empty dump has no header and fails.
  if ! grep -q 'PostgreSQL database dump' "$raw"; then
    local got; got="$(stat -c%s "$raw")"
    rm -f "$raw"
    die "the pre-migration dump (${got} bytes) does not look like pg_dump output --
no 'PostgreSQL database dump' header. Treating it as FAILED: a restore point
that restores nothing is worse than none. Refusing to migrate."
  fi

  gzip -c "$raw" > "$out" && rm -f "$raw"
  # Prove the artifact we KEEP is intact, not just that gzip exited 0.
  gzip -t "$out" || die "pre-migration dump $out failed its own gzip integrity check."
  log "pre-migration dump ok ($(stat -c%s "$out") bytes gzipped)"
  find "$STATE_DIR" -name 'pre-migration-*.sql.gz' -type f | sort | head -n -14 | xargs -r rm -f
}

api_ready() {
  local port; port="$(env_value IDA_API_PORT "$ENV_FILE")"; port="${port:-8001}"
  curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${port}/readyz" 2>/dev/null
}

# ── the model route: a REAL completion, not /v1/models ──────────────────────
# /v1/models on this box is NOT a readiness probe: it has returned 200 at 104s
# into a boot whose first real completion did not land until 373s. So this posts
# an actual (tiny) chat completion.
#
# The 4xx/timeout distinction is deliberate. A 401/404 means OUR config is wrong
# (bad virtual key, wrong alias, wrong base URL) and is fatal. A timeout means
# the SHARED model is cold or busy serving a class, which this stack neither
# caused nor can fix -- rolling ida-llm back for that would be wrong.
check_model_route() {
  local key base code
  key="$(env_value LOCAL_LLM_API_KEY "$ENV_FILE")"
  base="${IDA_MODEL_PROBE_BASE:-http://127.0.0.1:4000/v1}"
  if [ -z "$key" ]; then warn "LOCAL_LLM_API_KEY is empty; skipping model probe"; return 0; fi

  # The key is passed via a header file on stdin, never on the command line --
  # an argv value is visible in `ps` to every user on the box.
  code="$(printf 'Authorization: Bearer %s\n' "$key" \
    | curl -sS -o /dev/null -w '%{http_code}' -m "$MODEL_TIMEOUT" \
        -H @- -H 'Content-Type: application/json' \
        -d '{"model":"qwen3.8-27b","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}' \
        "${base}/chat/completions" 2>/dev/null || printf '000')"

  case "$code" in
    200) log "model route ok: a real completion returned 200" ;;
    000) warn "model route timed out after ${MODEL_TIMEOUT}s (code 000). The shared
model may be cold or busy; NOT failing the deploy for a dependency this stack
does not own. Re-check with:
  docker logs gb10-litellm
  OLLAMA_HOST=100.103.27.65:11434 ollama ps
⚠ OLLAMA_HOST is NOT optional there. Ollama is bound to the tailnet address
only, and the CLI defaults to 127.0.0.1 -- so a bare \`ollama ps\` prints an
EMPTY table and reads as 'no model loaded' when the model is in fact resident.
Absence looking like an answer, same shape as a hung probe looking like a slow
one." ;;
    4*)  die "model route returned HTTP ${code} -- that is OUR configuration, not a
busy model. Check LOCAL_LLM_API_KEY (is it a valid LiteLLM virtual key?),
LOCAL_LLM_BASE_URL, and that the alias qwen3.8-27b still exists in
litellm-config.yaml." ;;
    *)   warn "model route returned HTTP ${code}; continuing (server-side, not our config)" ;;
  esac
}

write_status() {
  local state="$1" sha="$2" note="${3:-}"
  local ok; ok=$([ "$state" = "ok" ] && echo 1 || echo 0)

  # Prometheus textfile format, published through gb10-node-exporter's
  # --collector.textfile.directory (enabled in the appliance compose file
  # 2026-11-12). gb10-prometheus already scrapes that exporter, so no
  # scrape-config change is involved.
  #
  # ⚠ WRITTEN ATOMICALLY (.tmp then mv). node-exporter re-reads this directory
  # on EVERY scrape, and a half-written file is a parse error that discards the
  # whole textfile batch -- not just this file. The temp file is in the same
  # directory so the mv is a rename, not a copy.
  #
  # ⚠ THE TIMESTAMP GAUGE IS THE POINT. If this script stops running entirely,
  # `ida_llm_reconcile_ok` keeps serving its last value forever, which is
  # indistinguishable from a healthy constant. Alert on the AGE of
  # `..._last_run_timestamp_seconds`, not on the ok gauge -- a reconciler that
  # died is the failure that actually happens, and it is silent by default.
  if [ -d "$TEXTFILE_DIR" ] && [ -w "$TEXTFILE_DIR" ]; then
    local tmp="$TEXTFILE_DIR/ida-llm-reconcile.prom.tmp"
    cat > "$tmp" <<EOF
# HELP ida_llm_reconcile_last_run_timestamp_seconds Unix time of the last reconcile attempt.
# TYPE ida_llm_reconcile_last_run_timestamp_seconds gauge
ida_llm_reconcile_last_run_timestamp_seconds $(date +%s)
# HELP ida_llm_reconcile_ok Whether the last reconcile succeeded (1) or failed (0).
# TYPE ida_llm_reconcile_ok gauge
ida_llm_reconcile_ok ${ok}
EOF
    mv "$tmp" "$TEXTFILE_DIR/ida-llm-reconcile.prom"
  else
    warn "textfile dir $TEXTFILE_DIR is missing or not writable -- reconcile
metrics will NOT reach Prometheus. (Creating it is enough; the appliance mounts
it read-only into gb10-node-exporter.)"
  fi

  printf '%s state=%s sha=%s %s\n' "$(date -Is)" "$state" "$sha" "$note" \
    >> "$STATE_DIR/reconcile.log"
}

deploy() {
  local target="$1" last_good="$2"

  backup_database "$target"
  resolve_images "$target"

  log "docker compose up -d"
  compose up -d --remove-orphans

  local waited=0
  until api_ready; do
    waited=$((waited + 5))
    if [ "$waited" -ge "$READY_TIMEOUT" ]; then
      warn "api did not become ready within ${READY_TIMEOUT}s"
      write_status "failed" "$target" "api-not-ready"
      rollback "$last_good"
      die "deploy of ${target:0:12} FAILED (api never became ready).
Rolled back to ${last_good:0:12}. Logs: docker compose logs ida-api ida-migrate"
    fi
    sleep 5
  done
  log "api is ready"

  check_model_route

  printf '%s' "$target" > "$STATE_DIR/last-good-sha"
  write_status "ok" "$target" "deployed"
  log "reconciled to ${target:0:12}"
}

rollback() {
  local last_good="$1"
  if [ -z "$last_good" ]; then
    warn "no last-good SHA recorded (this was the first deploy); leaving the
stack as it is for inspection rather than guessing at a previous state."
    return 0
  fi
  warn "rolling back to ${last_good:0:12}"
  set_versions_image IDA_PYTHON_IMAGE   "ida-llm-python-app:${last_good:0:12}"
  set_versions_image IDA_FRONTEND_IMAGE "ida-llm-frontend:${last_good:0:12}"
  # Images for last_good are still in the local docker image store (they are
  # tagged by SHA and never pruned by this script), so this needs no rebuild.
  compose up -d --remove-orphans || warn "rollback compose up reported an error"
}

main "$@"
