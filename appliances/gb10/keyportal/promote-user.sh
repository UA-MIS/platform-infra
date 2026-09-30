#!/usr/bin/env bash
# gb10 key portal: promote a user off the `pending` team (D11).
#
# This is the ENTIRE admin runbook for "student/faculty X should now have
# access." One command:
#
#   cd appliances/gb10
#   set -a; source .env; set +a
#   ./keyportal/promote-user.sh someone@crimson.ua.edu students
#
# What it does, and why it's two LiteLLM calls instead of one:
#
#   1. POST /key/update {"key": ..., "user_id": null}
#      Clears any legacy user_id binding on the key. This is a no-op
#      (harmless, always succeeds) for any key issued by the CURRENT
#      keyportal/app.py, which never sets user_id in the first place
#      (see issue_key()'s docstring for the full postmortem). It only
#      does real work for the small number of keys issued before the
#      2026-09-29 fix, which DO have user_id set to the visitor's email
#      -- and that binding is exactly what makes step 2 fail with
#      `User=<email> is not a member of the team=<id>`, because no
#      LiteLLM User/team-membership row exists for that literal string
#      and none can be made to exist that matches it. Clearing user_id
#      sidesteps the check entirely rather than trying to satisfy it.
#
#   2. POST /key/update {"key": ..., "team_id": <target>}
#      The actual promotion. No key reissue -- the student's existing
#      key starts working immediately, exactly as D11 promises.
#
# Both calls are idempotent -- safe to re-run if step 2 ever fails
# partway (e.g. a bad team name) without side effects from step 1
# already having applied.
#
# Verified against this deployment's real LiteLLM 1.103.0, 2026-09-29:
# both calls together take under a second, and the SAME key string that
# was 429-blocked in `pending` starts returning normal completions with
# no client-side change at all.
set -euo pipefail

EMAIL="${1:?usage: promote-user.sh <email> <students|faculty>}"
TARGET="${2:?usage: promote-user.sh <email> <students|faculty>}"

: "${LITELLM_MASTER_KEY:?LITELLM_MASTER_KEY not set -- source .env first (set -a; source .env; set +a)}"
LITELLM_URL="${LITELLM_URL:-http://localhost:4000}"

case "$TARGET" in
  students)
    : "${STUDENTS_TEAM_ID:?STUDENTS_TEAM_ID not set -- source .env first}"
    TEAM_ID="$STUDENTS_TEAM_ID"
    ;;
  faculty)
    : "${FACULTY_TEAM_ID:?FACULTY_TEAM_ID not set -- source .env first}"
    TEAM_ID="$FACULTY_TEAM_ID"
    ;;
  *)
    echo "target must be 'students' or 'faculty', got: $TARGET" >&2
    exit 1
    ;;
esac

echo "Looking up $EMAIL's portal-issued key (from the keyportal container's own cache)..."
RAW_KEY=$(docker exec gb10-keyportal python3 -c "
import sqlite3
conn = sqlite3.connect('/data/keyportal.db')
row = conn.execute('SELECT litellm_key FROM keys WHERE email = ?', ('$EMAIL',)).fetchone()
print(row[0] if row else '')
")

if [ -z "$RAW_KEY" ]; then
  echo "No key found for $EMAIL -- they haven't visited https://local-llm-keys.uamishub.com/ yet." >&2
  echo "(Nothing to promote -- ask them to sign in there first, which issues a pending key.)" >&2
  exit 1
fi

echo "Clearing any legacy user_id binding (harmless no-op for keys issued after 2026-09-29)..."
CLEAR_RESP=$(curl -sf -X POST "$LITELLM_URL/key/update" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" \
  -d "{\"key\": \"$RAW_KEY\", \"user_id\": null}")
if echo "$CLEAR_RESP" | grep -q '"error"'; then
  echo "Failed to clear user_id: $CLEAR_RESP" >&2
  exit 1
fi

echo "Moving to team_id=$TEAM_ID ($TARGET)..."
UPDATE_RESP=$(curl -sf -X POST "$LITELLM_URL/key/update" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" \
  -d "{\"key\": \"$RAW_KEY\", \"team_id\": \"$TEAM_ID\"}")
if echo "$UPDATE_RESP" | grep -q '"error"'; then
  echo "Failed to set team_id: $UPDATE_RESP" >&2
  exit 1
fi

RESULT_TEAM=$(curl -sf "$LITELLM_URL/key/info" -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -G --data-urlencode "key=$RAW_KEY" | jq -r ".info.team_id")

if [ "$RESULT_TEAM" = "$TEAM_ID" ]; then
  echo "Done: $EMAIL is now on team_id=$TEAM_ID ($TARGET)."
  echo "Same key, no reissue -- they don't need to do anything except reload the portal page (or nothing at all if they're just using their editor)."
else
  echo "Something is wrong: expected team_id=$TEAM_ID, got '$RESULT_TEAM'" >&2
  exit 1
fi
