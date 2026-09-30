#!/usr/bin/env bash
# appliances/gb10/onboarding/test-setup-macos-linux.sh
#
# Execution test for setup-macos-linux.sh -- runs the real script and
# asserts on the config.yaml it produces.
#
# Companion to test-setup-windows.ps1. Same reason for existing: this is
# the copy-paste onboarding step students run, it had never been executed
# anywhere, and BOTH of its real failure modes are SILENT -- it prints
# "Added the 'UA MIS Local' model to your existing 'models:' list" and
# exits 0 whether it merged correctly or left the student with a
# config.yaml that no longer parses. A test asserting only `exit 0` would
# pass against a script that destroyed the file.
#
# That is not hypothetical. Executing the Windows script for the first
# time on 2026-09-30 found exactly that bug, and this script had the
# identical one: the item-indent detector used `[[:space:]]+`, which
# cannot match a ZERO-indented sequence item -- ordinary valid YAML, and
# what `yq` emits by default. Scenario S3-merge-0space pins it.
#
# House style follows test-render-config.sh in this directory: one
# process per scenario, assert on the OUTCOME rather than the exit code,
# print PASS/FAIL per assertion, tally, exit non-zero if anything failed.
# The structural assertions live in assert-continue-config.py, which
# parses the file with a real YAML parser -- a regex cannot tell boolean
# `false` from the string `'false'`, and cannot see that a file stopped
# parsing at all. This harness owns what a parser cannot see: exit codes,
# backups, byte-identical no-ops, and what reached stdout.
#
# Failures are tagged `FAILID: <scenario>/<assertion>` so --mutation-check
# can confirm a deliberately-broken script trips a SPECIFIC assertion
# rather than merely going red.
#
# Usage:
#   bash test-setup-macos-linux.sh [--script PATH] [--mutation-check]
#                                  [--assert-endpoint-unreachable]
#
# Requires: bash 3.2+, python3 with PyYAML.
#
# bash 3.2, not 4+, ON PURPOSE: this suite runs on macos-latest as well as
# ubuntu-latest, and macOS ships bash 3.2.57 as /bin/bash. A harness that
# needed bash 4 would silently not be testing the interpreter most
# students actually use. Nothing below uses associative arrays, mapfile,
# ${var^^}, negative indices or &>>, and every external tool has a BSD
# fallback -- see sha() and the stat call, both of which fail LOUDLY
# rather than degrading to a vacuous comparison.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_UNDER_TEST="${HERE}/setup-macos-linux.sh"
ASSERTER="${HERE}/assert-continue-config.py"
MUTATION_CHECK=0
ASSERT_UNREACHABLE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --script)                       SCRIPT_UNDER_TEST="$2"; shift 2 ;;
    --mutation-check)               MUTATION_CHECK=1; shift ;;
    --assert-endpoint-unreachable)  ASSERT_UNREACHABLE=1; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 3 ;;
  esac
done

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || { echo "no $PYTHON on PATH" >&2; exit 3; }
"$PYTHON" -c 'import yaml' 2>/dev/null || { echo "PyYAML missing: pip install pyyaml" >&2; exit 3; }

# Shaped like a real LiteLLM virtual key (sk- plus url-safe base64, so it
# exercises '-' and '_' surviving the write) but obviously fake.
DUMMY_KEY='sk-uamis_TEST-do_not_use-0123456789abcdef'

WORKROOT="$(mktemp -d)"
trap 'rm -rf "$WORKROOT"' EXIT

failures=0
pass_count=0
scenario='<none>'

