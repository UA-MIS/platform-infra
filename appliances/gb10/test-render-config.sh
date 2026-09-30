#!/usr/bin/env bash
# appliances/gb10/test-render-config.sh
#
# Regression test for render-config.sh (security review round 4,
# finding-3-followup, 2026-09-30): render-config.sh is this appliance's
# systemd ExecStartPre, so a non-zero exit from it blocks the ENTIRE
# stack at boot -- not just alert delivery. The one property this test
# exists to pin down: NO shape of ALERTMANAGER_SLACK_WEBHOOK_URL may
# ever produce a non-zero exit. Blank, malformed, wrong scheme,
# containing a sed-delimiter character, containing whitespace or a
# newline-family character -- every one of those must degrade to the
# null receiver and exit 0. Only two things may ever be fatal: a
# missing .env, and a missing template. Both are asserted here too, so
# a future change cannot silently turn EITHER direction wrong -- making
# a real fatal case permissive, or making a webhook shape fatal again.
#
# Not wired into any CI -- there isn't one for this repo's shell
# scripts yet. Run by hand: `bash test-render-config.sh` from this
# directory. Exits 0 if every case passes, non-zero (with the specific
# failures listed) otherwise.
set -uo pipefail
cd "$(dirname "$0")"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cp render-config.sh "$WORKDIR/"
mkdir -p "$WORKDIR/alertmanager"
cp alertmanager/alertmanager.yml.template "$WORKDIR/alertmanager/"

failures=0
pass_count=0

# Args: description, expected_exit_code, expected_receiver_or_empty,
# then the .env content to test with (passed via stdin so callers don't
# fight quoting).
run_case() {
  local desc="$1" expected_exit="$2" expected_receiver="$3"
  local env_content
  env_content="$(cat)"

  rm -f "$WORKDIR/.env" "$WORKDIR/alertmanager/alertmanager.yml"
  if [ "$env_content" != "__NO_ENV_FILE__" ]; then
    printf '%s' "$env_content" > "$WORKDIR/.env"
  fi

  ( cd "$WORKDIR" && ./render-config.sh > "$WORKDIR/stdout.log" 2>&1 )
  local actual_exit=$?

  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "FAIL: $desc -- expected exit $expected_exit, got $actual_exit"
    echo "  --- script output ---"
    sed 's/^/  /' "$WORKDIR/stdout.log"
    failures=$((failures + 1))
    return
  fi

  if [ -n "$expected_receiver" ]; then
    local actual_receiver
    actual_receiver="$(grep -E "^\s*receiver:" "$WORKDIR/alertmanager/alertmanager.yml" 2>/dev/null || true)"
    if ! echo "$actual_receiver" | grep -q "'${expected_receiver}'"; then
      echo "FAIL: $desc -- expected receiver '${expected_receiver}', got: ${actual_receiver:-<no file rendered>}"
      failures=$((failures + 1))
      return
    fi
  fi

  echo "PASS: $desc (exit=$actual_exit${expected_receiver:+, receiver=$expected_receiver})"
  pass_count=$((pass_count + 1))
}

# --- The two genuinely fatal cases: must stay fatal, with their
# already-verified exit codes. ---

run_case "missing .env is fatal (exit 1)" 1 "" <<'EOF'
__NO_ENV_FILE__
EOF

# (missing-template is exercised separately below, since it needs the
# template file removed from WORKDIR rather than .env content varied.)
rm -f "$WORKDIR/.env" "$WORKDIR/alertmanager/alertmanager.yml"
printf 'ALERTMANAGER_SLACK_WEBHOOK_URL=\n' > "$WORKDIR/.env"
mv "$WORKDIR/alertmanager/alertmanager.yml.template" "$WORKDIR/alertmanager/alertmanager.yml.template.hidden"
( cd "$WORKDIR" && ./render-config.sh > "$WORKDIR/stdout.log" 2>&1 )
actual_exit=$?
mv "$WORKDIR/alertmanager/alertmanager.yml.template.hidden" "$WORKDIR/alertmanager/alertmanager.yml.template"
if [ "$actual_exit" -eq 2 ]; then
  echo "PASS: missing template is fatal (exit 2)"
  pass_count=$((pass_count + 1))
else
  echo "FAIL: missing template -- expected exit 2, got $actual_exit"
  sed 's/^/  /' "$WORKDIR/stdout.log"
  failures=$((failures + 1))
fi

# --- Every webhook shape: must degrade, never exit non-zero. ---

run_case "blank webhook degrades to null" 0 "null" <<'EOF'
ALERTMANAGER_SLACK_WEBHOOK_URL=
EOF

run_case "valid https webhook routes to slack" 0 "slack" <<'EOF'
ALERTMANAGER_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/FAKE/TEST/TOKEN
EOF

run_case "missing scheme degrades to null" 0 "null" <<'EOF'
ALERTMANAGER_SLACK_WEBHOOK_URL=hooks.slack.com/services/FAKE
EOF

