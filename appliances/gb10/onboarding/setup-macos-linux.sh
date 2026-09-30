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
  #
  # Three separate model entries, not one, because Continue's
  # defaultCompletionOptions/requestOptions apply per MODEL block, not
  # per role within a shared block — there is no way to give chat, edit,
  # apply, and agent different maxTokens values on a single entry (see
  # https://docs.continue.dev/reference, 2026-09-30). All three point at
  # the exact same backend model; only the role assignment and
  # completion options differ. Continue only offers each role a choice
  # among the models that declare it, so a student sees one candidate
  # per role, not three confusing "chat" options.
  #
  # Per-role token caps, measured against the real endpoint on this box
  # (DFlash2 config), 2026-09-30 — see the team's own measurement
  # methodology if you need to re-derive these after a model change.
  # This model is a REASONING model: it emits a hidden "thinking" block
  # BEFORE its real answer, and that thinking consumes the SAME token
  # budget as the answer (measured: a short code-completion prompt used
  # 99 of 120 total tokens on thinking alone, with reasoning left on).
  # A small maxTokens cap on a role that still has thinking enabled
  # truncates the model mid-thought, before it ever writes the real
  # answer — worse than slow, actively broken. So every role below turns
  # thinking OFF (chat_template_kwargs.enable_thinking: false).
  #
  # 2026-09-30 correction: thinking used to stay ON for chat/agent,
  # reasoning that a good explanation or a good multi-file plan is
  # worse to truncate than to wait for. That was inheriting the model's
  # default and calling it a decision. The single-turn benchmark shows
  # no quality difference worth the wait: off scored 41/54 versus
  # xhigh's 39/54 (within noise), and low tracked off. Off is now the
  # evidence-based default for every role; turning it back ON for a
  # specific role is what would need new evidence, not the other way
  # around.
  dash_indent="$1"
  key_to_print="${2:-${API_KEY}}"
  cont_indent="${dash_indent}  "

  # Write the key as a SINGLE-QUOTED YAML scalar. Unquoted, a key
  # containing " #" is truncated at the comment marker and one containing
  # ": " breaks the mapping -- both SILENTLY, producing a valid-looking
  # config.yaml, a wrong key, and a 401 the student has no way to
  # diagnose. LiteLLM does not mint keys shaped like that today (sk- plus
  # url-safe base64), so this is defence against a mis-paste or a future
  # key format, and it costs two characters.
  #
  # Single quotes, not double: a single-quoted YAML scalar interprets no
  # escape sequences, so a backslash in a key stays a backslash. The only
  # thing needing escaping is a literal single quote, which is written by
  # doubling it -- hence the sed.
  #
  # Matches setup-windows.ps1, which had and has the same defect and fix.
  # Pinned by test-setup-macos-linux.sh, scenario S14-yaml-hostile-key.
  yaml_key="'$(printf '%s' "${key_to_print}" | sed "s/'/''/g")'"

  printf '%s- name: UA MIS Local (Chat)\n' "${dash_indent}"
  printf '%sprovider: openai  # "openai" here means the OpenAI-compatible API protocol,\n' "${cont_indent}"
  printf '%s                  # NOT the OpenAI company. This talks only to our own\n' "${cont_indent}"
  printf '%s                  # local box, never to openai.com.\n' "${cont_indent}"
  printf '%smodel: %s\n' "${cont_indent}" "${MODEL_ID}"
  printf '%sapiBase: %s\n' "${cont_indent}" "${MODEL_ENDPOINT}"
  printf '%sapiKey: %s\n' "${cont_indent}" "${yaml_key}"
  printf '%sroles: [chat]\n' "${cont_indent}"
  printf '%s# Generous on purpose: measured a real MIS 321-level question\n' "${cont_indent}"
  printf '%s# (write a C# method with a parameterized query) at ~1900\n' "${cont_indent}"
  printf '%s# tokens end to end, a good and correct answer, finishing on\n' "${cont_indent}"
  printf '%s# its own well under this cap. A beginner question runs much\n' "${cont_indent}"
  printf '%s# shorter but deserves the same room. Do not lower this to\n' "${cont_indent}"
  printf '%s# "speed things up" -- it truncates good answers, not slow ones.\n' "${cont_indent}"
  printf '%sdefaultCompletionOptions:\n' "${cont_indent}"
  printf '%s  maxTokens: 4000\n' "${cont_indent}"
  printf '%srequestOptions:\n' "${cont_indent}"
  printf '%s  extraBodyProperties:\n' "${cont_indent}"
  printf '%s    chat_template_kwargs:\n' "${cont_indent}"
  printf '%s      enable_thinking: false\n' "${cont_indent}"
  printf '\n'

  printf '%s- name: UA MIS Local (Edit)\n' "${dash_indent}"
  printf '%sprovider: openai\n' "${cont_indent}"
  printf '%smodel: %s\n' "${cont_indent}" "${MODEL_ID}"
  printf '%sapiBase: %s\n' "${cont_indent}" "${MODEL_ENDPOINT}"
  printf '%sapiKey: %s\n' "${cont_indent}" "${yaml_key}"
  printf '%sroles: [edit, apply]\n' "${cont_indent}"
  printf '%s# Small and fast on purpose: a changed line or block, not a\n' "${cont_indent}"
  printf '%s# tutorial. Thinking is turned OFF for this role too (see\n' "${cont_indent}"
  printf '%s# requestOptions below) specifically so a small maxTokens cap\n' "${cont_indent}"
  printf '%s# lands on the actual rewritten code, not on the model'"'"'s\n' "${cont_indent}"
  printf '%s# hidden reasoning about the code. Measured real edit/apply\n' "${cont_indent}"
  printf '%s# tasks (rename variables, add error handling) at 37-90\n' "${cont_indent}"
  printf '%s# tokens with thinking off; 400 leaves real headroom for a\n' "${cont_indent}"
  printf '%s# larger function.\n' "${cont_indent}"
  printf '%sdefaultCompletionOptions:\n' "${cont_indent}"
  printf '%s  maxTokens: 400\n' "${cont_indent}"
  printf '%srequestOptions:\n' "${cont_indent}"
  printf '%s  extraBodyProperties:\n' "${cont_indent}"
  printf '%s    chat_template_kwargs:\n' "${cont_indent}"
  printf '%s      enable_thinking: false\n' "${cont_indent}"
  printf '\n'

  printf '%s- name: UA MIS Local (Agent)\n' "${dash_indent}"
  printf '%sprovider: openai\n' "${cont_indent}"
  printf '%smodel: %s\n' "${cont_indent}" "${MODEL_ID}"
  printf '%sapiBase: %s\n' "${cont_indent}" "${MODEL_ENDPOINT}"
  printf '%sapiKey: %s\n' "${cont_indent}" "${yaml_key}"
  printf '%sroles: [agent]\n' "${cont_indent}"
  printf '%s# Largest cap of the four: multi-step, tool-calling agent work\n' "${cont_indent}"
  printf '%s# (MIS 421/521) legitimately needs the most room. Measured a\n' "${cont_indent}"
  printf '%s# real multi-file scaffold task at ~3700 tokens, finishing on\n' "${cont_indent}"
  printf '%s# its own well under this cap. 8000 sits just under this\n' "${cont_indent}"
  printf '%s# deployment'"'"'s own hard backend ceiling (8192).\n' "${cont_indent}"
  printf '%sdefaultCompletionOptions:\n' "${cont_indent}"
  printf '%s  maxTokens: 8000\n' "${cont_indent}"
  printf '%srequestOptions:\n' "${cont_indent}"
  printf '%s  extraBodyProperties:\n' "${cont_indent}"
  printf '%s    chat_template_kwargs:\n' "${cont_indent}"
  printf '%s      enable_thinking: false\n' "${cont_indent}"
  printf '%s# Deliberately no "autocomplete" role on any of the three\n' "${cont_indent}"
  printf '%s# entries above: GitHub Copilot Free already handles inline\n' "${cont_indent}"
  printf '%s# completions well, and this shared GPU box should not spend\n' "${cont_indent}"
  printf '%s# capacity on every keystroke. Please do not add it back in.\n' "${cont_indent}"
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
      #
      # The count guard is not decoration. macOS ships bash 3.2.57 as
      # /bin/bash and the README tells students to run `bash
      # setup-macos-linux.sh`, so 3.2 is the interpreter for most of the
      # people this script exists for. Before bash 4.4, expanding
      # "${arr[@]}" on an EMPTY array under `set -u` is an error --
      # "lines[@]: unbound variable" -- which would abort the script here,
      # after the backup but before writing anything.
      #
      # That path is reachable: an existing but EMPTY ~/.continue/config.yaml
      # leaves `lines` empty, and this README tells students to "find or
      # create config.yaml" in the manual instructions, so a student who
      # created the file and then ran the script lands exactly here.
      #
      # The guard also fixes a real bug on modern bash: `printf '%s\n'`
      # with no arguments prints one empty line, so an empty config.yaml
      # used to gain a spurious blank line.
      #
      # The two slice expansions further down cannot be empty --
      # models_line_idx is >= 0 on that branch, so the slice holds at
      # least the `models:` line itself -- so they need no guard.
      {
        if [ "${#lines[@]}" -gt 0 ]; then
          printf '%s\n' "${lines[@]}"
          # Blank line separating the student's existing content from the
          # section being appended. Inside the guard on purpose: with
          # nothing to separate from, an empty config.yaml would otherwise
          # gain a leading blank line.
          printf '\n'
        fi
        printf 'models:\n'
        build_block "  "
      } > "${CONFIG_YAML}" || fail "Could not write ${CONFIG_YAML}"
      log "No existing 'models:' section was found, so a new one was added"
      log "at the end of ${CONFIG_YAML}."
    else
      # Detect the indentation of the first existing sequence item, if any,
      # by scanning forward from the models: line for the next non-blank,
      # non-comment line that is still part of this list.
      #
      # The capture group is [[:space:]]*, NOT [[:space:]]+: a sequence
      # item under a mapping key may legitimately sit at ZERO
      # indentation --
      #
      #   models:
      #   - name: Something
      #
      # -- which is ordinary valid YAML and is what `yq` emits by
      # default. With + that line did not match, item_indent kept its
      # "  " default, and our entries went in at 2-space indent directly
      # above the student's 0-space ones. A YAML block sequence cannot
      # mix indentation, so the merged file DID NOT PARSE -- and this
      # script still printed "Added the 'UA MIS Local' model..." and
      # exited 0. The student lost their whole Continue config, not just
      # our model, and had no reason to go looking for the .bak file.
      # Silent, common, catastrophic. The Windows script had the
      # identical defect (\s+); both were found on 2026-09-30 by
      # executing them for the first time.
      # Pinned by test-setup-macos-linux.sh, scenario S3-merge-0space.
      item_indent="  "  # default: 2 spaces
      j=$((models_line_idx + 1))
      while [ "${j}" -lt "${#lines[@]}" ]; do
        cl="${lines[$j]}"
        if [ -z "${cl}" ] || [[ "${cl}" =~ ^[[:space:]]*#.*$ ]]; then
          j=$((j + 1))
          continue
        fi
        if [[ "${cl}" =~ ^([[:space:]]*)-[[:space:]] ]]; then
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