pass() { printf 'PASS: %s/%s -- %s\n' "$scenario" "$1" "$2"; pass_count=$((pass_count + 1)); }
fail() {
  printf 'FAIL: %s/%s -- %s\n' "$scenario" "$1" "$2"
  [ $# -ge 3 ] && printf '%s\n' "$3" | sed 's/^/    /'
  printf 'FAILID: %s/%s\n' "$scenario" "$1"
  failures=$((failures + 1))
}
assert_eq() { # id desc expected actual
  if [ "$3" = "$4" ]; then pass "$1" "$2"
  else fail "$1" "$2" "expected: $3
actual:   $4"; fi
}
assert_true() { # id desc cond_rc detail
  if [ "$3" -eq 0 ]; then pass "$1" "$2"; else fail "$1" "$2" "${4:-}"; fi
}

# Makes a throwaway HOME. Any stdin is written as the pre-existing
# config.yaml; pass --json to also drop a legacy config.json.
new_home() {
  local h; h="$(mktemp -d "${WORKROOT}/home.XXXXXX")"
  printf '%s' "$h"
}
seed_yaml() { mkdir -p "$1/.continue"; cat > "$1/.continue/config.yaml"; }
seed_json() { mkdir -p "$1/.continue"; cat > "$1/.continue/config.json"; }

# Runs the script under test with HOME pointed at the throwaway dir.
# Sets: RUN_EXIT, RUN_OUT (combined stdout+stderr), RUN_CONFIG.
run_setup() { # $1=home  $2=api key (optional, defaults to DUMMY_KEY)
  local h="$1"; local key="${2-$DUMMY_KEY}"
  RUN_CONFIG="${h}/.continue/config.yaml"
  # The endpoint is HARDCODED in the script with no override, so the only
  # way to keep CI off production is to make the request fail. curl honours
  # these, and CI additionally points the hostname at 127.0.0.1 in
  # /etc/hosts. The script treats an unreachable endpoint as non-fatal.
  set +e
  RUN_OUT="$(HOME="$h" \
             http_proxy='http://127.0.0.1:9' https_proxy='http://127.0.0.1:9' \
             ALL_PROXY='http://127.0.0.1:9' \
             bash "$SCRIPT_UNDER_TEST" "$key" 2>&1)"
  RUN_EXIT=$?
  set -e
}

# Writes a copy of the script under test with the portal's substitution
# already applied, and runs it with NO key argument -- the way a student
# who downloaded it from the keys portal actually runs it.
#
# This is the seam the portal uses: keyportal/app.py replaces the single
# line `EMBEDDED_KEY=''` with `EMBEDDED_KEY=<shell-quoted key>` and serves
# the result. Reproduced here in the SAME quoting rule the portal uses --
# a single-quoted POSIX literal with a literal quote written as '\'' --
# so that if the portal's rule and this script's parsing ever disagree,
# this suite is what says so, in CI, rather than a student's 401.
#
# Sets the same RUN_EXIT/RUN_OUT/RUN_CONFIG as run_setup().
run_setup_embedded() { # $1=home  $2=key to embed
  local h="$1"; local key="$2"
  local served; served="$(mktemp "${WORKROOT}/served.XXXXXX")"

  # The SAME quoting rule keyportal/app.py's _shell_single_quote() uses:
  # wrap in single quotes, and write a literal single quote as '\'' --
  # close, escaped quote, reopen. This is NOT the rule build_block() uses
  # for the YAML scalar below (which DOUBLES the quote), and swapping them
  # fails silently rather than loudly, which is why S16 executes it.
  local quoted
  quoted="'$(printf '%s' "$key" | sed "s/'/'\\\\''/g")'"

  # awk on an exact line match, not sed: the key may contain any
  # punctuation, including sed's delimiters and backreference syntax. The
  # replacement travels through the environment so nothing parses it.
  # sprintf("%c",39) rather than \x27 because BSD awk (macOS) has no hex
  # escapes. Fails LOUDLY if the marker is not present exactly once -- the
  # same contract keyportal/app.py's _validate_setup_script() enforces.
  REPL="EMBEDDED_KEY=${quoted}" awk '
    BEGIN { marker = "EMBEDDED_KEY=" sprintf("%c%c", 39, 39) }
    $0 == marker { print ENVIRON["REPL"]; n++; next }
    { print }
    END {
      if (n != 1) {
        printf "expected exactly one EMBEDDED_KEY marker line, saw %d\n", n+0 \
          > "/dev/stderr"
        exit 3
      }
    }
  ' "$SCRIPT_UNDER_TEST" > "$served" \
    || { echo "HARNESS ERROR: EMBEDDED_KEY substitution failed" >&2; exit 3; }

  RUN_CONFIG="${h}/.continue/config.yaml"
  set +e
  RUN_OUT="$(HOME="$h" \
             http_proxy='http://127.0.0.1:9' https_proxy='http://127.0.0.1:9' \
             ALL_PROXY='http://127.0.0.1:9' \
             bash "$served" 2>&1)"
  RUN_EXIT=$?
  set -e
}

# Runs the structural assertions and folds their tally into ours.
assert_structure() { # $1=config path, rest = extra args to the asserter
  local cfg="$1"; shift
  local out rc
  set +e
  out="$("$PYTHON" "$ASSERTER" "$cfg" --scenario "$scenario" "$@" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 3 ]; then
    printf '%s\n' "$out"
    echo "HARNESS ERROR: assert-continue-config.py could not run" >&2
    exit 3
  fi
  # Reprint its PASS/FAIL/FAILID lines and adopt its counts.
  printf '%s\n' "$out" | grep -E '^(PASS|FAIL|FAILID|    )' || true
  local p f
  p="$(printf '%s' "$out" | sed -n 's/^\([0-9]*\) passed.*/\1/p' | tail -n1)"
  f="$(printf '%s' "$out" | sed -n 's/^[0-9]* passed, \([0-9]*\) failed.*/\1/p' | tail -n1)"
  pass_count=$((pass_count + ${p:-0}))
  failures=$((failures + ${f:-0}))
}

no_key_leak() {
  case "$RUN_OUT" in
    *"$DUMMY_KEY"*) fail "no-key-in-stdout" "the API key is never echoed to the console" \
                         "the key appeared in the script's own output" ;;
    *)              pass "no-key-in-stdout" "the API key is never echoed to the console" ;;
  esac
}
count_backups() { ls -1 "$1/.continue/" 2>/dev/null | grep -c '^config\.yaml\.bak-' || true; }
# Digest of a file, portably. macOS has no sha256sum -- it has shasum.
# This must FAIL LOUDLY rather than return empty on an unknown platform:
# an empty digest compares equal to another empty digest, so every
# "byte-identical" assertion would pass without checking anything.
SHA_TOOL=''
if command -v sha256sum >/dev/null 2>&1;  then SHA_TOOL='sha256sum'
elif command -v shasum >/dev/null 2>&1;   then SHA_TOOL='shasum -a 256'
elif command -v openssl >/dev/null 2>&1;  then SHA_TOOL='openssl dgst -sha256 -r'
else
  echo "no sha256sum, shasum or openssl on PATH -- refusing to run, because" >&2
  echo "the byte-identical assertions would silently pass without them." >&2
  exit 3
