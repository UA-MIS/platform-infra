#!/usr/bin/env bash
# ============================================================================
# tenant-onoff.sh — REVERSIBLE tenant on/off switch for the Capstone IDP.
#
#   off  <team>   PAUSE a tenant: neutralize ArgoCD for ALL the team's
#                 Applications, then delete the team's namespaces so the tenant
#                 stops running and VANISHES from k9s.
#   on   <team>   REVERSE it: re-enable ArgoCD so it recreates the namespaces +
#                 AppProject + workloads from git.
#
# It is PURELY IMPERATIVE (kubectl). It NEVER touches git / the repo / Harbor /
# Vault / GitHub. The only writes are to live ArgoCD Application / ApplicationSet
# objects and to Kubernetes Namespaces in THIS team's blast radius.
#
# DRY_RUN=true by DEFAULT: it prints the exact plan (every mutating command) and
# changes nothing. Set DRY_RUN=false to actually act.
#
# ---------------------------------------------------------------------------
# WHY THIS IS MORE THAN "kubectl delete ns" — the GitOps reversion chain
# ---------------------------------------------------------------------------
# This platform is app-of-apps. If you only `kubectl delete ns`, ArgoCD's
# self-heal recreates it within seconds. The owners, from the leaf up:
#
#   root (Application, selfHeal)            -> manages applicationsets/  (incl.
#                                              the SHARED `tenants` ApplicationSet)
#     tenants (ApplicationSet)              -> generates the per-team BOOTSTRAP
#                                              app `tenant-team-<team>`
#       tenant-team-<team> (Application)    -> owns the team AppProject + the
#         (selfHeal)                          team's namespaces + the team's
#                                             `<team>-envs` / `<team>-preview`
#                                             ApplicationSets
#         <team>-envs / <team>-preview      -> generate the env / preview apps
#           (ApplicationSet)                  `<team>-dev|-staging|-prod`,
#                                             `<team>-pr-<n>`
#             <team>-<env> (Application)    -> owns the workloads in the namespace
#
# To make OFF DURABLE (the namespaces STAY gone) we must stop EACH owner from
# re-asserting, top-down, but SCOPED to one team so other tenants are untouched:
#
#   1. root.spec.ignoreDifferences  += a tightly-scoped entry telling root to
#      ignore ONLY `tenants`.spec.ignoreApplicationDifferences. root is the top
#      of the app-of-apps (nothing reconciles root's own spec), so this patch is
#      durable. Without it, root's selfHeal would wipe step 2 within ~3 min.
#   2. tenants.spec.ignoreApplicationDifferences += a NAME-SCOPED entry for
#      `tenant-team-<team>` (ignore /spec/syncPolicy + /metadata/annotations), so
#      the SHARED tenants appset stops reverting our edits to THIS team's
#      bootstrap app only. Other teams' bootstrap apps keep reconciling normally.
#   3. tenant-team-<team>: skip-reconcile annotation + automated:null. The
#      application controller now ignores it -> it won't recreate the namespaces.
#   4. <team>-envs / <team>-preview: skip-reconcile annotation +
#      ignoreApplicationDifferences. Durable because their owner (the bootstrap
#      app) is now neutralized. Also stops the preview appset minting NEW pr apps.
#   5. <team>-* env/preview apps: skip-reconcile annotation + automated:null. The
#      strongest single guarantee (the app controller skips them outright).
#   6. THEN delete the namespaces.
#
# Every mechanism is a documented ArgoCD feature, verified against the INSTALLED
# version v3.4.3 (bootstrap/argocd-install/kustomization.yaml):
#   * `argocd.argoproj.io/skip-reconcile: "true"`  (user-guide/skip_reconcile.md)
#       -> the application controller skips the Application entirely.
#   * ApplicationSet `spec.ignoreApplicationDifferences` with jsonPointers
#       -> the documented way to "temporarily toggle auto-sync" for an app
#          managed by an ApplicationSet (Controlling-Resource-Modification.md).
#       (Per the docs, editing a generated app's spec.syncPolicy.automated alone
#        has NO effect — the appset reverts it — hence the ignore guards above.)
#   * Application `spec.ignoreDifferences`  (declarative-setup / sync-options).
# We ALSO set the skip-reconcile annotation on the team ApplicationSets as a
# best-effort freeze; it is harmless if the controller treats it as unknown.
#
# ON reverses 6->1: re-enable the bootstrap app FIRST (recreates ns/AppProject/
# appsets), wait for the namespaces, then un-freeze the env/preview side. Per-env
# sync policy (e.g. the prod manual gate) is restored by the team appset from
# git, so ON does NOT hardcode prod to auto.
#
# ---------------------------------------------------------------------------
# CAVEAT — DATA LOSS. Deleting a namespace deletes its PVCs and any in-cluster-
# only data. This script REFUSES to delete a namespace that contains a PVC unless
# FORCE=true. ESO-materialized Secrets are fine — ExternalSecret re-creates them
# on ON.
# ---------------------------------------------------------------------------
#
# Usage:
#   DRY_RUN=true  bash hack/tenant-onoff.sh off sample          # print the plan
#   DRY_RUN=false bash hack/tenant-onoff.sh off sample          # act
#   DRY_RUN=false FORCE=true bash hack/tenant-onoff.sh off sample  # act + allow PVC loss
#   DRY_RUN=false bash hack/tenant-onoff.sh on  sample          # bring it back
#
# Env:
#   DRY_RUN       default true  — print only; false to act.
#   FORCE         default false — allow deleting namespaces that contain PVCs.
#   KUBE_CONTEXT  kube-context to act on (Talos: admin@capstone, set KUBECONFIG).
#   ARGOCD_NS     default argocd.
# ============================================================================
set -euo pipefail

