# Fault 02 — answer key (course staff only)

**Status: HELD — not in the initial roster.** See `SYMPTOM.md` for why: this
fault has no observable signal without a live deploy (no Harbor
project/ArgoCD Application exists for lab repos today, D-106). The bug/
concept/fix below are accurate and unchanged; only the "when to use this"
call has changed. Ship faults 01+03 for now; reactivate this one once
`artifacts/design/lab-live-deploy-fastfollow.md`'s live deploy path exists.

## The bug

`fault.patch` renames the Kubernetes `Service` object from `sample` to
`sample-svc` in `.devops/chart/base/service.yaml`, **and** updates the
`Ingress` backend reference in `.devops/chart/base/ingress.yaml` to match
(`backend.service.name: sample-svc`). Routing keeps working end-to-end — the
Service's `selector` (`app.kubernetes.io/name: sample`) is untouched, so it
still matches the Deployment's pods, and the Ingress still points at the
right (renamed) Service. The app stays up and healthy.

This is the deliberately **milder** variant of this fault (see the design
doc, `artifacts/design/lab-cicd-exercise-design.md` Sec2.5, Fault 02): a more
aggressive version leaves the Ingress pointed at the *old* Service name,
which produces a real 502/503 outage. That's not what this fault teaches —
we want a pure observability gap, not an outage, so Ingress and Service are
kept mutually consistent.

The platform's Traefik-based golden-signals dashboards derive their panel
queries from the Traefik-generated service identifier, which is built from
the Kubernetes Service object's name (see
`platform-infra/platform-services/monitoring/dashboard-tenant-golden-signals.yaml`
for the exact query shape in the live cluster). Renaming the Service object
changes that derived identifier, so panels that were tracking the old name no
longer match live traffic — even though the app never stopped serving
requests, because Kubernetes/Traefik routing doesn't care what a Service is
*named*, only what it *selects*.

## The concept (what this teaches)

Two independent systems can both be "correct" in isolation and still produce
a broken result together: the Ingress→Service routing is internally
consistent (it works), and the dashboard's query is internally consistent
(it's a well-formed query) — but the two were never re-synchronized after a
rename. This is the same class of bug as a renamed database column that a
downstream report still references by the old name: nothing *fails*, some
downstream consumer just silently stops seeing what it expects.

The bigger lesson: "the dashboard is red/empty" is not the same claim as
"the app is down." Check the app's actual health independently before
trusting a dashboard's absence-of-data as a health signal — and when you
find a naming mismatch like this, the fix is to make renames a package deal,
not just a Service edit.

## The fix

Either:
- **Don't rename the Service at all** — revert to `name: sample` in both
  `service.yaml` and `ingress.yaml` (this is what the shipped `fault.patch`'s
  inverse does), or
- If a rename really is wanted, propagate it everywhere something derives an
  identifier from the Service's name — the Ingress backend (already handled
  by this patch) plus whatever the live dashboard's query variable/regex
  assumes (platform-side, out of scope for an in-repo fix — flag it to course
  staff if your dashboard's assumed convention needs updating too).

## Verifying recovery

1. `git revert` the fault commit (or hand-apply the inverse of `fault.patch`).
2. Confirm `.devops/chart/base/service.yaml`'s `metadata.name` and
   `.devops/chart/base/ingress.yaml`'s `backend.service.name` are both back
   to `sample` and agree with each other again.
3. Confirm CI (build+test) is still green on the revert commit — this fault
   never broke a test or a build, so recovery shouldn't change that either.

**Live version (once a lab deploy path exists — see
`artifacts/design/lab-live-deploy-fastfollow.md`):** additionally confirm
the app is still reachable (`curl .../healthz`) and that the dashboard's
Request Rate / Error Rate / Latency panels resume showing non-zero data
within one or two Prometheus scrape intervals after generating a small burst
of real traffic. Not checkable at today's git/CI-only fidelity.
