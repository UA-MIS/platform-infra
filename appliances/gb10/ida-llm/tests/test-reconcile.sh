#!/usr/bin/env bash
# appliances/gb10/ida-llm/tests/test-reconcile.sh
#
# Tests for reconcile.sh and for the compose/env contract it drives.
# Style follows appliances/gb10/test-render-config.sh (plain bash, run-by-hand,
# PASS/FAIL per case, non-zero exit listing the failures).
#
# Run:  bash tests/test-reconcile.sh
#
# ── WHAT THESE TESTS EXIST TO PIN DOWN ──────────────────────────────────────
# The property that matters most is NEGATIVE: this reconciler must never destroy
# local state. The box's appliance checkout is 44 commits ahead of its remote
# with the live LiteLLM routing sitting UNCOMMITTED in its working tree, so a
# reconciler that reset --hard would take the student model endpoint down and
# delete the only copy of the config on the way out. Cases 1-5 are that
# property, asserted by checking the tree is UNCHANGED after a refusal -- not
# merely that the exit code was non-zero.
#
# ── REAL GIT, FAKE DOCKER ───────────────────────────────────────────────────
# git is NOT stubbed: each case builds a real bare "origin" and a real clone, so
# the fast-forward/dirty/ahead logic is exercised against real git behaviour
# rather than against a fake's idea of it. docker and curl ARE stubbed -- they
# are the side effects under observation, and a test that built two real
# container images would not be run.
set -uo pipefail
cd "$(dirname "$0")/.."
STACK_DIR="$PWD"
RECONCILE="$STACK_DIR/reconcile.sh"
COMPOSE="$STACK_DIR/docker-compose.yml"

failures=0
pass_count=0
pass() { echo "PASS: $1"; pass_count=$((pass_count + 1)); }
fail() { echo "FAIL: $1"; shift; [ $# -gt 0 ] && printf '  %s\n' "$@"; failures=$((failures + 1)); }
check() { # check <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected: $2" "actual:   $3"; fi
}

# ════════════════════════════════════════════════════════════════════════════
#  sandbox
# ════════════════════════════════════════════════════════════════════════════
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

# A sandbox per case: real origin + clone, stub bin, stack dir.
new_sandbox() {
  local w="$ROOT/case-$1"
  mkdir -p "$w/bin" "$w/stack/state"
  (
    set -e
    git init --quiet --bare --initial-branch=main "$w/origin.git"
    git init --quiet --initial-branch=main "$w/seed"
    cd "$w/seed"
    git config user.email t@t; git config user.name t
    echo "v1" > app.txt
    mkdir -p frontend && echo FROM scratch > Dockerfile.python && echo FROM scratch > frontend/Dockerfile
    git add -A && git commit --quiet -m one
    echo "v2" > app.txt && git add -A && git commit --quiet -m two
    git remote add origin "$w/origin.git"
    git push --quiet origin main
  ) >"$w/seed.log" 2>&1 || { echo "FATAL: sandbox $1 seed failed"; sed 's/^/  /' "$w/seed.log"; exit 2; }
  git clone --quiet "$w/origin.git" "$w/repo" >>"$w/seed.log" 2>&1 \
    || { echo "FATAL: sandbox $1 clone failed"; sed 's/^/  /' "$w/seed.log"; exit 2; }
  git -C "$w/repo" rev-parse HEAD >/dev/null 2>&1 \
    || { echo "FATAL: sandbox $1 clone has no HEAD"; exit 2; }
  ( cd "$w/repo" && git config user.email t@t && git config user.name t )

  cp "$RECONCILE" "$w/stack/reconcile.sh"; chmod +x "$w/stack/reconcile.sh"
  cp "$COMPOSE" "$w/stack/docker-compose.yml"
  printf 'IDA_DB_PASSWORD=pw\nIDA_AUTH_TOKENS=tok\nLOCAL_LLM_API_KEY=vk-test\nIDA_API_PORT=8001\n' \
    > "$w/stack/.env"
  cat > "$w/stack/versions.env" <<'EOF'
IDA_POSTGRES_DIGEST=postgres@sha256:aaa
IDA_REDIS_DIGEST=redis@sha256:bbb
IDA_PYTHON_IMAGE=ida-llm-python-app:bootstrap
IDA_FRONTEND_IMAGE=ida-llm-frontend:bootstrap
IDA_BUILD_PYTHON_BASE=python@sha256:ccc
IDA_BUILD_NODE_BASE=node@sha256:ddd
KEEP_ME=sentinel
EOF

  # ---- stub docker ----
  cat > "$w/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$DOCKER_LOG"
case "$*" in
  *" ps --status running"*) [ "${FAKE_DB_RUNNING:-0}" = "1" ] && echo ida-db; exit 0 ;;
  *"pg_dump"*)
    case "${FAKE_DUMP_MODE:-good}" in
      fail)      exit 1 ;;
      truncated) printf -- '-- partial write, no header\n' ;;
      *)         printf -- '--\n-- PostgreSQL database dump\n--\nCREATE TABLE runs (id text);\n' ;;
    esac
    exit 0 ;;
  *"image inspect"*)     echo "${FAKE_IMAGE_ARCH:-arm64}"; exit 0 ;;
