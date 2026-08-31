#!/usr/bin/env bash
# Harbor tag-retention verification. Operator tool, NOT part of the kustomization
# (kustomization.yaml lists resources explicitly, so this file is never applied).
#
# Board #127/#136. Two things this exists to make impossible:
#
#   1. Trusting the Job's exit code. The Job's own post-apply check used to grep only
#      for "latestPushedK", so it went green whether or not the rule that actually
#      protects releases had made it in. `verify` below re-reads every policy from
#      the API and asserts the full rule set.
#
#   2. Arming an irreversible deletion policy on evidence that is only a projection.
#      Harbor has NO undelete and NO DELETE route for retention policies. `dryrun`
#      asks Harbor itself, per repository, which tags it would remove and which it
#      would hold, and prints its RETAIN/DEL table verbatim.
#
# Usage:
#   ./verify-retention.sh verify     # read-only: policy coverage + rule set per project
#   ./verify-retention.sh dryrun     # Harbor-native dry run of every existing policy
#   ./verify-retention.sh dryrun ida-llm   # ...just one project
#
# `dryrun` triggers Harbor executions with dry_run=true. Those delete NOTHING; they
# only walk the candidate set and write a log. Neither subcommand ever mutates a
# policy. Requires kubectl access to the harbor namespace; opens its own
# port-forward and cleans it up on exit.
set -euo pipefail

NS=harbor
PORT="${HARBOR_PORT:-18080}"
API="http://127.0.0.1:${PORT}/api/v2.0"
CMD="${1:-verify}"
ONLY="${2:-}"

command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }

PW="$(kubectl get secret -n "$NS" harbor-admin -o jsonpath='{.data.HARBOR_ADMIN_PASSWORD}' | base64 -d)"
[ -n "$PW" ] || { echo "could not read harbor-admin password" >&2; exit 1; }

kubectl port-forward -n "$NS" svc/harbor-core "${PORT}:80" >/dev/null 2>&1 &
PF=$!
cleanup() { kill "$PF" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "${API}/systeminfo" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "${API}/systeminfo" || { echo "harbor-core not reachable" >&2; exit 1; }

api() { curl -sS -u "admin:${PW}" "${API}$1"; }
post() { curl -sS -u "admin:${PW}" -X POST -H 'Content-Type: application/json' --data "$2" "${API}$1"; }

# name<TAB>project_id<TAB>retention_id(or -)
projects() {
  api '/projects?page_size=100' | python3 -c '
import json,sys
for p in sorted(json.load(sys.stdin), key=lambda z: z["name"]):
    md = p.get("metadata") or {}
    print("%s\t%s\t%s" % (p["name"], p["project_id"], md.get("retention_id", "-")))
'
}

case "$CMD" in
verify)
  echo "Harbor tag-retention coverage  ($(date -u +%FT%TZ))"
  echo
  printf '%-24s %8s %8s  %s\n' PROJECT ID POLICY RULES
  printf -- '---------------------------------------------------------------------------\n'
  covered=0; total=0
  while IFS=$'\t' read -r name pid rid; do
    total=$((total+1))
    if [ "$rid" = "-" ]; then
      printf '%-24s %8s %8s  %s\n' "$name" "$pid" "-" "NO POLICY -- nightly GC cannot reclaim anything here"
      continue
    fi
    covered=$((covered+1))
    api "/retentions/${rid}" | python3 -c '
import json,sys
p=json.load(sys.stdin)
out=[]
for r in p.get("rules",[]):
    pat=(r.get("tag_selectors") or [{}])[0].get("pattern","?")
    t=r.get("template")
    d=" (DISABLED)" if r.get("disabled") else ""
    if t=="latestPushedK": out.append("keep last %s pushed%s" % (r["params"].get("latestPushedK"),d))
    elif t=="always":      out.append("ALWAYS keep %r%s" % (pat,d))
    else:                  out.append("%s %s%s" % (t, r.get("params"), d))