ACTION="${1:-}"
TEAM="${2:-}"

DRY_RUN="${DRY_RUN:-true}"
FORCE="${FORCE:-false}"
ARGOCD_NS="${ARGOCD_NS:-argocd}"
KUBE_CONTEXT="${KUBE_CONTEXT:-}"
SKIP_ANNOT="argocd.argoproj.io/skip-reconcile"

# ---- pretty logging (all human-readable output -> stderr) ------------------
info()  { printf '    %s\n'  "$*" >&2; }
step()  { printf '\n==> %s\n' "$*" >&2; }
warn()  { printf '  ⚠  %s\n' "$*" >&2; }
die()   { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ---- arg + tool validation -------------------------------------------------
case "$ACTION" in on|off) ;; *) die "usage: $0 <on|off> <team-slug>   (got action='$ACTION')";; esac
[ -n "$TEAM" ] || die "usage: $0 $ACTION <team-slug>"
[[ "$TEAM" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "team slug '$TEAM' is not a valid DNS label"
command -v kubectl >/dev/null || die "kubectl not found."
command -v jq      >/dev/null || die "jq not found (needed for idempotent list patches)."

KCTL=(kubectl)
if [ -n "$KUBE_CONTEXT" ]; then
  kubectl config get-contexts "$KUBE_CONTEXT" >/dev/null 2>&1 \
    || die "kube-context '$KUBE_CONTEXT' not found. For Talos: KUBECONFIG=clusters/real-talos/talos-kubeconfig KUBE_CONTEXT=admin@capstone."
  KCTL=(kubectl --context "$KUBE_CONTEXT")
fi

# Derived live object names (see the reversion-chain map above).
BOOTSTRAP="tenant-team-${TEAM}"
ENVS_APPSET="${TEAM}-envs"
PREVIEW_APPSET="${TEAM}-preview"
APPSETS=("$ENVS_APPSET" "$PREVIEW_APPSET")

if [ "$DRY_RUN" = "true" ]; then
  warn "DRY_RUN=true — printing the plan only; NOTHING will be changed. Set DRY_RUN=false to act."
fi

# ---- run(): echo a mutating command; execute only when DRY_RUN=false -------
run() {
  printf '      + %s\n' "$(printf '%q ' "$@")" >&2
  if [ "$DRY_RUN" = "false" ]; then "$@"; fi
}

exists() {  # exists <resource> <name>
  "${KCTL[@]}" -n "$ARGOCD_NS" get "$1" "$2" >/dev/null 2>&1
}

# ---- annotation / syncPolicy helpers (merge patches = idempotent) ----------
app_skip_on()    { run "${KCTL[@]}" -n "$ARGOCD_NS" patch applications.argoproj.io "$1" --type merge \
                       -p "{\"metadata\":{\"annotations\":{\"$SKIP_ANNOT\":\"true\"}}}"; }
app_skip_off()   { run "${KCTL[@]}" -n "$ARGOCD_NS" patch applications.argoproj.io "$1" --type merge \
                       -p "{\"metadata\":{\"annotations\":{\"$SKIP_ANNOT\":null}}}"; }
app_auto_off()   { run "${KCTL[@]}" -n "$ARGOCD_NS" patch applications.argoproj.io "$1" --type merge \
                       -p '{"spec":{"syncPolicy":{"automated":null}}}'; }
app_auto_on()    { run "${KCTL[@]}" -n "$ARGOCD_NS" patch applications.argoproj.io "$1" --type merge \
                       -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}'; }
app_refresh()    { run "${KCTL[@]}" -n "$ARGOCD_NS" patch applications.argoproj.io "$1" --type merge \
                       -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'; }

aset_skip_on()   { run "${KCTL[@]}" -n "$ARGOCD_NS" patch applicationsets.argoproj.io "$1" --type merge \
                       -p "{\"metadata\":{\"annotations\":{\"$SKIP_ANNOT\":\"true\"}}}"; }
aset_skip_off()  { run "${KCTL[@]}" -n "$ARGOCD_NS" patch applicationsets.argoproj.io "$1" --type merge \
                       -p "{\"metadata\":{\"annotations\":{\"$SKIP_ANNOT\":null}}}"; }
aset_ignore_on() { run "${KCTL[@]}" -n "$ARGOCD_NS" patch applicationsets.argoproj.io "$1" --type merge \
                       -p '{"spec":{"ignoreApplicationDifferences":[{"jsonPointers":["/spec/syncPolicy","/metadata/annotations"]}]}}'; }
aset_ignore_off(){ run "${KCTL[@]}" -n "$ARGOCD_NS" patch applicationsets.argoproj.io "$1" --type merge \
                       -p '{"spec":{"ignoreApplicationDifferences":null}}'; }

# ---- read-modify-write list patchers (preserve OTHER entries) --------------
# Patch a JSON-list spec field idempotently: read live object, run a jq filter
# that returns the DESIRED array, merge-patch it back. Read is non-mutating so it
# always runs; only the patch is gated by run().
patch_list() {  # patch_list <resource> <name> <specField> <jqFilter> [jq --args...]
  local res="$1" name="$2" field="$3" jqf="$4"; shift 4
  local cur desired
  cur=$("${KCTL[@]}" -n "$ARGOCD_NS" get "$res" "$name" -o json 2>/dev/null) \
    || { warn "$res/$name not found — skipping ($field)"; return 0; }
  desired=$(printf '%s' "$cur" | jq -c "$@" "$jqf")
  run "${KCTL[@]}" -n "$ARGOCD_NS" patch "$res" "$name" --type merge \
      -p "{\"spec\":{\"$field\":$desired}}"
}

ROOT_ENTRY='{"group":"argoproj.io","kind":"ApplicationSet","name":"tenants","namespace":"argocd","jsonPointers":["/spec/ignoreApplicationDifferences"]}'

root_ignore_add() {
  patch_list applications.argoproj.io root ignoreDifferences \
    '(.spec.ignoreDifferences // []) as $x
     | if any($x[]?; .kind=="ApplicationSet" and .name=="tenants"
                     and ((.jsonPointers // []) | index("/spec/ignoreApplicationDifferences")))
       then $x else $x + [$e] end' \
    --argjson e "$ROOT_ENTRY"
}
root_ignore_remove() {
  patch_list applications.argoproj.io root ignoreDifferences \
    '[ (.spec.ignoreDifferences // [])[]?
       | select( (.kind=="ApplicationSet" and .name=="tenants"
                  and ((.jsonPointers // []) | index("/spec/ignoreApplicationDifferences"))) | not ) ]'
}
tenants_ignore_add() {
  patch_list applicationsets.argoproj.io tenants ignoreApplicationDifferences \
    '(.spec.ignoreApplicationDifferences // []) as $x
     | if any($x[]?; .name==$n) then $x
       else $x + [{"name":$n,"jsonPointers":["/spec/syncPolicy","/metadata/annotations"]}] end' \
    --arg n "$BOOTSTRAP"
}
tenants_ignore_remove() {
  patch_list applicationsets.argoproj.io tenants ignoreApplicationDifferences \
    '[ (.spec.ignoreApplicationDifferences // [])[]? | select(.name != $n) ]' \
    --arg n "$BOOTSTRAP"
}

# ---- discovery -------------------------------------------------------------
# Namespaces: match by NAME (catches even BARE dynamic preview namespaces that
# the preview appset creates without team labels) — exactly <team>-{dev,staging,
# prod} and <team>-pr-<digits>. Never matches a different team (e.g. <team>2-*).
discover_namespaces() {
  "${KCTL[@]}" get ns -o name 2>/dev/null | sed 's#^namespace/##' \
    | grep -E "^${TEAM}-(dev|staging|prod)$|^${TEAM}-pr-[0-9]+$" || true
}
# Env + preview Applications: the appset template stamps platform.capstone/team,
# so a label select is reliable (and the bootstrap app is NOT team-labelled, so
# it is excluded here and handled separately by name).
discover_apps() {
  "${KCTL[@]}" -n "$ARGOCD_NS" get applications.argoproj.io \
      -l "platform.capstone/team=${TEAM}" -o name 2>/dev/null | sed 's#.*/##' || true
}

# ============================================================================
# OFF
# ============================================================================
do_off() {
  step "tenant-off TEAM=$TEAM  (context: ${KUBE_CONTEXT:-current})"

  exists applications.argoproj.io "$BOOTSTRAP" \
    || warn "bootstrap app '$BOOTSTRAP' not found — continuing (idempotent / partial state)."

  mapfile -t NSS  < <(discover_namespaces)
  mapfile -t APPS < <(discover_apps)
  info "bootstrap app : $BOOTSTRAP"
  info "team appsets  : ${APPSETS[*]}"
  info "env/preview apps: ${APPS[*]:-<none>}"
  info "namespaces    : ${NSS[*]:-<none>}"

  # ---- PVC / data-loss guard (BEFORE any mutation) -------------------------
  step "[guard] scanning target namespaces for PVCs (deleting a namespace DESTROYS its PVCs)"
  local has_pvc="false" ns out
  for ns in "${NSS[@]}"; do
    out=$("${KCTL[@]}" -n "$ns" get pvc -o name 2>/dev/null || true)
    if [ -n "$out" ]; then
      has_pvc="true"
      warn "PVC(s) in namespace '$ns':"
      printf '%s\n' "$out" | sed 's/^/        /' >&2
    fi
  done
  if [ "$has_pvc" = "true" ]; then
    warn "════════════════════════════════════════════════════════════════════"
    warn " DATA LOSS WARNING: the namespaces above contain PVCs. Deleting the"
    warn " namespaces will PERMANENTLY DELETE that storage and its data."
    warn " (ESO-materialized Secrets are safe — they are re-created on tenant-on.)"
    warn "════════════════════════════════════════════════════════════════════"
    if [ "$FORCE" != "true" ]; then
      if [ "$DRY_RUN" = "true" ]; then
        warn "A real run (DRY_RUN=false) would ABORT here. Re-run with FORCE=true to allow PVC deletion."
      else
        die "refusing to delete namespaces containing PVCs. Re-run with FORCE=true to proceed (data WILL be lost)."
      fi
    else
      warn "FORCE=true — PVC deletion is permitted. Proceeding."
    fi
  else
    info "no PVCs found in target namespaces — safe to delete."
  fi

  # ---- 1. root: ignore the tenants-appset ignore field (durability anchor) -
  step "[1/6] root.spec.ignoreDifferences += scoped guard for the 'tenants' appset"
  root_ignore_add

  # ---- 2. tenants appset: stop reverting THIS team's bootstrap app ---------
  step "[2/6] tenants.spec.ignoreApplicationDifferences += name-scoped guard for '$BOOTSTRAP'"
  tenants_ignore_add

  # ---- 3. bootstrap app: neutralize (skip-reconcile + no automated) --------
  step "[3/6] neutralize bootstrap app '$BOOTSTRAP'"
  if exists applications.argoproj.io "$BOOTSTRAP"; then
    app_skip_on  "$BOOTSTRAP"
    app_auto_off "$BOOTSTRAP"
  else
    info "skip — '$BOOTSTRAP' absent."
  fi

  # ---- 4. team appsets: freeze (so no env reverts + no new previews) -------
  step "[4/6] freeze team ApplicationSets: ${APPSETS[*]}"
  for as in "${APPSETS[@]}"; do
    if exists applicationsets.argoproj.io "$as"; then
      aset_skip_on   "$as"
      aset_ignore_on "$as"
    else
      info "skip — appset '$as' absent."
    fi
  done

  # ---- 5. env/preview apps: neutralize each -------------------------------
  step "[5/6] neutralize env/preview apps"
  if [ "${#APPS[@]}" -eq 0 ]; then info "no env/preview apps found."; fi
  for a in "${APPS[@]}"; do
    app_skip_on  "$a"
    app_auto_off "$a"
  done

  # ---- 6. delete the namespaces (they vanish from k9s) --------------------
  step "[6/6] delete namespaces: ${NSS[*]:-<none>}"
  if [ "${#NSS[@]}" -eq 0 ]; then
    info "no matching namespaces — nothing to delete."
  else
    for ns in "${NSS[@]}"; do
      run "${KCTL[@]}" delete namespace "$ns" --ignore-not-found --wait=true --timeout=180s
    done
  fi

  step "tenant-off complete for '$TEAM'."
  if [ "$DRY_RUN" = "true" ]; then
    info "(DRY_RUN — nothing changed. Re-run with DRY_RUN=false to act.)"
  else
    info "Verify: kubectl get ns | grep '^${TEAM}-'   (expect none)"
    info "Reverse: make tenant-on TEAM=${TEAM} DRY_RUN=false"
  fi
}

# ============================================================================
# ON  — reverse OFF; re-enable the bootstrap app FIRST, then the env/preview side
# ============================================================================
do_on() {
  step "tenant-on TEAM=$TEAM  (context: ${KUBE_CONTEXT:-current})"
  mapfile -t APPS < <(discover_apps)
  info "bootstrap app : $BOOTSTRAP"
  info "team appsets  : ${APPSETS[*]}"
  info "env/preview apps: ${APPS[*]:-<none>}"

  # ---- 1. bootstrap app: un-neutralize (it recreates ns/AppProject/appsets)-
  step "[1/6] re-enable bootstrap app '$BOOTSTRAP'"
  if exists applications.argoproj.io "$BOOTSTRAP"; then
    app_skip_off "$BOOTSTRAP"
    app_auto_on  "$BOOTSTRAP"
  else
    info "'$BOOTSTRAP' absent — the tenants appset will recreate it once the guards are removed."
  fi

  # ---- 2. tenants appset: drop the name-scoped guard ----------------------
  step "[2/6] tenants.spec.ignoreApplicationDifferences -= guard for '$BOOTSTRAP'"
  tenants_ignore_remove

  # ---- 3. root: drop the durability anchor --------------------------------
  step "[3/6] root.spec.ignoreDifferences -= guard for the 'tenants' appset"
  root_ignore_remove

  # ---- 4. nudge the bootstrap app + wait for the namespaces ---------------
  step "[4/6] refresh bootstrap app and wait for namespaces to come back"
  if exists applications.argoproj.io "$BOOTSTRAP"; then app_refresh "$BOOTSTRAP"; fi
  if [ "$DRY_RUN" = "false" ]; then
    local want="${TEAM}-dev" i=0
    info "waiting up to 180s for namespace '$want'..."
    until "${KCTL[@]}" get ns "$want" >/dev/null 2>&1; do
      i=$((i+1)); [ "$i" -ge 60 ] && { warn "namespace '$want' not back yet — check 'argocd app get $BOOTSTRAP'."; break; }
      sleep 3
    done
    "${KCTL[@]}" get ns "$want" >/dev/null 2>&1 && info "namespace '$want' is back."
  else
    info "(DRY_RUN — would poll for namespace '${TEAM}-dev'.)"
  fi

  # ---- 5. team appsets: un-freeze (re-asserts per-env policy incl. prod gate)
  step "[5/6] un-freeze team ApplicationSets: ${APPSETS[*]}"
  for as in "${APPSETS[@]}"; do
    if exists applicationsets.argoproj.io "$as"; then
      aset_skip_off   "$as"
      aset_ignore_off "$as"   # appset re-asserts each app's correct syncPolicy from git
    else
      info "appset '$as' absent — the bootstrap app will recreate it from git."
    fi
  done

  # ---- 6. env/preview apps: drop skip-reconcile + refresh ------------------
  # We do NOT hardcode automated here: the team appset (now un-frozen) restores
  # each env's true policy from git, preserving the prod MANUAL gate.
  step "[6/6] un-neutralize env/preview apps (let the appset restore per-env policy)"
  if [ "${#APPS[@]}" -eq 0 ]; then info "no env/preview apps yet — the appset will (re)create them."; fi
  for a in "${APPS[@]}"; do
    app_skip_off "$a"
    app_refresh  "$a"
  done

  step "tenant-on complete for '$TEAM'."
  if [ "$DRY_RUN" = "true" ]; then
    info "(DRY_RUN — nothing changed. Re-run with DRY_RUN=false to act.)"
  else
    info "Verify: kubectl get ns | grep '^${TEAM}-'   and   argocd app list -l platform.capstone/team=${TEAM}"
    info "Note: a 'prod' env stays MANUAL by gate — sync it deliberately if/when intended."
  fi
}

case "$ACTION" in
  off) do_off ;;
  on)  do_on  ;;
esac