fi
sha() { $SHA_TOOL "$1" 2>/dev/null | cut -d' ' -f1; }

# ---------------------------------------------------------------------------
# Fixtures. Every one is a shape a real student's config.yaml can be in.
# ---------------------------------------------------------------------------

fixture_2space() { cat <<'EOF'
name: my-config
version: 0.0.1
schema: v1
models:
  - name: Claude Sonnet 4
    provider: anthropic
    model: claude-sonnet-4-20250514
    apiKey: sk-ant-ALREADY-HERE
    roles: [chat, edit]
context:
  - provider: code
EOF
}
# Zero-indented sequence items under a mapping key: ordinary valid YAML,
# and what `yq` emits by default.
fixture_0space() { cat <<'EOF'
name: my-config
version: 0.0.1
schema: v1
models:
- name: Claude Sonnet 4
  provider: anthropic
  model: claude-sonnet-4-20250514
  apiKey: sk-ant-ALREADY-HERE
  roles: [chat, edit]
EOF
}
# A comment between `models:` and the first item, item at the ordinary
# 2-space indent. Isolates comment-skipping from indent-detection.
fixture_comment_first() { cat <<'EOF'
schema: v1
models:
  # my own models live below
  - name: Claude Sonnet 4
    provider: anthropic
    apiKey: sk-ant-ALREADY-HERE
    roles: [chat, edit]
EOF
}
fixture_no_models() { cat <<'EOF'
name: my-config
version: 0.0.1
schema: v1
context:
  - provider: code
  - provider: docs
EOF
}
fixture_flow() { cat <<'EOF'
schema: v1
models: [{name: Claude, provider: anthropic, apiKey: sk-ant-ALREADY-HERE}]
EOF
}
fixture_duplicate() { cat <<'EOF'
schema: v1
models:
  - name: First
    provider: anthropic
other: thing
models:
  - name: Second
    provider: openai
EOF
}

# ---------------------------------------------------------------------------
# The suite
# ---------------------------------------------------------------------------

