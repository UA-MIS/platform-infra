#!/usr/bin/env bash
# inject-fault.sh — deliver one fault from faults/ to a live lab team repo as
# a reviewed PR (not a direct push), per lab-cicd-exercise-design.md Sec2.4.
#
# Usage:
#   ./inject-fault.sh <repo-name> <fault-id> [pr-title]
#
#   repo-name   e.g. lab-cicd-throwaway1 (bare name, org is fixed to $ORG)
#   fault-id    directory name under faults/, e.g. 01-strip-autodeploy
#   pr-title    optional cover title; defaults to a generic "chore:" title
#               matching the design's audit-trail-not-history-rewrite intent
#               (Sec2.4: "a PR titled 'chore: dependency bump' or similar
#               cover story, reviewed and merged by 521").
#
# Env overrides:
#   ORG            UA-MIS
#   ADMIN_TEAM     521   (must be a member of this team for gh pr merge --admin
#                  to be meaningful; 521 has repo admin via provision-team-repo.sh)
#   WORKDIR        mktemp -d   (scratch clone location)
#   AUTO_MERGE     1   (0 = open the PR and stop, don't merge — lets an
#                  instructor review the diff before it lands)
#   COMMIT_BODY    "Routine config sync." — used as BOTH the commit message
#                  body and the PR body. Keep it generic: the creating team
#                  has `maintain` and can read every commit message and PR
#                  body in their own repo, so this text must never name the
#                  fault id or say "fault"/"injected"/"automated", and must
#                  never point at SYMPTOM.md/ANSWER-KEY.md (course staff
#                  already have the fault-id -> repo mapping from this
#                  script's own stderr log; nothing team-visible needs to
#                  repeat it).
#   DRY_RUN        0
#
# What it does:
#   1. Shallow-clones repo-name's main.
#   2. git apply --check faults/<fault-id>/fault.patch (refuses to proceed on
#      a patch that doesn't apply cleanly — the repo may have drifted from the
#      base template).
#   3. Applies the patch on a new branch fault/<fault-id>, pushes it.
#   4. Opens a PR (gh pr create).
#   5. If AUTO_MERGE=1 (default), merges it with --admin (521's repo-admin
#      bypass of its own CODEOWNERS requirement, Sec2.4) so the fault lands
#      without needing a human reviewer in the loop first — the team's
#      diagnosis work starts from the merged, deployed state.
#
# Reversible: this is a normal commit on main. `git revert` (or the
# fault's own ANSWER-KEY.md fix) undoes it.
set -euo pipefail

ORG="${ORG:-UA-MIS}"
ADMIN_TEAM="${ADMIN_TEAM:-521}"
AUTO_MERGE="${AUTO_MERGE:-1}"
DRY_RUN="${DRY_RUN:-0}"

REPO_NAME="${1:?usage: inject-fault.sh <repo-name> <fault-id> [pr-title]}"
FAULT_ID="${2:?usage: inject-fault.sh <repo-name> <fault-id> [pr-title]}"
PR_TITLE="${3:-chore: dependency and config sync}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAULT_DIR="${SCRIPT_DIR}/faults/${FAULT_ID}"
PATCH_FILE="${FAULT_DIR}/fault.patch"

log() { printf '[inject-fault] %s\n' "$*" >&2; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN: $*"
  else
    "$@"
  fi
}

if [ ! -f "$PATCH_FILE" ]; then
  log "ERROR: no such fault '${FAULT_ID}' (expected ${PATCH_FILE})"
  exit 1
fi

WORKDIR="${WORKDIR:-$(mktemp -d)}"
CLONE_DIR="${WORKDIR}/${REPO_NAME}"
log "workdir=${WORKDIR}"

git clone --depth 1 "https://github.com/${ORG}/${REPO_NAME}.git" "$CLONE_DIR"

log "checking patch applies cleanly (git apply --check)"
if ! git -C "$CLONE_DIR" apply --check "$PATCH_FILE"; then
  log "ERROR: ${PATCH_FILE} does not apply cleanly to ${ORG}/${REPO_NAME}@main — repo has likely drifted from the lab-cicd-base template. Refusing to inject blind."
  exit 1
fi

BRANCH="fault/${FAULT_ID}"
# Cover-story-safe commit + PR text (design Sec2.4's whole point of using a
# PR instead of a silent push is a REAL audit trail for course staff, not a
# hidden one — but the creating team has `maintain` and can read every
# commit message and PR body in their own repo, so neither may name the
# fault id, call out "fault"/"injected"/"automated", or point at
# SYMPTOM.md/ANSWER-KEY.md. Course staff already have this run's fault-id ->
# repo mapping from this script's own stderr log; nothing team-visible needs
# to repeat it. Keep this generic even if PR_TITLE/COMMIT_BODY are
# customized by a caller — don't reintroduce the leak via a fault-specific
# default.
COMMIT_BODY="${COMMIT_BODY:-Routine config sync.}"

git -C "$CLONE_DIR" checkout -q -b "$BRANCH"
git -C "$CLONE_DIR" apply "$PATCH_FILE"
git -C "$CLONE_DIR" add -A
git -C "$CLONE_DIR" -c user.name="ua-mis-521" -c user.email="521@capstone.uamishub.com" \
  commit -q -m "${PR_TITLE}" -m "${COMMIT_BODY}"

run git -C "$CLONE_DIR" push -u origin "$BRANCH"

if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN: would open PR from ${BRANCH} into main"
  exit 0
fi

pr_url=$(gh pr create --repo "${ORG}/${REPO_NAME}" --base main --head "$BRANCH" \
  --title "$PR_TITLE" \
  --body "${COMMIT_BODY}")
log "PR opened: ${pr_url}"
log "fault=${FAULT_ID} delivered to ${ORG}/${REPO_NAME} — course-staff-only mapping, kept out of the PR/commit text on purpose (see script comment above)"

if [ "$AUTO_MERGE" = "1" ]; then
  pr_number="${pr_url##*/}"
  gh pr merge --repo "${ORG}/${REPO_NAME}" "$pr_number" --admin --merge --delete-branch
  log "merged ${pr_url} via --admin (521 repo-admin bypass of CODEOWNERS, Sec2.4)"
else
  log "AUTO_MERGE=0 — PR left open for manual review/merge: ${pr_url}"
fi
