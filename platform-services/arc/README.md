# ARC — self-hosted GitHub Actions runners (P2.3, §1.3, D-032)

The platform CI engine: **GitHub Actions + Actions Runner Controller (ARC) +
Kaniko**, runners on our own cluster (no GitHub-hosted minutes), pushing to Harbor.
Modern **scale-set** ARC (`gha-runner-scale-set`), NOT the legacy summerwind CRDs.

- Controller: `gha-runner-scale-set-controller` **v0.14.2** (pinned OCI chart),
  `applicationsets/arc-controller-app.yaml` → ns `arc-system`.
- Runner scale set: `gha-runner-scale-set` v0.14.2,
  `applicationsets/arc-runner-scaleset-app.yaml` → ns `arc-runners`. Org-scoped to
  UA-MIS, **ephemeral, scale-from-zero** (`minRunners: 0`, `maxRunners: 3`).
- Isolation: `hardening/netpol-runners/` (manual-sync, the security gate).
- OCI chart registry allowlisted in `bootstrap/platform-appproject.yaml`
  (`ghcr.io/actions/actions-runner-controller-charts`) — install-owned, re-apply
  after merge (`make bootstrap-reapply`).

## containerMode: kubernetes (the rootless / no-docker-socket model)
Workflow job steps run as **separate Kubernetes pods**, not inside a privileged
dind container. No docker daemon, no docker socket, not privileged — exactly what
**Kaniko** (rootless image builds) needs, and the foundation of runner isolation.

## ⚠ Runner isolation — THE headline security gate (security signs this off)
Self-hosted runners execute **untrusted student PR code**, so `arc-runners` is the
highest-risk surface on the platform. Controls:
- **Pod security** (`arc-runner-scaleset-app.yaml` template): non-root (uid 1001),
  `allowPrivilegeEscalation: false`, drop **ALL** caps, seccomp `RuntimeDefault`,
  no privileged, no docker socket.
- **NetworkPolicy** (`hardening/netpol-runners/runner-netpol.yaml`, manual-sync):
  default-deny; egress only DNS + in-cluster services (10.43/16, incl. the
  `kubernetes` API Service for containerMode pod creation + Harbor) + external
  HTTPS:443 (GitHub). **The apiserver on the node IP (10.89/24:6443) and all
  cross-tenant pod ranges (10.42/16) are BLOCKED** — a runner cannot reach the
  apiserver directly or another team's pods.
- Enforce via the watched `argocd app sync platform-netpol-runners` (NOT
  auto-applied — see the Application header); verify a real build still
  clones+pushes AND a runner cannot reach the apiserver/other tenants.

## GitHub App (the runner credential — human creates this once)
The scale set authenticates to GitHub via a **GitHub App** (preferred over a PAT:
fine-grained, org-owned, rotatable). One-time human steps:
1. Create a GitHub App in the **UA-MIS** org with permissions: **Self-hosted
   runners: Read & write** (org), **Actions: Read**; install it on the org.
2. Note `App ID` + `Installation ID`; generate + download a private key (.pem).
3. Build the Secret + seal it into `arc-runners`:
   ```bash
   kubectl create secret generic arc-github-app -n arc-runners \
     --from-literal=github_app_id=<APP_ID> \
     --from-literal=github_app_installation_id=<INSTALLATION_ID> \
     --from-file=github_app_private_key=<path/to/key.pem> \
     --dry-run=client -o yaml \
   | make seal NS=arc-runners > platform-services/arc/sealedsecret-github-app.yaml
   # then uncomment sealedsecret-github-app.yaml in kustomization.yaml + commit.
   ```
The scale set's `githubConfigSecret: arc-github-app` references it. Until it exists
the listener can't auth (the app shows Progressing) — expected pre-credential.

## CI ↔ workflow contracts (coordinated with the developer)
- **`runs-on` = the scale-set name** (this is how the scale-set model works — the
  workflow selects the set by its name). Current: **`runs-on: ua-mis-kaniko`**
  (the `releaseName` in `arc-runner-scaleset-app.yaml`). Change both sides together.