run_suite() {
  printf 'Script under test : %s\n' "$SCRIPT_UNDER_TEST"
  printf 'bash              : %s\n' "$BASH_VERSION"
  printf 'YAML assertions   : %s %s\n\n' "$PYTHON" "$ASSERTER"

  # --- S1: no existing config at all (the common first-time case) -------
  scenario='S1-fresh'
  h="$(new_home)"
  run_setup "$h"
  assert_eq "exit" "exits 0 on a clean machine" 0 "$RUN_EXIT"
  assert_structure "$RUN_CONFIG" --key "$DUMMY_KEY" --expect-count 3
  no_key_leak
  # The script chmods the file, since it now contains a credential.
  if [ -f "$RUN_CONFIG" ]; then
    assert_eq "perms" "the config holding the key is not world-readable" "600" \
              "$(stat -c '%a' "$RUN_CONFIG" 2>/dev/null || stat -f '%OLp' "$RUN_CONFIG")"
  fi
  if [ "$ASSERT_UNREACHABLE" -eq 1 ]; then
    case "$RUN_OUT" in
      *"Could not reach"*) pass "unreachable-msg" "an unreachable endpoint is reported, not swallowed" ;;
      *) fail "unreachable-msg" "an unreachable endpoint is reported, not swallowed" "expected a 'Could not reach' message" ;;
    esac
    case "$RUN_OUT" in
      *"config was still updated"*) pass "unreachable-nonfatal" "an unreachable endpoint still leaves the config in place" ;;
      *) fail "unreachable-nonfatal" "an unreachable endpoint still leaves the config in place" "expected the 'config was still updated' reassurance" ;;
    esac
  fi

  # --- S2: existing config, 2-space list (must MERGE, not clobber) ------
  scenario='S2-merge-2space'
  h="$(new_home)"; fixture_2space | seed_yaml "$h"
  before="$(cat "$h/.continue/config.yaml")"
  run_setup "$h"
  assert_eq "exit" "exits 0 when merging into an existing config" 0 "$RUN_EXIT"
  assert_structure "$RUN_CONFIG" --key "$DUMMY_KEY" --expect-count 4 \
      --preserved-name 'Claude Sonnet 4' --preserved-key 'sk-ant-ALREADY-HERE' \
      --expect-top-key 'schema=v1' --expect-top-key 'name=my-config'
  assert_eq "backup-made" "a timestamped backup of the original is written" 1 "$(count_backups "$h")"
  bak="$(ls -1 "$h/.continue/"config.yaml.bak-* 2>/dev/null | head -n1)"
  if [ -n "$bak" ]; then
    assert_eq "backup-content" "the backup is the original file, byte for byte" "$before" "$(cat "$bak")"
  fi
  no_key_leak

  # --- S3: existing config with a ZERO-INDENTED list --------------------
  # Same valid YAML, written in the other ordinary style. This is the
  # scenario that catches the indent-detection defect.
  scenario='S3-merge-0space'
  h="$(new_home)"; fixture_0space | seed_yaml "$h"
  run_setup "$h"
  assert_eq "exit" "exits 0 when merging into a zero-indented list" 0 "$RUN_EXIT"
  assert_structure "$RUN_CONFIG" --key "$DUMMY_KEY" --expect-count 4 \
      --preserved-name 'Claude Sonnet 4' --preserved-key 'sk-ant-ALREADY-HERE'
  no_key_leak

  # --- S4: comment between `models:` and the first item -----------------
  scenario='S4-merge-comment-first'
  h="$(new_home)"; fixture_comment_first | seed_yaml "$h"
  run_setup "$h"
  assert_eq "exit" "exits 0 when a comment precedes the first item" 0 "$RUN_EXIT"
  assert_structure "$RUN_CONFIG" --key "$DUMMY_KEY" --expect-count 4 \
      --preserved-name 'Claude Sonnet 4' --preserved-key 'sk-ant-ALREADY-HERE'

  # --- S5: existing config with no `models:` key at all -----------------
  scenario='S5-no-models-key'
  h="$(new_home)"; fixture_no_models | seed_yaml "$h"
  run_setup "$h"
  assert_eq "exit" "exits 0 and appends a models section" 0 "$RUN_EXIT"
  assert_structure "$RUN_CONFIG" --key "$DUMMY_KEY" --expect-count 3 \
      --expect-top-key 'schema=v1' --expect-top-key 'name=my-config'

  # --- S6: flow-style models list: refuse, do not mangle ----------------
  scenario='S6-flow-style'
  h="$(new_home)"; fixture_flow | seed_yaml "$h"
  cfg="$h/.continue/config.yaml"; s0="$(sha "$cfg")"
  run_setup "$h"
  assert_true "exit" "refuses flow style with a non-zero exit" \
              "$([ "$RUN_EXIT" -ne 0 ] && echo 0 || echo 1)" "exit was $RUN_EXIT"
  assert_eq "untouched" "leaves the file byte-identical" "$s0" "$(sha "$cfg")"
  assert_eq "no-backup" "does not leave a stray backup behind" 0 "$(count_backups "$h")"
  case "$RUN_OUT" in
    *'<YOUR_KEY>'*) pass "handoff" "prints a hand-editable block with a key placeholder" ;;
    *) fail "handoff" "prints a hand-editable block with a key placeholder" "expected the <YOUR_KEY> placeholder" ;;
  esac
  no_key_leak

  # --- S7: two top-level `models:` keys: refuse -------------------------
  scenario='S7-duplicate-models'
  h="$(new_home)"; fixture_duplicate | seed_yaml "$h"
  cfg="$h/.continue/config.yaml"; s0="$(sha "$cfg")"
  run_setup "$h"
  assert_true "exit" "refuses an ambiguous file with a non-zero exit" \
              "$([ "$RUN_EXIT" -ne 0 ] && echo 0 || echo 1)" "exit was $RUN_EXIT"
  assert_eq "untouched" "leaves the file byte-identical" "$s0" "$(sha "$cfg")"
  assert_eq "no-backup" "does not leave a stray backup behind" 0 "$(count_backups "$h")"
  no_key_leak

  # --- S8: legacy config.json only: refuse, do not convert --------------
  scenario='S8-legacy-json'
  h="$(new_home)"; printf '{"models":[{"title":"Old","provider":"anthropic"}]}' | seed_json "$h"
  run_setup "$h"
  assert_true "exit" "refuses a legacy config.json with a non-zero exit" \
              "$([ "$RUN_EXIT" -ne 0 ] && echo 0 || echo 1)" "exit was $RUN_EXIT"
  assert_true "no-yaml-written" "does not create a config.yaml alongside it" \
              "$([ ! -f "$h/.continue/config.yaml" ] && echo 0 || echo 1)" "a config.yaml was created anyway"
  assert_true "json-untouched" "leaves the legacy config.json in place" \
              "$([ -f "$h/.continue/config.json" ] && echo 0 || echo 1)" "the legacy file disappeared"

  # --- S9: re-run over our own output is a no-op ------------------------
  # Students re-run this. A second run must not duplicate the entries.
  scenario='S9-rerun-idempotent'
  h="$(new_home)"
  run_setup "$h"; s0="$(sha "$RUN_CONFIG")"
  run_setup "$h"
  assert_eq "exit" "a second run exits 0" 0 "$RUN_EXIT"
  assert_eq "unchanged" "a second run leaves the file byte-identical" "$s0" "$(sha "$RUN_CONFIG")"
  assert_structure "$RUN_CONFIG" --key "$DUMMY_KEY" --expect-count 3
  assert_eq "no-backup" "a run that changes nothing writes no backup" 0 "$(count_backups "$h")"

  # --- S10: CRLF config (a Windows-edited file shared to a Mac) ---------
  scenario='S10-crlf-existing'
  # awk, not `sed 's/$/\r/'`: BSD sed does not interpret \r in a
  # replacement and would insert a literal 'r', leaving this scenario
  # quietly testing nothing.
  h="$(new_home)"; fixture_2space | awk '{ printf "%s\r\n", $0 }' | seed_yaml "$h"
  run_setup "$h"
  assert_eq "exit" "exits 0 on a CRLF config" 0 "$RUN_EXIT"
  assert_structure "$RUN_CONFIG" --key "$DUMMY_KEY" --expect-count 4 \
      --preserved-name 'Claude Sonnet 4' --preserved-key 'sk-ant-ALREADY-HERE'

  # --- S11: a key with punctuation that is fine in YAML -----------------
  scenario='S11-awkward-key'
  h="$(new_home)"
  run_setup "$h" 'sk-a1b2_c3-d4.e5'
  assert_eq "exit" "exits 0 with a punctuation-heavy key" 0 "$RUN_EXIT"
  assert_structure "$RUN_CONFIG" --key 'sk-a1b2_c3-d4.e5' --expect-count 3

  # --- S13: an existing but EMPTY config.yaml -----------------------------
  # The README's manual path tells students to "find or create config.yaml",
  # so a student who created the file and then ran the script arrives here
  # with a 0-byte file. On any bash before 4.4 -- which includes the 3.2.57
  # that macOS ships as /bin/bash -- expanding "${lines[@]}" on the
  # resulting empty array under `set -u` aborts the script, AFTER the backup
  # has been written and before anything is written back.
  scenario='S13-empty-existing-config'
  h="$(new_home)"; : | seed_yaml "$h"
  run_setup "$h"
  assert_eq "exit" "exits 0 on an existing but empty config.yaml" 0 "$RUN_EXIT"
  assert_structure "$RUN_CONFIG" --key "$DUMMY_KEY" --expect-count 3
  # `printf '%s\n'` with no arguments emits one blank line, so an unguarded
  # array expansion also left a spurious leading blank line here.
  assert_eq "no-leading-blank" "does not leave a spurious blank line at the top" \
            "models:" "$(head -n1 "$RUN_CONFIG")"

  # --- S14: a key containing YAML-significant punctuation -----------------
  # apiKey is written into the file as a YAML scalar, so the quoting of that
  # scalar decides whether the key survives. The two hazards, both SILENT:
  # " #" starts a comment and truncates the key there, and ": " turns the
  # value into a nested mapping. Either produces a valid-looking
  # config.yaml, a wrong key, and a 401 the student cannot diagnose.
  #
  # LiteLLM does not mint keys shaped like this today (sk- plus url-safe
  # base64), so this is defence against a mis-paste or a future key format
  # rather than a live bug -- but it costs two characters to be right.
  scenario='S14-yaml-hostile-key'
  hostile="sk-abc #hash def: ghi 'jkl"
  h="$(new_home)"
  run_setup "$h" "$hostile"
  assert_eq "exit" "exits 0 with a YAML-significant key" 0 "$RUN_EXIT"
  assert_structure "$RUN_CONFIG" --key "$hostile" --expect-count 3

  # --- S15: the key the PORTAL embedded, with no argument at all ----------
  # The keys portal (keyportal/app.py) serves this script with the student's
  # own key substituted into the EMBEDDED_KEY line, so the student runs it
  # with no argument and answers no prompt. Every other scenario in this
  # suite passes the key POSITIONALLY, which means none of them execute the
  # path an actual portal-served run takes.
  #
  # That gap is exactly the kind this suite exists to close: the whole
  # reason the portal serves these files instead of embedding its own copy
  # is so that CI covers what students run. Serving a script through an
  # untested code path would give that up for the one line that matters
  # most.
  scenario='S15-portal-embedded-key'
  h="$(new_home)"
  run_setup_embedded "$h" "$DUMMY_KEY"
  assert_eq "exit" "exits 0 with the key embedded and no argument" 0 "$RUN_EXIT"
  case "$RUN_OUT" in
    *"Paste your local-llm key"*)
      fail "no-prompt" "never prompts when the portal already embedded a key" \
           "the script prompted anyway -- the embedded key did not reach API_KEY" ;;
    *) pass "no-prompt" "never prompts when the portal already embedded a key" ;;
  esac
  no_key_leak
  assert_structure "$RUN_CONFIG" --key "$DUMMY_KEY" --expect-count 3

  # --- S16: a portal-embedded key that is hostile to BOTH quoting layers --
  # The key now passes through TWO different single-quoting rules on its way
  # into config.yaml, and they are NOT the same rule: the portal's shell
  # literal escapes a quote as '\'' , and build_block's YAML scalar escapes
  # it by DOUBLING it. Using either rule in the other's place does not
  # error -- it silently drops or duplicates a character, producing a
  # valid-looking config.yaml with a wrong key and an opaque 401. This is
  # S14's hazard one layer deeper, and only an executed round trip catches
  # it.
  scenario='S16-portal-embedded-hostile-key'
  h="$(new_home)"
  run_setup_embedded "$h" "$hostile"
  assert_eq "exit" "exits 0 with a doubly-hostile embedded key" 0 "$RUN_EXIT"
  assert_structure "$RUN_CONFIG" --key "$hostile" --expect-count 3

  printf '\n%d passed, %d failed.\n' "$pass_count" "$failures"
  [ "$failures" -eq 0 ] || return 1
  return 0
}

