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
# Requires: bash 4+, python3 with PyYAML.

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
sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

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
  h="$(new_home)"; fixture_2space | sed 's/$/\r/' | seed_yaml "$h"
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

# id | why | find | replace | expected-failid-regex   (TAB separated)
mutation_specs() {
  printf '%s\n' \
"M1-collapse-continuation-indent	Structural break: continuation keys line up with the \"- \" dash instead of being indented under it, so the block is no longer valid YAML.	cont_indent=\"\${dash_indent}  \"	cont_indent=\"\${dash_indent}\"	/yaml\$" \
"M2-drop-enable-thinking-from-edit	Subtle break: the Edit entry silently loses enable_thinking: false, so that role truncates mid-reasoning. The file is still perfectly valid YAML.	  printf '%s  maxTokens: 400\\\\n' \"\${cont_indent}\"\n  printf '%srequestOptions:\\\\n' \"\${cont_indent}\"\n  printf '%s  extraBodyProperties:\\\\n' \"\${cont_indent}\"\n  printf '%s    chat_template_kwargs:\\\\n' \"\${cont_indent}\"\n  printf '%s      enable_thinking: false\\\\n' \"\${cont_indent}\"	  printf '%s  maxTokens: 400\\\\n' \"\${cont_indent}\"	/thinking-UAMISLocalEdit\$" \
"M3-wrong-maxtokens-on-chat	Value regression: the Chat cap drops from 4000 to 2000, which truncates good answers. Valid YAML, right shape, wrong number.	  printf '%s  maxTokens: 4000\\\\n' \"\${cont_indent}\"	  printf '%s  maxTokens: 2000\\\\n' \"\${cont_indent}\"	/maxtok-UAMISLocalChat\$" \
"M4-clobber-existing-entries	Data loss: the merge stops emitting the lines after the models: line, so a student's existing provider is silently deleted. Valid YAML, our entries all correct.	        if [ \"\$((models_line_idx + 1))\" -lt \"\${#lines[@]}\" ]; then\n          printf '%s\\\\n' \"\${lines[@]:\$((models_line_idx + 1))}\"\n        fi	        :	/preserved-entry\$" \
"M5-drop-apply-role-from-edit	Role regression: the Edit entry stops declaring apply, so Continue offers no model for Apply. Valid YAML.	  printf '%sroles: [edit, apply]\\\\n' \"\${cont_indent}\"	  printf '%sroles: [edit]\\\\n' \"\${cont_indent}\"	/roles-UAMISLocalEdit\$"
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
  while IFS="$(printf '\t')" read -r id why find repl expect; do
    [ -n "$id" ] || continue
    total=$((total + 1))
    printf -- '--- %s ---\n' "$id"
    printf '    %s\n' "$why"

    local mutant="${mutwork}/${id}.sh"
    # printf %b so the \n escapes in the spec become real newlines for
    # multi-line anchors.
    if ! "$PYTHON" - "$SCRIPT_UNDER_TEST" "$mutant" \
           "$(printf '%b' "$find")" "$(printf '%b' "$repl")" <<'PY'
import sys
src, dst, find, repl = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(src).read()
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
      printf '    added: %s\n' "$(printf '%s\n' "$added" | paste -sd, -)"
      mut_fail=$((mut_fail + 1))
    else
      printf 'MUTANT-CAUGHT: %s -- newly tripped: %s\n' "$id" "$(printf '%s\n' "$hit" | paste -sd, -)"
    fi
    echo
  done <<< "$(mutation_specs)"

  printf '=== Mutation check: %d/%d mutations caught ===\n' "$((total - mut_fail))" "$total"
  [ "$mut_fail" -eq 0 ] || return 1
  return 0
}

if [ "$MUTATION_CHECK" -eq 1 ]; then
  run_mutation_check
else
  run_suite
fi