- **Harbor PUSH credential** (separate from the workload PULL robot): CI pushes with
  a per-team **push** robot scoped to **only the team's own Harbor project** (least
  privilege — it must not push to other teams' projects). Secret **`harbor-push`**
  (dockerconfigjson), registry `harbor.capstone.uamishub.com/<name>/<app>:<tag>`, robot
  `robot$<name>+ci-push`, consumed by Kaniko at `/kaniko/.docker/config.json`.
  Provisioned by **`make harbor-push-robot NAME=<name> [RUNNER_NS=arc-runners] >
  harbor-push-sealed.yaml`** — mints a robot with **pull+push on project `<name>`
  ONLY** (least privilege; can't push to other teams' projects) and seals it as
  secret `harbor-push` into the runner namespace.
  - **CONSUMPTION = OPTION C (container-hook).** In `containerMode: kubernetes` the
    build runs in its own job-step pod (ARC requires job containers in k8s mode), so
    a secret on the runner pod is invisible to it. `hook-template.yaml` (the
    `arc-hook-template` ConfigMap) is merged by the k8s container hook into every
    job-step pod, landing `harbor-push` inside the build container at
    **`/kaniko/.docker/config.json`** — so the workflow needs **zero** cred-handling
    steps; Kaniko finds it. The cred is projected ONLY into the build container,
    never onto the general runner pod (untrusted non-build steps can't read it).
    Wired via `ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE` in
    `applicationsets/arc-runner-scaleset-app.yaml`.
  - **⚠ SHARED secret = last-write-wins (retro #4).** Today this is the ONE
    `harbor-push` secret for the ONE org-wide `ua-mis-kaniko` set, so only one team's
    push cred is live at a time. The **per-team** model (one scale set per team, each
    hook-template → its own `harbor-push-<team>`, `runs-on: <team>-kaniko`) is designed
    in **`per-team/README.md`** — the container hook can't select a secret per job, so
    isolation requires per-team scale sets.

## CI node placement + visibility (2026-09-09)
Both the RUNNER pod (`applicationsets/arc-runner-scaleset-app.yaml` +
per-team/Crossplane equivalents) and the Kaniko BUILD step pod
(`hook-template.yaml` + per-team/Crossplane equivalents) **require**
`capstone.io/ci-build=true` OR `capstone.io/ci-build-emergency=true` — bare
`capstone.io/pool=build` is no longer sufficient. This was promoted from a soft
`preferred` (weight 100) to a `required` term because the scheduler's
least-allocated scoring kept placing builds on `capstone-w1` (100 Mbit NIC)
despite the soft preference, causing intermittent `npm ci` ETIMEDOUT failures
inside Kaniko builds. See `docs/operator/debian-worker-onboarding.md` §6.1.1 for
the operator-facing label procedure and the reversal step, and
`applicationsets/arc-runner-scaleset-app.yaml` for the full evidence/rationale.

⚠ `capstone.io/ci-build=true` is a **live-only, hand-applied label** — no node
manifest in this repo sets it. If it is ever removed from every build-pool node
(e.g. the labelled node is decommissioned with no replacement labelled), CI
**queues loudly** in GitHub Actions rather than falling back anywhere
automatically — relabel a fast node promptly. There is deliberately **no
automatic control-plane fallback**: `capstone-n1/n2/n3` run etcd off the same
writable `/var` partition the CI work volume uses, the Kaniko build container's
CPU is unbounded, and `capstone-n2` is a known thermal outlier (~88–91°C,
pending a repaste) — heavy build I/O there risks destabilizing the control
plane, not just slowing a build. `capstone.io/ci-build-emergency=true` is an
**opt-in-only** escape hatch (never set by default) an operator can apply to
any node, including a control plane one, if they judge a genuine incident
justifies that risk — see `docs/operator/debian-worker-onboarding.md` §6.1.1.

Every job's "Set up job" log prints `CI runner node: <node-name>` via the
runner's own `ACTIONS_RUNNER_HOOK_JOB_STARTED` pre-job hook (a GitHub
self-hosted-runner feature, distinct from `ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE`
above) — see `configmap-job-started-hook.yaml`. This makes node placement visible
directly in the GitHub Actions UI with no workflow-file change, so a future
placement-related failure doesn't require correlating pod timestamps after the
fact.

## Resource posture (local k3d)
`minRunners: 0` + `maxRunners: 3` + per-runner requests/limits (250m/512Mi →
2cpu/2Gi) are **values knobs** — they cap a Kaniko build burst from OOMing the
laptop and scale up on real hardware (Phase-4). Box has ample headroom
(24c/62Gi/931G).

## Incident 2026-09-25 → 2026-09-28 — controller freeze root cause + fix

Two real contributing causes were fixed first (chart/Application changes,
merged in #693, don't redo): the controller's VPA was `updateMode: Auto` on a
single-replica Deployment (an eviction mid-reconcile truncated a
delete/recreate and permanently stripped a scale set's `runner-scale-set-id`
annotation), and ArgoCD's `selfHeal` + `ServerSideApply` had no
`ignoreDifferences` on `AutoscalingRunnerSet` `/metadata/annotations`, so it
was stripping the controller's own registration annotations back out and
making the controller think a healthy scale set was "outdated". Both fixed;
see the VPA policy (`platform-services/vpa-policies/edge-and-controllers-vpa.yaml`)
and the `ignoreDifferences` block present in all three places a runner scale
set is rendered (`applicationsets/arc-runner-scaleset-app.yaml`,
`platform-services/arc/per-team/runner-scaleset-app.template.yaml`,
`platform-services/crossplane/apis/composition.yaml`).

**The actual root cause survived both fixes**: the pinned runner image,
`ghcr.io/actions/actions-runner:2.335.1`, had aged into a **GitHub-side
deprecated runner version**. GitHub deprecates old `actions-runner` releases on
a rolling few-month window; a deprecated runner's broker poll comes back
`403 Runner version vX.Y.Z is deprecated and cannot receive messages`, the
runner pod exits, and the `EphemeralRunnerSet` cycles 1→0 with no job ever
served. That scale-to-zero-with-no-service transition is what flips the
`AutoscalingRunnerSet` into `status.phase: Outdated` on almost every
reconcile — confirmed against `actions/actions-runner-controller` issues
[#4595](https://github.com/actions/actions-runner-controller/issues/4595),
[#4596](https://github.com/actions/actions-runner-controller/issues/4596), and
[#4608](https://github.com/actions/actions-runner-controller/issues/4608)
(all open, unfixed upstream as of chart `0.14.2`, still the latest chart
release — **there is no chart/controller version to upgrade to**; the fix is
the runner image tag, not the Helm chart), and the exact failure mode reported
independently in
[actions/runner#4392](https://github.com/actions/runner/issues/4392) and
[actions/runner#3767](https://github.com/actions/runner/issues/3767). This
repo already carried a comment recording the identical symptom once before
(`2.328.0 deprecated by GitHub — couldn't connect to the broker`, bumped to
2.335.1) — that bump was never revisited and 2.335.1 silently aged into the
same state.

Why one deprecated runner froze the **entire** controller, not just its own
pool: the `autoscalingrunnerset` controller runs a single reconcile worker
(`Starting workers ... worker count: 1` at controller startup — confirmed live
in this cluster's own logs). The `DeleteRunnerScaleSet` call the controller
makes against the Actions service as the last step of tearing down an
`Outdated` scale set is not guarded by a request-scoped timeout in this chart
version; against a scale set already in the broken broker-403 state that call
can block indefinitely, and because there is only one worker, that one blocked
call halts reconciliation for **every** `AutoscalingRunnerSet` in the cluster,
not just the wedged one — matching this incident exactly: two independent
17h/31h total-CI-outage events, each ending on `deleting runner scale set` as
the last log line, and a live re-freeze observed on 2026-09-28 within
seconds of a manual controller restart (`mychef-kaniko` then `ua-mis-kaniko`,
both already in the broken state, both hung the next reconcile immediately).

**Fix applied**: bump the pinned runner image to `2.337.0` (current latest
`actions/runner` release, un-deprecated) in all three render sites, listed
above. Bump this **proactively** going forward — don't wait for the symptom —
and watch the new `ARCReconcileStale` / `ARCControllerDown` alerts
(`platform-services/monitoring/alerts-arc.yaml`).

**Stop-the-bleeding steps taken live in-cluster before this PR** (not yet
reflected in git until merge): `platform-arc-runner-mychef` and
`platform-arc-runner-scaleset` (ua-mis) had `syncPolicy.automated` cleared and
their broken `AutoscalingRunnerSet` objects deleted, mirroring the existing
`curb` safe-state, to stop the controller from re-entering the freeze while
the fix above was being prepared and verified. All three are restored under
the fixed runner image (see rollback plan in the PR description) with
automated sync re-enabled once verified against a deliberate delete/recreate
cycle.

### A second, SEPARATE, still-open bug — honest disclosure

Verification surfaced a second bug in this same controller version that the
runner-image fix does **not** touch and did **not** cause. After a scale set
processes a real job and scales back to 0, the `AutoscalingRunnerSet` can flip
to `status.phase: Outdated` and **never recover on its own** — reproduced live,
repeatedly, this session, on `ua-mis-kaniko`, `curb-kaniko`, `mychef-kaniko`,
and `ida-llm-kaniko` (the last of those untouched for 40+ minutes beforehand,
so this is not an artifact of the live testing above). This is
[actions/actions-runner-controller#4596](https://github.com/actions/actions-runner-controller/issues/4596)
/ [#4595](https://github.com/actions/actions-runner-controller/issues/4595) /
[#4608](https://github.com/actions/actions-runner-controller/issues/4608) — all
open upstream, no fix released as of chart `0.14.2` (still current). Recovery
is the workaround documented on #4596:
```
kubectl -n arc-runners patch autoscalingrunnerset <name> \
  --subresource=status --type=merge \
  -p '{"status":{"phase":"Pending","currentRunners":0,
       "pendingEphemeralRunners":0,"runningEphemeralRunners":0}}'
```
**Why this is a materially smaller problem than the outage this PR fixes**: the
flip happens to ONE object, after its job already ran (confirmed — the
`ua-mis-kaniko` job proof below completed successfully before that scale set
later flipped), and it does not block any other `AutoscalingRunnerSet`'s
reconcile — every other pool kept working throughout. That is the direct
payoff of removing the deprecated-runner trigger: the SAME upstream "stuck in
Outdated" behavior no longer has a path to freeze the single shared reconcile
worker and take down all 8 pools with it — worst case now is one pool
queuing jobs until someone (or an alert) notices and runs the one-line patch
above, not a 31-hour blackout.

**Known gap**: `ARCReconcileStale` (below) does **not** catch this — a
stuck-in-Outdated object isn't an active reconcile hogging the worker, it's a
reconcile that finished and never got re-triggered, so
`workqueue_longest_running_processor_seconds` stays at 0. Catching this
properly needs the object's `.status.phase` as a metric, e.g. a
kube-state-metrics `CustomResourceState` config for `AutoscalingRunnerSet`
(the same mechanism `platform-services/monitoring/crossplane-mr-metrics.yaml`
already uses for the 11 Crossplane MR kinds) alerting on
`phase="Outdated"` persisting past a few minutes. Left as a follow-up, not
bodged into this PR — flagging it explicitly rather than shipping a
false sense of complete coverage.
