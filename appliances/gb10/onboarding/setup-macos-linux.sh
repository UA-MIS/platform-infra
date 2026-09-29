#!/usr/bin/env bash
#
# UA MIS Local LLM — Continue (VS Code) setup for macOS and Linux.
#
# What this does:
#   1. Finds your Continue config (~/.continue/config.yaml).
#   2. Backs it up (never overwrites it).
#   3. Adds the "UA MIS Local" model entry, without touching any other
#      model you already have configured.
#   4. Checks your key against the local LLM endpoint and tells you
#      plainly what to do next.
#
# Usage:
#   bash setup-macos-linux.sh [YOUR_KEY]
#
# If you don't pass a key, the script will prompt for one (hidden input).
#
# This script is intentionally conservative: if anything about your
# existing setup looks unusual, it stops and tells you what to do by
# hand rather than guessing. Losing your existing Continue config would
# be worse than this script doing nothing.

set -u

MODEL_ENDPOINT="https://local-llm.uamishub.com/v1"
MODEL_ID="qwen3.8-27b"
ADMIN="<ADMIN>"

CONTINUE_DIR="${HOME}/.continue"
CONFIG_YAML="${CONTINUE_DIR}/config.yaml"
CONFIG_JSON="${CONTINUE_DIR}/config.json"

log()  { printf '%s\n' "$*"; }
hr()   { printf '%s\n' "----------------------------------------------------------------"; }
fail() { printf '\n%s\n' "ERROR: $*" >&2; exit 1; }

hr
log "UA MIS Local LLM — Continue setup"
hr

# ---------------------------------------------------------------------------
# 0. Get the API key first (before we touch any files), so a mistyped key
#    doesn't leave a half-finished edit behind.
# ---------------------------------------------------------------------------

API_KEY="${1:-}"

if [ -z "${API_KEY}" ]; then
  if [ -r /dev/tty ]; then
    # Read from the controlling terminal explicitly. This matters if this
    # script is being run as `curl ... | bash` — in that case normal stdin
    # is the script itself, not your keyboard, so a plain `read` would not
    # see what you type.
    printf '%s' "Paste your local-llm key (input is hidden), then press Enter: " > /dev/tty
    read -rs API_KEY < /dev/tty
    printf '\n' > /dev/tty
  else
    fail "No terminal available to prompt for a key. Re-run as:
  bash setup-macos-linux.sh YOUR_KEY_HERE"
  fi
fi

if [ -z "${API_KEY}" ]; then
  fail "No key entered. Nothing was changed. Re-run and paste your key when prompted."
fi

case "${API_KEY}" in
  sk-*) : ;;
  *)
    log "NOTE: that doesn't look like the usual key format (expected it to"
    log "start with the two characters 's' 'k' followed by a dash)."
    log "Continuing anyway — if the verification step below fails, double-check what you pasted."
    ;;
esac

# ---------------------------------------------------------------------------
# 1. Legacy config.json detection — do not attempt to convert it.
# ---------------------------------------------------------------------------

if [ -f "${CONFIG_JSON}" ] && [ ! -f "${CONFIG_YAML}" ]; then
  hr
  log "Your Continue extension is using the OLD config format (config.json)."
  log "This script only edits the newer config.yaml format, and converting"
  log "config.json automatically risks breaking your existing setup, so"
  log "it will not attempt that."
  log ""
  log "What to do:"
  log "  1. In VS Code, go to Extensions, find 'Continue', and update it."
  log "  2. Restart VS Code. Continue will migrate you to config.yaml."
  log "  3. Re-run this script."
  hr
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Build the model block we want to add, matching whatever indentation
#    the existing file already uses (YAML sequence items must all share
#    the same indentation, so we detect it rather than assume 2 spaces).
# ---------------------------------------------------------------------------

build_block() {
  # $1 = indentation (spaces) before the "-" of a sequence item.
  # $2 = apiKey value to print. Defaults to the real key (used when we are
  #      about to write the file ourselves). Callers that are printing this
  #      block back to the terminal for the user to paste by hand MUST pass
  #      a placeholder here instead — we never echo the real key back.
  dash_indent="$1"
  key_to_print="${2:-${API_KEY}}"
  cont_indent="${dash_indent}  "
  printf '%s- name: UA MIS Local\n' "${dash_indent}"
  printf '%sprovider: openai  # "openai" here means the OpenAI-compatible API protocol,\n' "${cont_indent}"
  printf '%s                  # NOT the OpenAI company. This talks only to our own\n' "${cont_indent}"
  printf '%s                  # local box, never to openai.com.\n' "${cont_indent}"
  printf '%smodel: %s\n' "${cont_indent}" "${MODEL_ID}"
  printf '%sapiBase: %s\n' "${cont_indent}" "${MODEL_ENDPOINT}"
  printf '%sapiKey: %s\n' "${cont_indent}" "${key_to_print}"
  printf '%sroles: [chat, edit, apply]\n' "${cont_indent}"
  printf '%s# Deliberately no "autocomplete" role here on purpose: GitHub Copilot\n' "${cont_indent}"
  printf '%s# Free already handles inline completions well, and this shared GPU\n' "${cont_indent}"
  printf '%s# box should not spend capacity on every keystroke. Please do not add\n' "${cont_indent}"
  printf '%s# it back in.\n' "${cont_indent}"
}

