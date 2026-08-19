#!/usr/bin/env bash
# provision-team-repo.sh — instantiate one MIS 521 lab CI/CD repo from the
# UA-MIS/lab-cicd-base template and grant the D-062 permission model.
#
# Design: artifacts/design/lab-cicd-exercise-design.md Sec2.2/Sec2.3.
# Mechanism copied verbatim from UA-MIS/slidedeck's server/scaffold.js
# (generate -> poll -> grant), swapped from a per-user collaborator PUT to a
# per-team org-repo PUT (Sec1.4 "what's directly reusable").
#
# Usage:
#   ./provision-team-repo.sh <team-slug> [repo-name]
#
#   team-slug   Existing GitHub Team slug in UA-MIS that will get `maintain`
#               on the generated repo (the "creating team"). Required.
#   repo-name   Defaults to lab-cicd-<team-slug>.
#
# Env overrides (all optional, defaults match the design doc):
#   ORG              UA-MIS
#   TEMPLATE_REPO    lab-cicd-base           (must already be is_template:true)
#   ADMIN_TEAM       521
#   POLL_ATTEMPTS    10   (matches scaffold.js's own 10x1.5s loop)
#   POLL_INTERVAL_S  1.5
#   APPLY_BRANCH_PROTECTION  1 (set 0 to skip; needs protection.json next to
#                              this script or PROTECTION_JSON=<path>)
#   DRY_RUN          0    (set 1 to print the gh api calls without running them)
#
# Every gh api call below is idempotent-safe to re-run: PUT team-repo
# permission calls are naturally idempotent, and the generate call's 422
# "already exists" is caught and treated as already-provisioned (matching
# scaffold.js:68-79,506-511's handling) rather than a hard failure — this
# script can be re-run against a repo name that's already there.
#
# Nothing here touches the cluster. Every mutation is GitHub-side and
# reversible: delete/archive the generated repo, remove the team-repo grant.
set -euo pipefail

ORG="${ORG:-UA-MIS}"
TEMPLATE_REPO="${TEMPLATE_REPO:-lab-cicd-base}"
ADMIN_TEAM="${ADMIN_TEAM:-521}"
POLL_ATTEMPTS="${POLL_ATTEMPTS:-10}"
POLL_INTERVAL_S="${POLL_INTERVAL_S:-1.5}"
APPLY_BRANCH_PROTECTION="${APPLY_BRANCH_PROTECTION:-1}"
PROTECTION_JSON="${PROTECTION_JSON:-$(dirname "$0")/protection.json}"
DRY_RUN="${DRY_RUN:-0}"

TEAM_SLUG="${1:?usage: provision-team-repo.sh <team-slug> [repo-name]}"
REPO_NAME="${2:-lab-cicd-${TEAM_SLUG}}"

log() { printf '[provision-team-repo] %s\n' "$*" >&2; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN: $*"
  else
    "$@"
  fi
}

t_start=$(date +%s)

log "org=${ORG} template=${TEMPLATE_REPO} admin_team=${ADMIN_TEAM} team=${TEAM_SLUG} repo=${REPO_NAME}"

# --- Preflight: the creating team must already exist (mirrors the scaffolder's
# own "each team must already exist" contract, Sec1.1) — fail loud, not silent.
if ! gh api "orgs/${ORG}/teams/${TEAM_SLUG}" >/dev/null 2>&1; then
  log "ERROR: team '${TEAM_SLUG}' does not exist in org ${ORG}. Create it first" \
      "(gh api orgs/${ORG}/teams -X POST -f name='${TEAM_SLUG}' -f privacy=closed)" \
      "or pass the slug of an existing course team."
  exit 1
fi

# --- 1) Generate the repo from the template (async on GitHub's side). ---
t_gen_start=$(date +%s)
gen_out=$(gh api "repos/${ORG}/${TEMPLATE_REPO}/generate" -X POST \
  -H "Accept: application/vnd.github+json" \
  -f owner="${ORG}" \
  -f name="${REPO_NAME}" \
  -f description="MIS 521 Lab CI/CD exercise — team ${TEAM_SLUG}" \
  -F private=true \
  -F include_all_branches=false 2>&1) && gen_status="ok" || gen_status="fail"