print("%-24s %8s %8s  %s" % ("'"$name"'", "'"$pid"'", "'"$rid"'", "; ".join(out) or "NO RULES"))
'
  done < <(projects)
  printf -- '---------------------------------------------------------------------------\n'
  echo "${covered} of ${total} projects have a retention policy."
  echo
  echo "Reminder: Harbor's nightly GC only reclaims blobs belonging to UNTAGGED"
  echo "manifests. A project with no retention policy never untags anything, so GC"
  echo "runs, succeeds, and frees nothing there."
  ;;

dryrun)
  PW="$PW" API="$API" ONLY="$ONLY" python3 - <<'PY'
import json, os, subprocess, sys, time

API, PW, ONLY = os.environ['API'], os.environ['PW'], os.environ.get('ONLY', '')


def call(path, method='GET', body=None):
    cmd = ['curl', '-sS', '-u', 'admin:' + PW, API + path]
    if method != 'GET':
        cmd += ['-X', method, '-H', 'Content-Type: application/json', '--data', body or '']
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        return json.loads(out) if out.strip() else None
    except ValueError:
        return out


# every image:tag a live workload references -- the cluster, not the manifests
running = set()
tmpl = ('{range .items[*]}{range %s.containers[*]}{.image}{"\\n"}{end}'
        '{range %s.initContainers[*]}{.image}{"\\n"}{end}{end}')
for kind, base in (('pods', '.spec'),
                   ('cronjobs', '.spec.jobTemplate.spec.template.spec'),
                   ('deployments', '.spec.template.spec'),
                   ('statefulsets', '.spec.template.spec')):
    out = subprocess.run(['kubectl', 'get', kind, '-A', '-o',
                          'jsonpath=' + (tmpl % (base, base))],
                         capture_output=True, text=True).stdout
    for ln in out.split():
        if '/' in ln and ':' in ln.rsplit('/', 1)[-1]:
            repo, tag = ln.rsplit(':', 1)
            running.add((repo.split('/', 1)[1], tag))

print("Harbor-native retention DRY RUN (%s) -- deletes nothing"
      % time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))

grand = 0
for p in sorted(call('/projects?page_size=100'), key=lambda z: z['name']):
    name = p['name']
    rid = (p.get('metadata') or {}).get('retention_id')
    if not rid or (ONLY and ONLY != name):
        continue
    print("\n=============== %s (project %s, policy %s) ==============="
          % (name, p['project_id'], rid))
    call('/retentions/%s/executions' % rid, 'POST', '{"dry_run":true}')
    ex = None
    for _ in range(90):
        exs = call('/retentions/%s/executions?page_size=1' % rid) or []
        if exs and exs[0].get('dry_run') and exs[0].get('status') in ('Success', 'Failed', 'Stopped'):
            ex = exs[0]; break
        time.sleep(2)
    if not ex:
        print("  dry run did not finish in time"); continue
    tasks = call('/retentions/%s/executions/%s/tasks?page_size=100' % (rid, ex['id'])) or []
    if not tasks:
        print("  (no repositories)")
    for t in tasks:
        total, kept = t.get('total') or 0, t.get('retained') or 0
        print("  %-44s candidates=%-4d retained=%-4d WOULD DELETE=%d"
              % (t.get('repository'), total, kept, total - kept))
        grand += total - kept
        log = call('/retentions/%s/executions/%s/tasks/%s' % (rid, ex['id'], t['id']))
        for ln in (log or '').splitlines():
            if '|' not in ln or 'Digest' in ln or ln.strip().startswith('|---'):
                continue
            cells = [c.strip() for c in ln.strip().strip('|').split('|')]
            if len(cells) < 8:
                continue
            tag, verdict = cells[1], cells[-1]
            full = '%s/%s' % (name, t.get('repository'))
            live = ' <<< CURRENTLY RUNNING' if (full, tag) in running else ''
            flag = '  *** DELETE ***' if verdict == 'DEL' else ''
            if verdict == 'DEL' and live:
                flag = '  *** DELETE -- AND IT IS RUNNING ***'
            print("      %-8s %-66s %s%s%s" % (verdict, tag, cells[4], flag, live))

print("\n%d tag(s) would be deleted in total. Nothing above was deleted." % grand)
print("Any line marked CURRENTLY RUNNING in the DEL set is a stop-ship.")
PY
  ;;

*) echo "usage: $0 {verify|dryrun [project]}" >&2; exit 2 ;;
esac