# ---------------------------------------------------------------------------
# 3. Create fresh, or merge into existing, config.yaml.
# ---------------------------------------------------------------------------

mkdir -p "${CONTINUE_DIR}" || fail "Could not create ${CONTINUE_DIR}"

if [ ! -f "${CONFIG_YAML}" ]; then
  hr
  log "No existing Continue config found. Creating a new one at:"
  log "  ${CONFIG_YAML}"
  hr
  {
    printf 'models:\n'
    build_block "  "
  } > "${CONFIG_YAML}" || fail "Could not write ${CONFIG_YAML}"
  chmod 600 "${CONFIG_YAML}" 2>/dev/null || true
  log "Done writing ${CONFIG_YAML}."
else
  if grep -qi 'local-llm\.uamishub\.com' "${CONFIG_YAML}" 2>/dev/null; then
    hr
    log "This model already appears to be configured in:"
    log "  ${CONFIG_YAML}"
    log "(found a reference to local-llm.uamishub.com already)."
    log "Skipping the file edit so we don't create a duplicate entry."
    log "If you want to update the key, edit that file's apiKey line by hand,"
    log "or delete the existing 'UA MIS Local' block and re-run this script."
    hr
  else
    # Read the file into an array, preserving lines exactly.
    lines=()
    while IFS= read -r line || [ -n "${line}" ]; do
      lines+=("${line}")
    done < "${CONFIG_YAML}"

    models_line_idx=-1     # 0-based index into `lines` of the "models:" line
    models_line_count=0
    flow_style=0

    i=0
    while [ "${i}" -lt "${#lines[@]}" ]; do
      l="${lines[$i]}"
      if [[ "${l}" =~ ^models:[[:space:]]*(#.*)?$ ]]; then
        models_line_idx="${i}"
        models_line_count=$((models_line_count + 1))
      elif [[ "${l}" =~ ^models:[[:space:]]*\[ ]]; then
        flow_style=1
        models_line_count=$((models_line_count + 1))
      fi
      i=$((i + 1))
    done

    if [ "${models_line_count}" -gt 1 ]; then
      fail "Found more than one top-level 'models:' key in ${CONFIG_YAML} —
this file looks unusual and I don't want to guess. Please add this block
by hand under your existing 'models:' list instead:

$(build_block "  " "<YOUR_KEY>")

Replace <YOUR_KEY> above with the key you just entered.

(A backup was NOT needed since nothing was changed.)"
    fi

    if [ "${flow_style}" -eq 1 ]; then
      fail "Your ${CONFIG_YAML} defines 'models:' in inline/flow style
(e.g. 'models: [ ... ]') rather than the usual multi-line list. This
script only edits the multi-line style safely. Please add this entry
to your models list by hand:

$(build_block "  " "<YOUR_KEY>")

Replace <YOUR_KEY> above with the key you just entered.

(Nothing was changed.)"
    fi

    # Backup now, right before we actually write anything.
    backup_path="${CONFIG_YAML}.bak-$(date +%Y%m%d-%H%M%S)"
    cp "${CONFIG_YAML}" "${backup_path}" || fail "Could not back up ${CONFIG_YAML}"
    log "Backed up your existing config to:"
    log "  ${backup_path}"

    if [ "${models_line_idx}" -eq -1 ]; then
      # No top-level "models:" key at all — append a new section.
      {
        printf '%s\n' "${lines[@]}"
        printf '\nmodels:\n'
        build_block "  "
      } > "${CONFIG_YAML}" || fail "Could not write ${CONFIG_YAML}"
      log "No existing 'models:' section was found, so a new one was added"
      log "at the end of ${CONFIG_YAML}."
    else
      # Detect the indentation of the first existing sequence item, if any,
      # by scanning forward from the models: line for the next non-blank,
      # non-comment line that is still part of this list (i.e. indented).
      item_indent="  "  # default: 2 spaces
      j=$((models_line_idx + 1))
      while [ "${j}" -lt "${#lines[@]}" ]; do
        cl="${lines[$j]}"
        if [ -z "${cl}" ] || [[ "${cl}" =~ ^[[:space:]]*#.*$ ]]; then
          j=$((j + 1))
          continue
        fi
        if [[ "${cl}" =~ ^([[:space:]]+)-[[:space:]] ]]; then
          item_indent="${BASH_REMATCH[1]}"
        fi
        break
      done

      {
        if [ "${models_line_idx}" -gt 0 ]; then
          printf '%s\n' "${lines[@]:0:$((models_line_idx + 1))}"
        else
          printf '%s\n' "${lines[0]}"
        fi
        build_block "${item_indent}"
        if [ "$((models_line_idx + 1))" -lt "${#lines[@]}" ]; then
          printf '%s\n' "${lines[@]:$((models_line_idx + 1))}"
        fi
      } > "${CONFIG_YAML}" || fail "Could not write ${CONFIG_YAML}"
      log "Added the 'UA MIS Local' model to your existing 'models:' list in:"
      log "  ${CONFIG_YAML}"
    fi
    chmod 600 "${CONFIG_YAML}" 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# 4. Verify the key against the real endpoint.
# ---------------------------------------------------------------------------

hr
log "Checking your key against ${MODEL_ENDPOINT}/models ..."
hr

curl_err_file="$(mktemp 2>/dev/null || printf '/tmp/gb10-onboard-err-%s' "$$")"
raw="$(curl -sS -m 20 -w $'\n''HTTPSTATUS:%{http_code}' \
  -H "Authorization: Bearer ${API_KEY}" \
  "${MODEL_ENDPOINT}/models" 2>"${curl_err_file}")"
curl_exit=$?
curl_err="$(cat "${curl_err_file}" 2>/dev/null)"
rm -f "${curl_err_file}" 2>/dev/null || true

if [ "${curl_exit}" -ne 0 ]; then
  log "Could not reach ${MODEL_ENDPOINT} (network error)."
  [ -n "${curl_err}" ] && log "Details: ${curl_err}"
  log ""
  log "The service may be down, or you may not have network access to it."
  log "Contact ${ADMIN} if this keeps happening."
  log ""
  log "Your Continue config was still updated — once the service is reachable,"
  log "restart VS Code and try the Continue sidebar again."
  exit 0
fi

http_code="$(printf '%s' "${raw}" | sed -n 's/^HTTPSTATUS://p' | tail -n1)"
body="$(printf '%s' "${raw}" | sed '$d')"

case "${http_code}" in
  200)
    log "Your key works."
    log "Restart VS Code and open the Continue sidebar — you should see"
    log "'UA MIS Local' in the model list."
    ;;
  401)
    log "Your key was rejected (HTTP 401)."
    log "Double-check you pasted the whole key, with no extra spaces or"
    log "missing characters. It should start with 's' 'k' followed by a dash."
    log "Re-run this script with the correct key if needed."
    ;;
  403)
    log "Your key is issued but not yet activated (HTTP 403)."
    log "This is the normal state for a brand-new key — nobody gets model"
    log "access automatically. Ask ${ADMIN} to add you to a course team,"
    log "then just restart VS Code and try again — no need to re-run this"
    log "script or get a new key."
    ;;
  *)
    if printf '%s' "${body}" | grep -qi 'team\|model access\|not.*allowed\|not.*permitted'; then
      log "Your key is issued but not yet activated (HTTP ${http_code})."
      log "This is the normal state for a brand-new key — nobody gets model"
      log "access automatically. Ask ${ADMIN} to add you to a course team,"
      log "then just restart VS Code and try again — no need to re-run this"
      log "script or get a new key."
    else
      log "Got an unexpected response (HTTP ${http_code})."
      [ -n "${body}" ] && log "Response: ${body}"
      log ""
      log "The service may be down. Contact ${ADMIN} if this persists."
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# 5. Best-effort: open the config in VS Code so you can see it.
#    Never fatal — this whole section is a courtesy, not a requirement.
# ---------------------------------------------------------------------------

hr
CODE_CMD=""
if command -v code >/dev/null 2>&1; then
  CODE_CMD="code"
elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && \
     [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE_CMD="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
fi

if [ -n "${CODE_CMD}" ]; then
  "${CODE_CMD}" "${CONFIG_YAML}" >/dev/null 2>&1 || true
  log "Opened ${CONFIG_YAML} in VS Code so you can double-check it."
else
  log "(Could not find the 'code' command, so I couldn't auto-open the"
  log "config file for you — this is just a convenience and does not"
  log "affect whether the setup above worked.)"
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    log ""
    log "If you'd like the 'code' command available in your terminal:"
    log "  1. Open VS Code."
    log "  2. Press Cmd+Shift+P to open the Command Palette."
    log "  3. Type: Shell Command: Install 'code' command in PATH"
    log "  4. Press Enter."
  fi
fi

hr
log "Done. Restart VS Code, then open the Continue sidebar."
hr