# ---------------------------------------------------------------------------
# --mutation-check: prove the suite above actually catches a broken script.
#
# A CI job that passes against a broken script is worse than no job,
# because it manufactures confidence. Each mutation names the assertion it
# MUST trip, and mutations are judged by the failures they ADD on top of
# the unmodified script's own baseline, so a real open defect cannot mask
# one.
# ---------------------------------------------------------------------------

# Mutation definitions.
#
# find/replace bodies are quoted heredocs rather than escaped one-liners,
# so they are the literal text of the script and can be read and checked by
# eye. The anchor must match EXACTLY ONCE -- an ambiguous anchor fails the
# mutation rather than silently patching the wrong site.

mutation_ids() {
  # id <TAB> regex the mutation MUST newly trip
  printf '%s\t%s\n' \
    'M1-collapse-continuation-indent'   '/yaml$' ; printf '%s\t%s\n' \
    'M2-drop-enable-thinking-from-edit' '/thinking-UAMISLocalEdit$' ; printf '%s\t%s\n' \
    'M3-wrong-maxtokens-on-chat'        '/maxtok-UAMISLocalChat$' ; printf '%s\t%s\n' \
    'M4-clobber-existing-entries'       '/preserved-entry$' ; printf '%s\t%s\n' \
    'M5-drop-apply-role-from-edit'      '/roles-UAMISLocalEdit$' ; printf '%s\t%s\n' \
    'M6-unquote-the-apikey'             '^S14-yaml-hostile-key/apikey-' ; printf '%s\t%s\n' \
    'M7-ignore-the-embedded-key'        '^S1[56]-portal-embedded'
}