# The finding-4 shell-injection shape AND the finding-3-followup
# sed-delimiter-collision shape at once: a literal '|' followed by a
# command that would prove execution if it ever ran.
rm -f "$WORKDIR/marker"
printf 'ALERTMANAGER_SLACK_WEBHOOK_URL=https://h.example/a|touch %s/marker\n' "$WORKDIR" > "$WORKDIR/.env"
rm -f "$WORKDIR/alertmanager/alertmanager.yml"
( cd "$WORKDIR" && ./render-config.sh > "$WORKDIR/stdout.log" 2>&1 )
actual_exit=$?
if [ "$actual_exit" -ne 0 ]; then
  echo "FAIL: pipe-containing webhook -- expected exit 0, got $actual_exit"
  sed 's/^/  /' "$WORKDIR/stdout.log"
  failures=$((failures + 1))
elif [ -f "$WORKDIR/marker" ]; then
  echo "FAIL: pipe-containing webhook -- the injected command ACTUALLY RAN"
  failures=$((failures + 1))
elif ! grep -q "receiver: 'null'" "$WORKDIR/alertmanager/alertmanager.yml" 2>/dev/null; then
  echo "FAIL: pipe-containing webhook -- did not degrade to the null receiver"
  failures=$((failures + 1))
else
  echo "PASS: pipe-containing webhook degrades to null, exit 0, injection never runs"
  pass_count=$((pass_count + 1))
fi

run_case "space-containing webhook degrades to null" 0 "null" <<'EOF'
ALERTMANAGER_SLACK_WEBHOOK_URL=https://hooks.slack.com/a b
EOF

# A newline-FAMILY character cannot survive grep's own line-oriented
# extraction as a literal embedded '\n' (grep only ever matches one
# line), so the realistic way one reaches the extracted value is a
# CRLF-terminated .env line -- e.g. a Windows-edited .env file. Written
# with printf, not a heredoc, so the trailing \r survives exactly.
#
# Security review round 5, step 5 (2026-09-30): this now EXPECTS
# 'slack', not 'null' -- a deliberate behavior change from the
# round-4-followup version of this test. A trailing \r is a mechanical
# line-ending artifact with no legitimate meaning in a webhook value
# (unlike a trailing comment, below, which IS meaningful content this
# script cannot safely guess about) -- render-config.sh now strips
# trailing whitespace/CR before validating the value, so a Windows-
# edited .env with an otherwise-valid webhook is used correctly instead
# of being rejected over its line-ending style.
printf 'ALERTMANAGER_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/FAKE/TOKEN\r\n' > "$WORKDIR/.env"
rm -f "$WORKDIR/alertmanager/alertmanager.yml"
( cd "$WORKDIR" && ./render-config.sh > "$WORKDIR/stdout.log" 2>&1 )
actual_exit=$?
if [ "$actual_exit" -ne 0 ]; then
  echo "FAIL: CRLF-terminated webhook -- expected exit 0, got $actual_exit"
  sed 's/^/  /' "$WORKDIR/stdout.log"
  failures=$((failures + 1))
elif ! grep -q "receiver: 'slack'" "$WORKDIR/alertmanager/alertmanager.yml" 2>/dev/null; then
  echo "FAIL: CRLF-terminated webhook -- did not clean up and route to slack"
  failures=$((failures + 1))
elif ! grep -q "api_url: 'https://hooks.slack.com/services/FAKE/TOKEN'" "$WORKDIR/alertmanager/alertmanager.yml" 2>/dev/null; then
  echo "FAIL: CRLF-terminated webhook -- routed to slack but the \\r survived into api_url"
  failures=$((failures + 1))
else
  echo "PASS: CRLF-terminated (newline-family) webhook is cleaned and routes to slack, exit 0"
  pass_count=$((pass_count + 1))
fi

run_case "double-quoted webhook is unwrapped and routes to slack" 0 "slack" <<'EOF'
ALERTMANAGER_SLACK_WEBHOOK_URL="https://hooks.slack.com/services/FAKE/TOKEN"
EOF

# Single quotes need their own heredoc (rather than run_case's, which is
# double-quoted) so the literal single quotes in the .env content
# survive without the outer shell interpreting them.
printf "ALERTMANAGER_SLACK_WEBHOOK_URL='https://hooks.slack.com/services/FAKE/TOKEN'\n" > "$WORKDIR/.env"
rm -f "$WORKDIR/alertmanager/alertmanager.yml"
( cd "$WORKDIR" && ./render-config.sh > "$WORKDIR/stdout.log" 2>&1 )
actual_exit=$?
if [ "$actual_exit" -ne 0 ]; then
  echo "FAIL: single-quoted webhook -- expected exit 0, got $actual_exit"
  sed 's/^/  /' "$WORKDIR/stdout.log"
  failures=$((failures + 1))
elif ! grep -q "receiver: 'slack'" "$WORKDIR/alertmanager/alertmanager.yml" 2>/dev/null; then
  echo "FAIL: single-quoted webhook -- did not unwrap and route to slack"
  failures=$((failures + 1))
else
  echo "PASS: single-quoted webhook is unwrapped and routes to slack, exit 0"
  pass_count=$((pass_count + 1))
fi

run_case "trailing comment degrades to null (ambiguous content, not stripped)" 0 "null" <<'EOF'
ALERTMANAGER_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/FAKE/TOKEN # my webhook
EOF

echo
echo "${pass_count} passed, ${failures} failed."
if [ "$failures" -ne 0 ]; then
  exit 1
fi
