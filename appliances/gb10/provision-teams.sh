#!/usr/bin/env bash
set -euo pipefail

LITELLM_URL="${LITELLM_URL:-http://localhost:4000}"
: "${LITELLM_MASTER_KEY:?set LITELLM_MASTER_KEY in your shell (source .env first)}"

echo "== Creating pending team (D11: ZERO model access by default) =="
PENDING_TEAM_JSON=$(curl -sf -X POST "$LITELLM_URL/team/new" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "team_alias": "pending",
    "models": [],
    "max_parallel_requests": 0,
    "rpm_limit": 0,
    "tpm_limit": 0
  }')
PENDING_TEAM_ID=$(echo "$PENDING_TEAM_JSON" | jq -r '.team_id')
echo "pending team_id=$PENDING_TEAM_ID"

echo "== Creating students team (crimson.ua.edu, real access, promotion target) =="
STUDENTS_TEAM_JSON=$(curl -sf -X POST "$LITELLM_URL/team/new" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "team_alias": "students",
    "max_budget": 200,
    "budget_duration": "30d",
    "rpm_limit": 600,
    "tpm_limit": 400000,
    "max_parallel_requests": 30,
    "models": ["qwen3.8-27b"]
  }')
STUDENTS_TEAM_ID=$(echo "$STUDENTS_TEAM_JSON" | jq -r '.team_id')
echo "students team_id=$STUDENTS_TEAM_ID"

echo "== Creating faculty team (ua.edu, real access, promotion target) =="
FACULTY_TEAM_JSON=$(curl -sf -X POST "$LITELLM_URL/team/new" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "team_alias": "faculty",
    "max_budget": 200,
    "budget_duration": "30d",
    "rpm_limit": 600,
    "tpm_limit": 400000,
    "max_parallel_requests": 30,
    "models": ["qwen3.8-27b"]
  }')
FACULTY_TEAM_ID=$(echo "$FACULTY_TEAM_JSON" | jq -r '.team_id')
echo "faculty team_id=$FACULTY_TEAM_ID"

echo "== Creating ungraded team (NOT a promotion target — provisioned directly, see below) =="
UNGRADED_TEAM_JSON=$(curl -sf -X POST "$LITELLM_URL/team/new" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "team_alias": "ungraded-batch-grading",
    "max_budget": 100,
    "budget_duration": "30d",
    "rpm_limit": 60,
    "tpm_limit": 200000,
    "max_parallel_requests": 3,
    "models": ["qwen3.8-27b-base"]
  }')
UNGRADED_TEAM_ID=$(echo "$UNGRADED_TEAM_JSON" | jq -r '.team_id')
echo "ungraded team_id=$UNGRADED_TEAM_ID"

echo "== Generating ungraded's dedicated key =="
echo "   (prompt logging OFF, hard-pinned to the base model — never the router alias,"
echo "    issued directly with real access — never goes through the pending team or the portal)"
UNGRADED_KEY_JSON=$(curl -sf -X POST "$LITELLM_URL/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"team_id\": \"$UNGRADED_TEAM_ID\",
    \"key_alias\": \"ungraded-service-key\",
    \"models\": [\"qwen3.8-27b-base\"],
    \"max_parallel_requests\": 3,
    \"rpm_limit\": 60,
    \"tpm_limit\": 200000,
    \"metadata\": {\"disable_logging\": true}
  }")
UNGRADED_KEY=$(echo "$UNGRADED_KEY_JSON" | jq -r '.key')

echo ""
echo "============================================================"
echo "Append these four lines to appliances/gb10/.env on the box:"
echo "PENDING_TEAM_ID=$PENDING_TEAM_ID"
echo "STUDENTS_TEAM_ID=$STUDENTS_TEAM_ID"
echo "FACULTY_TEAM_ID=$FACULTY_TEAM_ID"
echo "UNGRADED_TEAM_ID=$UNGRADED_TEAM_ID"
echo "============================================================"
echo ""
echo "ungraded's LiteLLM key (hand this to whoever owns the"
echo "edpatterson1/ungrading-project secrets — NOT stored in this repo):"
echo "$UNGRADED_KEY"