mutation_why() {
  case "$1" in
    M1-*) echo 'Structural break: continuation keys line up with the "- " dash instead of being indented under it, so the block is no longer valid YAML.' ;;
    M2-*) echo 'Subtle break: the Edit entry silently loses enable_thinking: false, so that role truncates mid-reasoning. The file is still perfectly valid YAML.' ;;
    M3-*) echo 'Value regression: the Chat cap drops from 4000 to 2000, which truncates good answers. Valid YAML, right shape, wrong number.' ;;
    M4-*) echo "Data loss: the merge stops emitting the lines after the models: line, so a student's existing provider is silently deleted. Valid YAML, our entries all correct." ;;
    M5-*) echo 'Role regression: the Edit entry stops declaring apply, so Continue offers no model for Apply. Valid YAML.' ;;
    M6-*) echo 'Silent truncation: the apiKey scalar goes back to being unquoted, so a key containing " #" is cut off at the comment marker. Valid YAML, wrong key, opaque 401.' ;;
    M7-*) echo "Portal regression: API_KEY stops falling back to EMBEDDED_KEY, so a portal-served script ignores the key the portal put in it and prompts the student instead -- the exact step the portal exists to remove." ;;
  esac
}

mutation_find() {
  case "$1" in
    M1-*) cat <<'XEOF'
  cont_indent="${dash_indent}  "