esac
exit 0
EOF
  # ---- stub curl ----
  # Distinguishes the two probes the way the real ones differ: /readyz is a
  # plain exit status, the completion probe is an HTTP code via -w.
  cat > "$w/bin/curl" <<'EOF'
#!/usr/bin/env bash
args="$*"
# DRAIN STDIN ONLY FOR THE HEADER-ON-STDIN CALL. An unconditional `cat` here
# blocks FOREVER on the readiness probe, which passes no stdin: the stub then
# inherits the runner's stdin and waits for an EOF that never comes. That hung
# the suite SILENTLY instead of failing it -- a stub that makes the code under
# test look stuck is worse than no stub at all.
case "$args" in
  *"-H @-"*) cat >/dev/null 2>&1 || true ;;
esac
echo "curl $args" >> "$CURL_LOG"
case "$args" in
  *readyz*)           exit "${FAKE_READY_EXIT:-0}" ;;
  *chat/completions*) printf '%s' "${FAKE_MODEL_CODE:-200}"; exit 0 ;;
esac
exit 0
EOF
  chmod +x "$w/bin/docker" "$w/bin/curl"
  printf '%s' "$w"
}

run_reconcile() { # run_reconcile <sandbox> [extra env assignments...]
  local w="$1"; shift
  ( cd "$w/stack"
    export PATH="$w/bin:$PATH"
    export DOCKER_LOG="$w/docker.log" CURL_LOG="$w/curl.log"
    export IDA_REPO_DIR="$w/repo" IDA_REPO_URL="$w/origin.git"
    export IDA_APPLIANCE_REPO="$w/appliance-repo"
    export IDA_STATE_DIR="$w/stack/state"
    export IDA_ENV_FILE="$w/stack/.env" IDA_VERSIONS_FILE="$w/stack/versions.env"
    export IDA_COMPOSE_FILE="$w/stack/docker-compose.yml"
    export IDA_READY_TIMEOUT=10 IDA_MODEL_TIMEOUT=2
    for kv in "$@"; do export "$kv"; done
    # stdin from /dev/null: belt-and-braces alongside the curl stub's
    # conditional drain. Nothing under test should ever read stdin, and a stub
    # that blocks on it hangs the suite instead of failing it.
    ./reconcile.sh < /dev/null
  ) > "$w/out.log" 2>&1
  echo $?
}

echo "═══ reconcile.sh: safety (never destroy local state) ═══"

# ── 1. refuses to operate on the appliance's own checkout ───────────────────
w="$(new_sandbox 1)"
mkdir -p "$w/appliance-repo"
rc=$(run_reconcile "$w" IDA_REPO_DIR="$w/appliance-repo")
if [ "$rc" != "0" ] && grep -q "refusing to reconcile" "$w/out.log"; then
  pass "refuses when the target IS the hand-edited appliance checkout"
else
  fail "refuses when the target IS the hand-edited appliance checkout" "rc=$rc" "$(tail -3 "$w/out.log")"
fi

# ── 1b. the same refusal via a symlink (resolved-path comparison) ───────────
w="$(new_sandbox 1b)"
mkdir -p "$w/appliance-repo"; ln -s "$w/appliance-repo" "$w/alias"
rc=$(run_reconcile "$w" IDA_REPO_DIR="$w/alias")
if [ "$rc" != "0" ] && grep -q "refusing to reconcile" "$w/out.log"; then
  pass "the appliance guard resolves symlinks (cannot be bypassed by aliasing)"
