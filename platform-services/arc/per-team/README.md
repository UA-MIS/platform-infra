# Per-team CI push — multi-tenant ARC (retro #4)

Retires the **shared `harbor-push` last-write-wins hole**: today ONE org-wide scale
set (`ua-mis-kaniko`) mounts ONE secret named `harbor-push` into every team's build
pod (`platform-services/arc/hook-template.yaml`). Each team onboarded re-points that
single secret at its own robot (precedent: #117), so only the **last** team to seal
it can push — and two teams cannot build concurrently with correct creds. The fleet
is effectively single-tenant for pushes.

## The constraint that drives the design

The ARC k8s **container hook does not template the pod-spec per job** —
`runner-container-hooks` reads `ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE` and merges it
verbatim into every job-step pod. There is **no per-job/per-repo substitution**, so a
single static template can only ever name **one** secret. Therefore per-team push
isolation requires **one `gha-runner-scale-set` per team**, each pointing the hook at
its **own** template → its **own** `harbor-push-<team>` secret. The workflow selects
its team's set with `runs-on: <team>-kaniko`.

This is the canonical ARC multi-tenancy pattern; `minRunners: 0` keeps idle cost to a
single tiny listener pod per team.

## Two points on the isolation/footprint spectrum

| | A1 — shared `arc-runners` ns (this template) | A2 — per-team `arc-<team>` ns (hardening target) |
|---|---|---|
| Push secret | `harbor-push-<team>` (per-name, no collision) | `harbor-push` (per-namespace) |
| `arc-github-app` | shared (existing SealedSecret) | per-ns (see ESO below) |
| `platform-ca` / netpol | shared (existing) | per-ns copy |
| Fixes last-write-wins + concurrency | ✅ | ✅ |
| Runner SA can read a sibling team's push secret | ⚠️ yes (shared ns) | ✅ no (ns-confined) |
| New wiring per team | 1 Application + 1 ConfigMap | + ns, github-app, ca, netpol |

**Recommendation:** ship **A1 now** — it closes the retro #4 hole (per-team secrets,
concurrent builds) with the least new wiring and zero new keyboard secrets. Treat
**A2** as the security hardening target for the untrusted-code surface, unblocked by
the ESO github-app delivery below. This is a strategic CI-tenancy decision; raised to
the orchestrator for the A1-now / A2-target call.

> A2's only real cost is a per-namespace `arc-github-app`. SealedSecrets are
> namespace-scoped, so the clean answer is **ESO**: store the org GitHub App creds in
> Vault (`platform/arc/github-app`) once, and give each `arc-<team>` ns an
> `ExternalSecret` that materializes `arc-github-app` (no secret material in git). This
> is the same model as `platform-services/external-secrets/` and feeds track-5's
> Crossplane Composition — see `../../external-secrets/README.md` §Robot-cred → ESO.

## Onboard a team (A1) — render + apply

```bash
# 1. Mint the per-team CI push robot (pull+push on THIS team's Harbor project ONLY)
#    and seal it under the per-team name into arc-runners:
make harbor-push-robot NAME=<team> PUSH_SECRET_NAME=harbor-push-<team> \
  KUBE_CONTEXT=admin@capstone TARGET=real-talos \
  > platform-services/arc/harbor-push-<team>-sealed.yaml

# 2. Render this team's hook-template ConfigMap + scale-set Application:
sed 's/__TEAM__/<team>/g' platform-services/arc/per-team/hook-template.template.yaml \
  > platform-services/arc/hook-template-<team>.yaml
sed 's/__TEAM__/<team>/g' platform-services/arc/per-team/runner-scaleset-app.template.yaml \
  > applicationsets/arc-runner-<team>-app.yaml

# 3. Reference the sealed secret + hook ConfigMap from platform-services/arc/kustomization.yaml
#    (add harbor-push-<team>-sealed.yaml and hook-template-<team>.yaml to `resources`),
#    commit, and let ArgoCD reconcile. The new scale set listener registers as
#    `<team>-kaniko`.
```

Then the team's workflow uses `runs-on: <team>-kaniko` (the scaffolder substitutes
this — `skeleton/.github/workflows/build-and-push.yaml` currently hardcodes
`ua-mis-kaniko`; the M4 template gains a `runs-on: ${{ values.team }}-kaniko` token).

## Migration (do not break the live golden path)

`ua-mis-kaniko` + the shared `harbor-push` stay in place until each team is cut over.
Per team: stand up `<team>-kaniko` (steps above) → flip that repo's `runs-on` →
verify a build pushes → only then drop the team from the shared secret. The shared
set is retired when the last team is migrated. No flag-day.