if [ "$gen_status" = "fail" ]; then
  if echo "$gen_out" | grep -q '"message":.*already exists\|Name already exists'; then
    log "repo ${ORG}/${REPO_NAME} already exists — treating as already-provisioned (scaffold.js 422 pattern), continuing to permissions."
  else
    log "ERROR: generate call failed:"
    echo "$gen_out" >&2
    exit 1
  fi
fi
t_gen_end=$(date +%s)
log "generate call: $((t_gen_end - t_gen_start))s"

# --- 2) Poll for readiness (mirrors scaffold.js:523-533's 10x1.5s loop). ---
t_poll_start=$(date +%s)
ready=0
for i in $(seq 1 "$POLL_ATTEMPTS"); do
  if gh api "repos/${ORG}/${REPO_NAME}/contents/README.md" >/dev/null 2>&1; then
    ready=1
    log "poll: ready after ${i} attempt(s)"
    break
  fi
  log "poll: attempt ${i}/${POLL_ATTEMPTS} not ready yet, sleeping ${POLL_INTERVAL_S}s"
  sleep "$POLL_INTERVAL_S"
done
t_poll_end=$(date +%s)
log "poll loop: $((t_poll_end - t_poll_start))s"

if [ "$ready" != "1" ]; then
  log "ERROR: repo ${ORG}/${REPO_NAME} never became readable via contents API after ${POLL_ATTEMPTS} attempts (~$((POLL_ATTEMPTS * ${POLL_INTERVAL_S%.*}))s). Aborting before granting permissions on a repo that may not be real."
  exit 1
fi

# --- 3) Grant permissions: 521=admin, creating team=maintain (Sec2.2). ---
run gh api "orgs/${ORG}/teams/${ADMIN_TEAM}/repos/${ORG}/${REPO_NAME}" -X PUT -f permission='admin'
log "granted ${ADMIN_TEAM}=admin on ${ORG}/${REPO_NAME}"

run gh api "orgs/${ORG}/teams/${TEAM_SLUG}/repos/${ORG}/${REPO_NAME}" -X PUT -f permission='maintain'
log "granted ${TEAM_SLUG}=maintain on ${ORG}/${REPO_NAME}"

# --- 4) Optional branch protection (Sec2.3 step 3: PRs into main + CODEOWNERS review). ---
# Best-effort: branch protection is a nice-to-have on top of the permission
# grants above (which are the load-bearing part of this script), not a
# precondition for them. GitHub gates branch protection on PRIVATE repos
# behind a paid (Team/Enterprise) org plan — a UA-MIS-org-on-Free + private
# lab repo combination returns 403 "Upgrade to GitHub Pro or make this
# repository public" (confirmed live during the Phase 2 throwaway proof,
# artifacts/implementation/lab-cicd-proof.evidence.yaml). `set -e` would
# otherwise abort the whole script on that 403 even though the repo and its
# permissions are already correctly provisioned — so this step is
# deliberately isolated with `|| { ... }` rather than left to propagate.
if [ "$APPLY_BRANCH_PROTECTION" = "1" ]; then
  if [ -f "$PROTECTION_JSON" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      log "DRY-RUN: gh api repos/${ORG}/${REPO_NAME}/branches/main/protection -X PUT --input ${PROTECTION_JSON}"
    elif gh api "repos/${ORG}/${REPO_NAME}/branches/main/protection" -X PUT --input "$PROTECTION_JSON" >/tmp/lab-cicd-protection-out.$$ 2>&1; then
      log "applied branch protection from ${PROTECTION_JSON}"
    else
      log "WARNING: branch protection PUT failed (repo/permissions above are still correctly provisioned) — leaving main unprotected. Common cause: private repo + GitHub Free org plan (branch protection on private repos needs a paid plan; UA-MIS's other repos are public, which doesn't have this restriction). Response:"
      sed 's/^/  /' /tmp/lab-cicd-protection-out.$$ >&2
      rm -f /tmp/lab-cicd-protection-out.$$
    fi
  else
    log "WARNING: APPLY_BRANCH_PROTECTION=1 but ${PROTECTION_JSON} not found — skipping branch protection. Pass PROTECTION_JSON=<path> or set APPLY_BRANCH_PROTECTION=0 to silence this."
  fi
fi

t_end=$(date +%s)
log "DONE repo=https://github.com/${ORG}/${REPO_NAME} total=$((t_end - t_start))s (generate=$((t_gen_end - t_gen_start))s poll=$((t_poll_end - t_poll_start))s)"