else
  fail "the appliance guard resolves symlinks" "rc=$rc" "$(tail -3 "$w/out.log")"
fi

# ── 2. a DIRTY tree aborts and is left untouched ─────────────────────────────
w="$(new_sandbox 2)"
echo "LOCAL EDIT -- the only copy" > "$w/repo/app.txt"
before_head="$(git -C "$w/repo" rev-parse HEAD)"
rc=$(run_reconcile "$w")
after_head="$(git -C "$w/repo" rev-parse HEAD)"
content="$(cat "$w/repo/app.txt")"
if [ "$rc" != "0" ] \
   && [ "$content" = "LOCAL EDIT -- the only copy" ] \
   && [ "$before_head" = "$after_head" ]; then
  pass "a dirty tree aborts AND the local edit survives (no reset --hard)"
else
  fail "a dirty tree aborts AND the local edit survives" \
       "rc=$rc content=$content head_changed=$([ "$before_head" = "$after_head" ] && echo no || echo YES)"
fi
check "the dirty-tree abort runs no docker commands" "0" "$( [ -f "$w/docker.log" ] && wc -l < "$w/docker.log" | tr -d ' ' || echo 0 )"

# ── 3. an UNTRACKED file also counts as dirty ───────────────────────────────
w="$(new_sandbox 3)"
echo "backup" > "$w/repo/litellm-config.yaml.bak-1792818189"
rc=$(run_reconcile "$w")
if [ "$rc" != "0" ] && [ -f "$w/repo/litellm-config.yaml.bak-1792818189" ]; then
  pass "an untracked file aborts and is not deleted (the box has four of these)"
else
  fail "an untracked file aborts and is not deleted" "rc=$rc"
fi

# ── 4. LOCAL COMMITS not upstream abort, and are not discarded ──────────────
w="$(new_sandbox 4)"
( cd "$w/repo" && echo local > extra.txt && git add -A && git commit --quiet -m "local only" )
local_sha="$(git -C "$w/repo" rev-parse HEAD)"
rc=$(run_reconcile "$w")
if [ "$rc" != "0" ] \
   && [ "$(git -C "$w/repo" rev-parse HEAD)" = "$local_sha" ] \
   && grep -q "not in origin/main" "$w/out.log"; then
  pass "local commits abort and survive (the appliance tree's 'ahead 44' case)"
else
  fail "local commits abort and survive" "rc=$rc" "$(tail -3 "$w/out.log")"
fi

# ── 5. a missing .env / versions.env is fatal, and nothing is run ───────────
w="$(new_sandbox 5)"; rm "$w/stack/.env"
rc=$(run_reconcile "$w")
if [ "$rc" != "0" ] && grep -q "not found" "$w/out.log"; then
  pass "a missing .env is fatal"
else fail "a missing .env is fatal" "rc=$rc"; fi

w="$(new_sandbox 5b)"; rm "$w/stack/versions.env"
rc=$(run_reconcile "$w")
if [ "$rc" != "0" ] && grep -q "versions.env" "$w/out.log"; then
  pass "a missing versions.env is fatal"
else fail "a missing versions.env is fatal" "rc=$rc"; fi

echo
echo "═══ reconcile.sh: idempotence and the happy path ═══"

# ── 6. happy path: fast-forward, build, up, ready, record ──────────────────
w="$(new_sandbox 6)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )   # one behind origin/main
target="$(git -C "$w/repo" rev-parse origin/main)"
rc=$(run_reconcile "$w")
check "a behind-but-clean tree reconciles successfully" "0" "$rc"
check "HEAD fast-forwarded to origin/main" "$target" "$(git -C "$w/repo" rev-parse HEAD)"
check "last-good SHA recorded" "$target" "$(cat "$w/stack/state/last-good-sha" 2>/dev/null)"
if grep -q "docker build" "$w/docker.log" && grep -q "up -d --remove-orphans" "$w/docker.log"; then
  pass "it built the images and brought the stack up"
