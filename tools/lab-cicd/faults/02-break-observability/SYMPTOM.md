# Fault 02 — a naming mismatch between Service and Ingress

## What you'll observe

A PR lands on `main` from course staff (title something innocuous, like
"chore: dependency and config sync"). `git log`/the Actions tab show nothing
alarming — the workflow's build+test steps still pass (this fault doesn't
touch anything CI-visible).

The actual defect is only visible by reading the changed manifests:
`.devops/chart/base/service.yaml`'s `metadata.name` and
`.devops/chart/base/ingress.yaml`'s `spec.rules[].http.paths[].backend.service.name`
no longer agree with what they did before the merge — one of them changed,
the other didn't (or vice versa), and it's not obvious from either file in
isolation that anything's wrong; each file is internally well-formed YAML.

## Where to look

- `git diff` (or `git log -p`) on the fault-delivery commit/PR: which files
  changed, and what exactly moved?
- `.devops/chart/base/service.yaml` — what is `metadata.name`?
- `.devops/chart/base/ingress.yaml` — what does the Ingress's
  `backend.service.name` actually reference?
- Do those two values match? If they don't, anything routing by that name
  (an Ingress, a NetworkPolicy, a ServiceMonitor, a dashboard query) has a
  real chance of silently referencing a name that no longer resolves to the
  Service you'd expect.

This is a "does everything that references a resource by name still agree on
that name" exercise — the same class of bug as a renamed database column
that a downstream report still references by the old name. Nothing has to
crash for this to be a real bug.

## About the live version of this fault

The original design for this fault (see
`artifacts/design/lab-cicd-exercise-design.md` Sec2.5) describes a live
symptom: the app stays up and healthy, but a Grafana Golden Signals dashboard
goes flat/"No data" because the Traefik-derived metrics identifier no longer
matches the renamed Service. **That live behavior does not activate for lab
repos today** — lab repos aren't provisioned with a live deploy path (no
Harbor project, no ArgoCD Application; see
`artifacts/design/lab-live-deploy-fastfollow.md`), so there's no running app
or dashboard to actually observe yet. The git/manifest-level diagnosis above
is the current, honest scope of this fault. It will activate automatically,
with zero changes to this fault, once a live per-team deploy path exists.