XEOF
    ;;
    M2-*) cat <<'XEOF'
  printf '%s  maxTokens: 400\n' "${cont_indent}"
  printf '%srequestOptions:\n' "${cont_indent}"
  printf '%s  extraBodyProperties:\n' "${cont_indent}"
  printf '%s    chat_template_kwargs:\n' "${cont_indent}"
  printf '%s      enable_thinking: false\n' "${cont_indent}"
XEOF
    ;;
    M3-*) cat <<'XEOF'
  printf '%s  maxTokens: 4000\n' "${cont_indent}"
XEOF
    ;;
    M4-*) cat <<'XEOF'
        if [ "$((models_line_idx + 1))" -lt "${#lines[@]}" ]; then
          printf '%s\n' "${lines[@]:$((models_line_idx + 1))}"
        fi
XEOF
    ;;
    M5-*) cat <<'XEOF'
  printf '%sroles: [edit, apply]\n' "${cont_indent}"
XEOF
    ;;
    M6-*) cat <<'XEOF'
  yaml_key="'$(printf '%s' "${key_to_print}" | sed "s/'/''/g")'"
XEOF
    ;;
    M7-*) cat <<'XEOF'
API_KEY="${1:-${EMBEDDED_KEY}}"
XEOF
    ;;
  esac
}

mutation_repl() {
  case "$1" in
    M1-*) cat <<'XEOF'
  cont_indent="${dash_indent}"
XEOF
    ;;
    M2-*) cat <<'XEOF'
  printf '%s  maxTokens: 400\n' "${cont_indent}"
XEOF
    ;;
    M3-*) cat <<'XEOF'
  printf '%s  maxTokens: 2000\n' "${cont_indent}"