else fail "it built the images and brought the stack up" "$(cat "$w/docker.log")"; fi
if grep -q -- "--build-arg PYTHON_IMAGE=python@sha256:ccc" "$w/docker.log" \
  && grep -q -- "--build-arg NODE_IMAGE=node@sha256:ddd" "$w/docker.log"; then
  pass "the arm64 base-image overrides are passed as build args"
else fail "the arm64 base-image overrides are passed as build args" "$(grep build "$w/docker.log" | head -2)"; fi
check "versions.env now pins the python image to the commit" \
  "IDA_PYTHON_IMAGE=ida-llm-python-app:${target:0:12}" \
  "$(grep '^IDA_PYTHON_IMAGE=' "$w/stack/versions.env")"
check "rewriting versions.env preserves its other lines" "KEEP_ME=sentinel" \
  "$(grep '^KEEP_ME=' "$w/stack/versions.env")"

# ── 7. second run with nothing to do is a true no-op ───────────────────────
rm -f "$w/docker.log"
rc=$(run_reconcile "$w")
check "a reconcile with nothing to do exits 0" "0" "$rc"
check "...and issues NO docker commands at all" "0" \
  "$( [ -f "$w/docker.log" ] && wc -l < "$w/docker.log" | tr -d ' ' || echo 0 )"

# ── 8. the lock serialises runs ────────────────────────────────────────────
w="$(new_sandbox 8)"
mkdir -p "$w/stack/state"
( exec 9>"$w/stack/state/reconcile.lock"; flock -n 9; sleep 6 ) &
holder=$!
sleep 1
rc=$(run_reconcile "$w")
wait $holder 2>/dev/null
if [ "$rc" = "0" ] && grep -q "another reconcile holds the lock" "$w/out.log"; then
  pass "a concurrent run exits 0 without acting (not a spurious failure)"
else fail "a concurrent run exits 0 without acting" "rc=$rc" "$(tail -2 "$w/out.log")"; fi

# ── 7b. it builds the commit it RECONCILED TO, not a tip that moved ────────
# The build context is a DIRECTORY, so if anything moves HEAD between the fetch
# and the build, docker builds different source and tags it with this SHA -- an
# image whose name is a lie. Under build-on-the-box the tag IS the provenance
# (there is no signed registry digest behind it), so that is worse than a failed
# deploy.
#
# Simulated faithfully: `backup_database` calls `compose ps` BEFORE
# `resolve_images`, so a stub that rewinds HEAD on its first invocation lands
# exactly in the window the guard protects.
w="$(new_sandbox 7b)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )
cat > "$w/bin/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "\$DOCKER_LOG"
git -C "$w/repo" reset --hard --quiet HEAD~1 2>/dev/null || true
exit 0
EOF
chmod +x "$w/bin/docker"
rc=$(run_reconcile "$w")
if [ "$rc" != "0" ] && grep -q "refusing to build" "$w/out.log"; then
  pass "a HEAD that moves mid-run aborts before anything is built"
else
  fail "a HEAD that moves mid-run aborts before anything is built" "rc=$rc" "$(tail -3 "$w/out.log")"
fi
# `grep -c` prints "0" AND exits 1 when there are no matches, so a
# `|| echo 0` fallback would append a SECOND zero and the comparison would
# fail against the literal "0". Assign, then default on failure.
builds=$(grep -c 'docker build' "$w/docker.log" 2>/dev/null) || builds=0
check "...and NO image was built with a SHA it does not contain" "0" "$builds"

# ── 7c. the images it DOES build are tagged with the reconciled short SHA ──
w="$(new_sandbox 7c)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )
target7c="$(git -C "$w/repo" rev-parse origin/main)"
run_reconcile "$w" >/dev/null
for img in ida-llm-python-app ida-llm-frontend; do
  if grep -q -- "-t ${img}:${target7c:0:12} " "$w/docker.log"; then
    pass "$img is tagged with the reconciled commit (${target7c:0:12})"
  else
    fail "$img is tagged with the reconciled commit" "$(grep 'docker build' "$w/docker.log")"
  fi
done

echo
echo "═══ reconcile.sh: migrations, readiness, rollback ═══"

# ── 9. pre-migration dump is taken when the DB is up, and a short dump is fatal
w="$(new_sandbox 9)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )
rc=$(run_reconcile "$w" FAKE_DB_RUNNING=1)
check "a reconcile with the DB up succeeds" "0" "$rc"
if grep -q "pg_dump" "$w/docker.log" && ls "$w/stack/state"/pre-migration-*.sql.gz >/dev/null 2>&1; then
  pass "a pre-migration dump is written before migrating"
else fail "a pre-migration dump is written before migrating" "$(cat "$w/docker.log")"; fi
if gzip -t "$w/stack/state"/pre-migration-*.sql.gz 2>/dev/null \
   && zcat "$w/stack/state"/pre-migration-*.sql.gz | grep -q 'PostgreSQL database dump'; then
  pass "the kept dump is a valid gzip containing real pg_dump output"
else fail "the kept dump is a valid gzip containing real pg_dump output"; fi
check "the uncompressed intermediate is cleaned up" "0" \
  "$(ls "$w/stack/state"/pre-migration-*.sql 2>/dev/null | wc -l | tr -d ' ')"

w="$(new_sandbox 9b)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )
rc=$(run_reconcile "$w" FAKE_DB_RUNNING=1 FAKE_DUMP_MODE=truncated)
if [ "$rc" != "0" ] && grep -q "does not look like pg_dump output" "$w/out.log"; then
  pass "a headerless (truncated) dump is treated as FAILED, not as a restore point"
else fail "a headerless (truncated) dump is treated as FAILED" "rc=$rc" "$(tail -3 "$w/out.log")"; fi
check "...and the useless dump file is not left behind as a decoy" "0" \
  "$(ls "$w/stack/state"/pre-migration-* 2>/dev/null | wc -l | tr -d ' ')"

# ── 9c. pg_dump exiting non-zero also blocks the migration ─────────────────
w="$(new_sandbox 9c)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )
rc=$(run_reconcile "$w" FAKE_DB_RUNNING=1 FAKE_DUMP_MODE=fail)
if [ "$rc" != "0" ] && grep -q "pg_dump FAILED" "$w/out.log"; then
  pass "a failing pg_dump blocks the migration entirely"
else fail "a failing pg_dump blocks the migration entirely" "rc=$rc" "$(tail -3 "$w/out.log")"; fi

# ── 10. readiness uses a REAL completion, never /v1/models ─────────────────
w="$(new_sandbox 10)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )
run_reconcile "$w" >/dev/null
if grep -q "chat/completions" "$w/curl.log" && ! grep -q "v1/models" "$w/curl.log"; then
  pass "the model probe posts a real completion and never gates on /v1/models"
else fail "the model probe posts a real completion" "$(cat "$w/curl.log")"; fi
check "no curl in the script ever targets /v1/models" "0" \
  "$(grep -E 'curl' "$RECONCILE" | grep -c 'v1/models')"

# ── 11. a 4xx from the model route is OUR bug -> fatal ─────────────────────
w="$(new_sandbox 11)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )
rc=$(run_reconcile "$w" FAKE_MODEL_CODE=401)
if [ "$rc" != "0" ] && grep -q "that is OUR configuration" "$w/out.log"; then
  pass "a 401 from the model route fails the deploy (bad virtual key)"
else fail "a 401 from the model route fails the deploy" "rc=$rc" "$(tail -3 "$w/out.log")"; fi

# ── 12. a TIMEOUT is the shared model being busy -> warn, do not fail ──────
w="$(new_sandbox 12)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )
rc=$(run_reconcile "$w" FAKE_MODEL_CODE=000)
if [ "$rc" = "0" ] && grep -q "NOT failing the deploy" "$w/out.log"; then
  pass "a model timeout warns but does not roll back (students' model, not ours)"
else fail "a model timeout warns but does not roll back" "rc=$rc" "$(tail -3 "$w/out.log")"; fi

# ── 13. api never ready -> rollback to last good ──────────────────────────
w="$(new_sandbox 13)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )
run_reconcile "$w" >/dev/null                      # establish a last-good
good="$(cat "$w/stack/state/last-good-sha")"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )  # go backwards so there is work
rm -f "$w/docker.log"
rc=$(run_reconcile "$w" FAKE_READY_EXIT=22)
if [ "$rc" != "0" ] && grep -q "rolling back" "$w/out.log"; then
  pass "an api that never becomes ready triggers a rollback"