XEOF
    ;;
    M4-*) cat <<'XEOF'
        :
XEOF
    ;;
    M5-*) cat <<'XEOF'
  printf '%sroles: [edit]\n' "${cont_indent}"
XEOF
    ;;
    M6-*) cat <<'XEOF'
  yaml_key="${key_to_print}"
XEOF
    ;;
    M7-*) cat <<'XEOF'
API_KEY="${1:-}"
XEOF
    ;;
  esac
}

# Collects the FAILIDs the suite emits against a given script.
fail_ids_for() { # $1 = script path
  set +e
  bash "$0" --script "$1" 2>&1 | sed -n 's/^FAILID: //p' | sort -u
  set -e
}

run_mutation_check() {
  echo "=== Mutation check: does the suite actually catch a broken script? ==="
  echo
  local mutwork; mutwork="$(mktemp -d "${WORKROOT}/mut.XXXXXX")"

  echo "--- baseline: the suite against the UNMODIFIED script ---"
  local baseline; baseline="$(fail_ids_for "$SCRIPT_UNDER_TEST")"
  if [ -z "$baseline" ]; then
    echo "baseline: suite is GREEN (no FAILIDs)."
  else
    printf 'baseline: suite is RED with %d pre-existing failure(s):\n' "$(printf '%s\n' "$baseline" | wc -l)"
    printf '%s\n' "$baseline" | sed 's/^/    /'
    echo "(Mutations are judged by the failures they ADD on top of this baseline,"
    echo " so a real open defect does not mask a mutation.)"
  fi
  echo

  local mut_fail=0 total=0
  while IFS="$(printf '\t')" read -r id expect; do
    [ -n "$id" ] || continue
    total=$((total + 1))
    printf -- '--- %s ---\n' "$id"
    printf '    %s\n' "$(mutation_why "$id")"

    local mutant="${mutwork}/${id}.sh"
    mutation_find "$id" > "${mutwork}/find.txt"
    mutation_repl "$id" > "${mutwork}/repl.txt"
    if ! "$PYTHON" - "$SCRIPT_UNDER_TEST" "$mutant" \
           "${mutwork}/find.txt" "${mutwork}/repl.txt" <<'PY'
import sys
src, dst, findf, replf = sys.argv[1:5]
s = open(src).read()
find = open(findf).read()
repl = open(replf).read()
n = s.count(find)
if n != 1:
    sys.stderr.write("anchor matched %d times (need exactly 1)\n" % n)
    sys.exit(1)
open(dst, "w").write(s.replace(find, repl))
PY
    then
      printf 'MUTANT-ERROR: %s -- anchor not found (or ambiguous); the mutation could not be applied.\n\n' "$id"
      mut_fail=$((mut_fail + 1))
      continue
    fi

    local ids added hit
    ids="$(fail_ids_for "$mutant")"
    added="$(comm -13 <(printf '%s\n' "$baseline") <(printf '%s\n' "$ids") | sed '/^$/d')"
    hit="$(printf '%s\n' "$added" | grep -E "$expect" || true)"

    if [ -z "$ids" ]; then
      printf 'MUTANT-SURVIVED: %s -- the suite PASSED against the broken script. The assertions have a gap.\n' "$id"
      mut_fail=$((mut_fail + 1))
    elif [ -z "$added" ]; then
      printf 'MUTANT-SURVIVED: %s -- the suite failed, but only with the baseline failures, so this mutation was not detected.\n' "$id"
      mut_fail=$((mut_fail + 1))
    elif [ -z "$hit" ]; then
      printf 'MUTANT-MISDETECTED: %s -- failures were added, but none matching the expected assertion %s.\n' "$id" "$expect"
      printf '    added: %s\n' "$(printf '%s\n' "$added" | tr '\n' ',' | sed 's/,$//')"
      mut_fail=$((mut_fail + 1))
    else
      printf 'MUTANT-CAUGHT: %s -- newly tripped: %s\n' "$id" "$(printf '%s\n' "$hit" | tr '\n' ',' | sed 's/,$//')"
    fi
    echo
  done <<< "$(mutation_ids)"

  printf '=== Mutation check: %d/%d mutations caught ===\n' "$((total - mut_fail))" "$total"
  [ "$mut_fail" -eq 0 ] || return 1
  return 0
}

if [ "$MUTATION_CHECK" -eq 1 ]; then
  run_mutation_check
else
  run_suite
fi