else fail "an api that never becomes ready triggers a rollback" "rc=$rc" "$(tail -4 "$w/out.log")"; fi
check "rollback re-pins versions.env to the last-good SHA" \
  "IDA_PYTHON_IMAGE=ida-llm-python-app:${good:0:12}" \
  "$(grep '^IDA_PYTHON_IMAGE=' "$w/stack/versions.env")"

# ── 14. .env values are PARSED, never executed ────────────────────────────
# `source .env` would run `vk|nope` as a pipeline and kill the script under
# `set -e` (the appliance's render-config.sh had exactly this bug).
w="$(new_sandbox 14)"
( cd "$w/repo" && git reset --hard --quiet HEAD~1 )
printf 'IDA_DB_PASSWORD=pw\nIDA_AUTH_TOKENS=tok\nLOCAL_LLM_API_KEY="vk|nope; echo PWNED > %s/pwned"\nIDA_API_PORT=8001\n' "$w" > "$w/stack/.env"
rc=$(run_reconcile "$w")
if [ "$rc" = "0" ] && [ ! -f "$w/pwned" ]; then
  pass "a .env value containing shell metacharacters is parsed, not executed"
else fail "a .env value containing shell metacharacters is parsed, not executed" \
       "rc=$rc pwned=$([ -f "$w/pwned" ] && echo YES || echo no)"; fi

# ── 15. the secret never reaches argv (visible in ps to every box user) ────
if grep -q 'Authorization: Bearer' "$RECONCILE" && grep -q -- '-H @-' "$RECONCILE"; then
  pass "the LiteLLM key is passed to curl via stdin, never on the command line"
else fail "the LiteLLM key is passed to curl via stdin, never on the command line"; fi
check "no 'echo \$LOCAL_LLM_API_KEY'-style leak in the script" "0" \
  "$(grep -cE '(echo|printf)[^|]*\$(\{)?LOCAL_LLM_API_KEY' "$RECONCILE")"

echo
echo "═══ compose + env contract ═══"

cfg() { docker compose --env-file "$1" --env-file "$2" -f "$COMPOSE" "${@:3}"; }
GOOD_ENV="$ROOT/good.env"; GOOD_VER="$ROOT/good.versions"
printf 'IDA_DB_PASSWORD=pw\nIDA_AUTH_TOKENS=tok\nLOCAL_LLM_API_KEY=vk\n' > "$GOOD_ENV"
printf 'IDA_POSTGRES_DIGEST=postgres@sha256:a\nIDA_REDIS_DIGEST=redis@sha256:b\nIDA_PYTHON_IMAGE=p:1\nIDA_FRONTEND_IMAGE=f:1\n' > "$GOOD_VER"

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker CLI not available; compose-contract cases not run"
else
  # ── 16. each required secret is a HARD requirement ──────────────────────
  for v in IDA_DB_PASSWORD IDA_AUTH_TOKENS LOCAL_LLM_API_KEY; do
    grep -v "^${v}=" "$GOOD_ENV" > "$ROOT/missing.env"
    if cfg "$ROOT/missing.env" "$GOOD_VER" config >/dev/null 2>&1; then
      fail "compose refuses to render without $v" "it rendered anyway"
    else
      pass "compose refuses to render without $v"
    fi
  done
  # ── 17. and so is every image digest ────────────────────────────────────
  for v in IDA_POSTGRES_DIGEST IDA_PYTHON_IMAGE; do
    grep -v "^${v}=" "$GOOD_VER" > "$ROOT/missing.versions"
    if cfg "$GOOD_ENV" "$ROOT/missing.versions" config >/dev/null 2>&1; then
      fail "compose refuses to render without $v" "it rendered anyway"
    else
      pass "compose refuses to render without $v"
    fi
  done

  # ── 18. the default `up` is the PROD shape ──────────────────────────────
  services="$(cfg "$GOOD_ENV" "$GOOD_VER" config --services | sort | tr '\n' ' ')"
  check "default profile = the prod shape (no mock, no sweeps)" \
    "ida-api ida-db ida-frontend ida-init ida-migrate ida-redis ida-runner " "$services"
  all="$(cfg "$GOOD_ENV" "$GOOD_VER" --profile mock --profile sweeps config --services | sort | tr '\n' ' ')"
  for s in ida-mock-model ida-sweep-rebenchmark ida-sweep-model-sweep ida-sweep-judge-calibration; do
    case "$all" in *"$s"*) pass "$s exists, behind a profile" ;;
                   *) fail "$s exists, behind a profile" "not found in $all" ;; esac
  done

  rendered="$(cfg "$GOOD_ENV" "$GOOD_VER" config 2>/dev/null)"

  # ── 19. NO unprefixed service name (the DNS-collision guard) ────────────
  # An unprefixed `postgres`/`redis`/`litellm` here would collide with the
  # appliance's aliases on the shared network, and DATABASE_URL could resolve
  # to LiteLLM's database.
  bad="$(cfg "$GOOD_ENV" "$GOOD_VER" --profile mock --profile sweeps config --services \
          | grep -vE '^ida-' | tr '\n' ' ')"
  check "every service name is ida--prefixed (no appliance DNS collision)" "" "$bad"

  # ── 20. only the services that need LiteLLM join the appliance network ──
  py_net="$(printf '%s' "$rendered" | python3 -c "
import sys,yaml
d=yaml.safe_load(sys.stdin)
on=[k for k,v in d['services'].items() if 'appliance' in (v.get('networks') or {})]
print(' '.join(sorted(on)))")"
  check "api/runner/sweeps (only) are on the appliance network" \
    "ida-api ida-runner" "$py_net"

  # ── 21. the frontend must not take Grafana's port ───────────────────────
  fe_ports="$(printf '%s' "$rendered" | python3 -c "
import sys,yaml
d=yaml.safe_load(sys.stdin)
print(','.join(str(p.get('published')) for p in d['services']['ida-frontend']['ports']))")"
  if [ "$fe_ports" = "3100" ]; then
    pass "the frontend publishes 3100, not 3000 (gb10-grafana owns 3000)"
  else fail "the frontend publishes 3100, not 3000" "got: $fe_ports"; fi

  # ── 22. schema comes from Alembic, not bootstrap.py ─────────────────────
  mig="$(printf '%s' "$rendered" | python3 -c "
import sys,yaml
d=yaml.safe_load(sys.stdin)
print(' '.join(d['services']['ida-migrate']['command']))")"
  check "migrations run alembic (same image as the api), not bootstrap.py" \
    "alembic upgrade head" "$mig"
  case "$rendered" in *bootstrap.py*) fail "bootstrap.py must not appear (it would fork the schema lineage)";;
                      *) pass "bootstrap.py appears nowhere in the rendered stack" ;; esac

  # ── 23. no MinIO anywhere; artifacts are local ─────────────────────────
  case "$rendered" in *minio/minio*) fail "no MinIO image (amd64-only on this arm64 box)" ;;
                      *) pass "no MinIO image in the stack" ;; esac
  case "$rendered" in *"IDA_ARTIFACT_BACKEND: local"*) pass "artifacts use the local backend" ;;
                      *) fail "artifacts use the local backend" ;; esac

  # ── 24. the relocation seam is wired to LiteLLM, not to raw Ollama ─────
  case "$rendered" in *"http://litellm:4000/v1"*) pass "LOCAL_LLM_BASE_URL points at LiteLLM" ;;
                      *) fail "LOCAL_LLM_BASE_URL points at LiteLLM" ;; esac
  case "$rendered" in *11434*) fail "nothing addresses Ollama directly (:11434 bypasses all auth)" ;;
                      *) pass "nothing addresses Ollama directly (:11434 bypasses all auth)" ;; esac

  # ── 25. every variable compose interpolates is documented in an example ─
  # The appliance's lesson: a value in .env that is not named in compose never
  # reaches the container. The converse is just as bad -- a variable compose
  # needs that no example file mentions is undiscoverable.
  undocumented=""
  for v in $(grep -v '^[[:space:]]*#' "$COMPOSE" \
               | grep -oE '\$\{[A-Z_][A-Z0-9_]*' | sed 's/^\${//' | sort -u); do
    grep -qE "^${v}=" "$STACK_DIR/.env.example" "$STACK_DIR/versions.env.example" \
      || undocumented="$undocumented $v"
  done
  check "every compose variable is documented in .env.example/versions.env.example" \
    "" "$undocumented"
fi

echo
echo "─────────────────────────────────────────────"
echo "$pass_count passed, $failures failed"
[ "$failures" -eq 0 ] || exit 1
