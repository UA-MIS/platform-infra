# Demo-Day Master Runbook — UA-MIS Capstone IDP

**Date of demo:** 2026-07-03 · **Author:** DevOps · **Cluster context:** `admin@capstone` (Talos, real hardware) · **Platform domain:** `capstone.uamishub.com`

This is the single operating document for the full-lifecycle demo. It is an ordered checklist.
Every step is tagged **[HUMAN]** (a person at the keyboard / clicking) or **[AUTO]** (the platform
does it — you narrate and watch). Legend for risk: **SPINE** = must work, rehearsed; **STRETCH** =
show if solid tonight, otherwise narrate as built + show the PR/architecture.

> Golden rule for the demo: **narrate the SPINE while the slow parts (CI build) run**. Never watch a
> progress bar in silence — kick off the build, then switch to ArgoCD/Harbor/Grafana while it churns.

---

## 0. Live reality as of this writing (2026-07-02)

Verified read-only against `admin@capstone`:

| Thing | State |
| --- | --- |
| Platform ArgoCD apps | **40 / 41 Synced+Healthy.** The one exception: `platform-crossplane-runtime` = **OutOfSync/Degraded** (vault `ProviderConfig` missing `spec.address`). **PR #172 fixes exactly this** → 41/41. |
| Backstage ("The Process") | **LIVE.** `platform-backstage-process` Healthy; pods `backstage-*` + `backstage-postgresql-0` Running. |
| Registered scaffolder templates (live catalog) | **7**, served from `platform-services/backstage/catalog/all.yaml`: **New Capstone Project** (golden-path, `recommended`), Python FastAPI API, Next.js Full-stack, React + Express, C# ASP.NET Core API, React Static SPA, New Capstone VM. |
| Deployed tenants | **NONE.** `sample`/`v1check` were deleted. Only namespace `capstone-tenants` exists (the Crossplane XR namespace, empty of claims). The demo builds a tenant from zero — this is the story. |
| Phase-0 Crossplane creds | Done. `crossplane-apis/claims/core` Healthy; only `runtime` is red (→ #172). |

### Live URLs (SSO via GitHub through `id.capstone.uamishub.com`)

| Tool | URL |
| --- | --- |
| The Process (Backstage portal) | https://process.capstone.uamishub.com |
| ArgoCD | https://argocd.capstone.uamishub.com |
| Harbor (registry) | https://harbor.capstone.uamishub.com |
| Grafana (observability) | https://grafana.capstone.uamishub.com |
| SSO / Dex | https://id.capstone.uamishub.com |

---

## 1. Prereqs to green the platform (do TONIGHT)

1. **[HUMAN] Merge PR #172** (`fix/vault-providerconfig-address`). It is `MERGEABLE` but
   `BLOCKED` on `REVIEW_REQUIRED` (branch protection) — it needs one approving review, then merge.
   No CI checks gate it.
   - After merge, ArgoCD auto-syncs. Confirm the flip to green:
     ```bash
     kubectl -n argocd get application platform-crossplane-runtime \
       -o custom-columns='SYNC:.status.sync.status,HEALTH:.status.health.status'
     # expect: Synced   Healthy   (may take 1–3 min; hard refresh in ArgoCD if impatient)
     ```
   - Target: **41/41 Synced+Healthy** on the ArgoCD home screen for the demo.
2. **[HUMAN] Do NOT merge** #154 (wizard — needs a backend image rebuild), #146 (DB draft),
   #173 (preview draft), #120 (draft). They are STRETCH/roadmap only.
3. **[HUMAN] Rehearse the SPINE once, end-to-end, tonight** with a throwaway app name
   (see §2.7). Delete the throwaway before the demo (`make tenant-off TEAM=<slug>` + close/merge
   the PR + delete the repo). Rehearsal is the single biggest risk-reducer — the CI build time and
   the robot-seal steps are where live demos die.

---

## 2. THE RELIABLE SPINE (must work) — full lifecycle, zero → live app

This is the demo's backbone: **portal form → repo → onboard → CI build → ArgoCD deploy → live URL →
show the platform → add a secret.** Rehearse it; time it; know every click.

### 2.1 [HUMAN] Sign in and open the golden-path template
- Browser → https://process.capstone.uamishub.com → **Sign in** (GitHub, via `id.`). You must be a
  **UA-MIS org member** (the scaffolder authors the repo as you).
- Left nav → **Create** → pick **New Capstone Project** (tagged `recommended`, `golden-path`).

### 2.2 [HUMAN] Fill the form (4 real fields) and click Create
| Field | Demo value (example) | Notes |
| --- | --- | --- |
| **App name** | `demo-shop` | DNS-1123 label, ≤30 chars. Becomes repo, workloads, and URL `demo-shop.capstone.uamishub.com`. |
| **Team slug** | `demo-team` | MUST equal a GitHub Team slug; keys namespaces/RBAC/Harbor/OIDC. |
| **Season / Year** | Fall / 2026 | Cohort. |
| Container port | 8080 | default |
| Description / App layout | one line / Single component | Single is simplest for the demo. |

### 2.3 [AUTO] What The Process does in seconds (narrate this — it's the headline)
1. Creates repo **`UA-MIS/demo-shop`** (starter app + `.devops/` contract + thin CI caller).
2. **Creates the Harbor project** `demo-team` (`capstone:harbor-onboard` at scaffold time —
   this used to be a manual step; it is now automatic).
3. Registers the app in the catalog (visible immediately in The Process).
4. **Opens a review-gated onboarding PR** against `UA-MIS/platform-infra` requesting the tenant's
   namespaces/RBAC/quotas (rendered from `tenants/_template`). The PR body is an operator checklist.

> Grant model to say out loud: **previews build immediately; dev/staging/prod deploys wait for a
> reviewer to MERGE the onboarding PR.** A student can *request* infra; a reviewer's merge *grants*
> it — nobody silently mints cluster access.

### 2.4 [HUMAN] Merge the onboarding PR + run the one-time Harbor robot steps
The scaffolder's PR against `platform-infra` carries the exact checklist. From a clone of
`platform-infra` on `main` (post-merge), run these **with `TARGET=real-talos` exactly** (omitting
`TARGET` seals the wrong registry host → push/pull 403 — this cost a failed M1 push once):

```bash
TEAM=demo-team

# 1) Harbor project — idempotent belt-and-suspenders (409 = already exists, fine)
make harbor-onboard NAME=$TEAM TARGET=real-talos KUBE_CONTEXT=admin@capstone

# 2) CI PUSH robot -> sealed `harbor-push` into arc-runners
make harbor-push-robot NAME=$TEAM TARGET=real-talos KUBE_CONTEXT=admin@capstone \
  > /tmp/$TEAM-push.yaml && test -s /tmp/$TEAM-push.yaml \
  && kubectl apply -f /tmp/$TEAM-push.yaml

# 3) per-env PULL robots -> sealed `harbor-pull` into <team>-<env>
for ENV in dev staging prod; do
  make harbor-robot NAME=$TEAM ENV=$ENV TARGET=real-talos KUBE_CONTEXT=admin@capstone \
    > /tmp/$TEAM-pull-$ENV.yaml && test -s /tmp/$TEAM-pull-$ENV.yaml \
    && kubectl apply -f /tmp/$TEAM-pull-$ENV.yaml
done
```
- Merging the PR is what makes ArgoCD create the tenant AppProject + namespaces + ApplicationSet.
- Robots are Harbor-generated one-time tokens; the `test -s` guard prevents committing an empty
  secret on a duplicate-robot 409.

### 2.5 [AUTO] CI builds and pushes the first image
- Any push to the tenant repo's `main` triggers the thin caller
  (`.github/workflows/build-and-push.yaml`) → the central reusable
  **`UA-MIS/platform-infra/.github/workflows/tenant-build.yaml@v1`**.
- Staged: **prepare → (scan + checks) → build-and-push (Kaniko, rootless, on ARC k8s runners) →
  bump-dev** (writes the new image tag into the dev overlay in git).
- **Timing: budget ~5–10 min for the FIRST build** (cold — no layer cache; ARC runner cold-start +
  Kaniko pull of the base image). Watch it in the repo's **Actions** tab.
- **This is the demo's slowest step. Kick it off, then narrate ArgoCD/Harbor/Grafana (§2.6) while
  it runs.** In rehearsal, note the actual time so you can pace the talk.
- Image lands at `harbor.capstone.uamishub.com/demo-team/demo-shop:<12-char-sha>` (tags are
  12-char short SHAs, not 7).

### 2.6 [AUTO/HUMAN] ArgoCD deploys to dev → app is live
- `bump-dev` commits the tag → ArgoCD sees the dev overlay change → syncs the tenant's dev app.
- **[HUMAN]** Show **ArgoCD** (https://argocd.capstone.uamishub.com): the new `demo-team-…-dev`
  Application going Progressing → Healthy. (Hit **Refresh/Sync** if you don't want to wait for the
  poll.)
- **[HUMAN]** Open the live app: **https://demo-shop.capstone.uamishub.com** — the starter app
  responds. This is the "it's real, on the internet" moment.
- **[HUMAN]** Show **Harbor** (the pushed image + its on-push vuln scan) and **Grafana**
  (the tenant's pods/CPU/logs via the kube-prometheus-stack + Loki dashboards).

### 2.7 [HUMAN] Add a secret via the Secrets tab (close the loop)
- In The Process, open the app's page → **Secrets** tab → add a key/value.
- Under the hood: `capstone:seal-secret` writes to **Vault** over ESO (nothing secret in git) and
  commits an `ExternalSecret`. Per-team Vault role is provisioned once via:
  ```bash
  make vault-onboard NAME=demo-team ENV=dev TARGET=real-talos KUBE_CONTEXT=admin@capstone
  ```
  (Run this in the same post-merge batch as the robots if you plan to demo secrets.)
- Narrate: "the student never sees Vault, ESO, or a SealedSecret — they type a value in the portal."

### Rehearsal / throwaway note
Do the entire §2 flow tonight with `demo-team`/`demo-shop-rehearsal`. Tear down after:
`make tenant-off TEAM=demo-team TARGET=real-talos KUBE_CONTEXT=admin@capstone`, delete the repo,
close the PR. Then run the REAL one at demo time (or, safer: run the real onboarding tonight and
demo against an already-warm tenant, doing only a fresh git push to trigger a *fast, cached* rebuild
live — see failure playbook §5).

**SPINE risk assessment:** LOW-MEDIUM. The path is proven (v1 golden-path ran e2e on Talos). The two
live-failure surfaces are (a) **first CI build time/flakiness** — mitigate by pre-warming a tenant so
the live build is cached and fast; (b) **robot seal host-mismatch** — mitigate by using the exact
`TARGET=real-talos` commands above and verifying a push succeeded in rehearsal.

---

## 3. STRETCH items (test tonight; fall back to narration)

For each: the steps if it's solid, and the **fallback narration** if it isn't. Decide GO/NO-GO per
item during tonight's rehearsal and mark it here.

### 3.1 Unified "New Project" wizard (PR #154) — GO / NO-GO: ____
- **What it is:** one wizard, 24 composable stacks (ADR-034), replacing the 7 separate templates.
- **Steps if solid:** it requires a **one-time Backstage backend image rebuild** to ship
  `capstone:compose-project`. That rebuild is NOT done and #154 says *do not merge*. Realistically
  **not demoable live tonight** unless the image is built and rolled.
- **Fallback (recommended):** narrate it as built — show PR #154 + ADR-034, and show the **7 live
  templates already in the Create menu** as the shipped version. Frame the wizard as "the next
  iteration, code-complete, pending an image rebuild." **Risk of live demo: HIGH — default to narration.**

### 3.2 Automatic per-tenant database (PR #146 + db1) — GO / NO-GO: ____
- **What it is:** ADR-033 provider-sql auto-provisions a per-tenant DB.
- **Status:** PR #146 is **DRAFT, marked "do not apply."** Not wired into the live template.
- **Fallback:** narrate as roadmap; show the ADR + PR. The DB-backed templates (Next.js/Prisma,
  .NET/EF, FastAPI) still deploy — just point their DB at the existing db tier if pre-provisioned.
  **Risk of live demo: HIGH — narrate.**

### 3.3 VM app (KubeVirt) + deny-test — GO / NO-GO: ____
- **What it is:** the **New Capstone VM** template (live, registered) stands up a real KubeVirt VM
  as an app (ADR-032) for teams that won't containerize. `platform-kubevirt-operator/-cr` are
  **Healthy** live.
- **Steps if solid:** scaffold from **New Capstone VM** like §2.1–2.4 (layout: vm; uses
  `tenants/_template/vm`). Show the VM running via `kubectl get vmi -A`. Optionally show a NetworkPolicy
  **deny-test** (Cilium-enforced — SEC-011 proved netpols are enforced on this cluster).
- **Fallback:** show the vm-app template in the Create menu + `tenants/_template/vm` manifests +
  ADR-032; state KubeVirt is live (operator Healthy). **Risk of live demo: MEDIUM** — VM boot adds
  minutes; only do it live if you rehearsed the boot time. Otherwise narrate.

### 3.4 Crossplane zero-touch onboarding — GO / NO-GO: ____
- **What it is:** ADR-031 — the scaffolder emits ONE `CapstoneTenant` XR (see
  `tenants/_claims/_example-acme-app.yaml`) and a Composition fans out the whole tenant, **removing
  the human-merged onboarding PR + manual robot steps** of §2.4.
- **Status:** `crossplane-apis/claims/core` are **Healthy**; `runtime` goes green once **#172**
  merges (§1). The template **cutover is documented, NOT applied** (`new-capstone-project/
  CROSSPLANE-CUTOVER.md`); the emit action `capstone:emit-tenant-claim` is **shipped but inert**.
  A hand-applied XR standing up a tenant e2e is the Phase-1 gate and is **not yet proven**.
- **Steps if solid (only if proven tonight):** `cp tenants/_claims/_example-acme-app.yaml
  tenants/_claims/demo-team-demo-shop.yaml`, edit `team/appName/semester`, remove the `_`, commit →
  `platform-crossplane-claims` syncs and the Composition builds the tenant. Show the single XR
  expanding into repo+Harbor+Vault+namespaces.
- **Fallback (recommended):** narrate as the near-term future — show ADR-031, the example XR, the
  `CROSSPLANE-CUTOVER.md`, and the (now-green, post-#172) Crossplane apps in ArgoCD. Contrast "today:
  one review-gated PR" vs "tomorrow: one XR, zero touch." **Risk of live demo: HIGH — narrate, unless
  you prove a hand-applied XR tonight.**

---

## 4. Pre-demo checklist (T-minus 30 min)

- [ ] **[HUMAN]** #172 merged; ArgoCD shows **41/41 Synced+Healthy**. Screenshot as backup.
- [ ] **[HUMAN]** Signed into all five tools (Process, ArgoCD, Harbor, Grafana, id.) in **separate
      browser tabs**, in demo order. SSO sessions warm (no login mid-demo).
- [ ] **[HUMAN]** Throwaway rehearsal tenant torn down; the **real** demo repo name is free
      (no name collision).
- [ ] **[HUMAN]** (Recommended) A **pre-warmed tenant already onboarded** so the live CI build is a
      *cached, fast* rebuild — decide SPINE-live vs SPINE-prewarmed and mark it.
- [ ] **[HUMAN]** `platform-infra` cloned locally on fresh `main`; `make` + `kubeseal` + `kubectl`
      context = `admin@capstone` verified (`kubectl config current-context`).
- [ ] **[HUMAN]** GO/NO-GO decided for each §3 stretch item; PRs/ADRs open in tabs for narration.
- [ ] **[HUMAN]** Network/tunnel sanity: `curl -sI https://process.capstone.uamishub.com` returns
      200/302 (Cloudflare tunnel up).
- [ ] **[HUMAN]** Backup screenshots/recording of a full successful run, in case live networking dies.

---

## 5. Failure playbook (if X breaks live, do Y)

| If this breaks live… | Do this |
| --- | --- |
| **CI build is slow / stuck** (>10 min) | Stop watching. Narrate architecture. Switch to a **pre-warmed tenant** and show its live URL + ArgoCD instead. The build finishing is not required to tell the story. |
| **CI build fails** (scan/checks/push) | Show the Actions log briefly (honest), then pivot to the pre-warmed tenant's green pipeline. Do NOT debug live. |
| **App URL 404 / not ready** | Show ArgoCD Healthy + the pod Running (`kubectl get pods -n demo-team-dev`) instead; the URL propagation can lag — come back to it after Grafana. |
| **Onboarding PR robot step 403 (push/pull)** | Almost always a missing/`TARGET`-wrong seal. Skip live; use the pre-warmed tenant. Fix after demo with the exact §2.4 commands. |
| **`platform-crossplane-runtime` still red** | Cosmetic for the SPINE (SPINE doesn't use Crossplane). Say "one platform add-on mid-rollout," move on. It does NOT affect tenant onboarding. |
| **A stretch item flops** | Instant fallback to its §3 narration + PR/ADR. Pre-decided GO/NO-GO means no live scrambling. |
| **SSO login loop** | Use an already-open warm tab. If all die, use backup screenshots/recording. |
| **Cloudflare tunnel / DNS down** | Fall back to backup recording; optionally `kubectl port-forward` to show the service locally as proof-of-life. |

---

## Appendix — command quick-reference (context `admin@capstone`, `TARGET=real-talos`)

```bash
# Platform health
kubectl -n argocd get applications
kubectl config current-context            # must print: admin@capstone

# Onboard a tenant's Harbor robots (post onboarding-PR-merge)
make harbor-onboard    NAME=<team> TARGET=real-talos KUBE_CONTEXT=admin@capstone
make harbor-push-robot NAME=<team> TARGET=real-talos KUBE_CONTEXT=admin@capstone > push.yaml
make harbor-robot      NAME=<team> ENV=<dev|staging|prod> TARGET=real-talos KUBE_CONTEXT=admin@capstone > pull.yaml
make vault-onboard     NAME=<team> ENV=<env> TARGET=real-talos KUBE_CONTEXT=admin@capstone

# Reversible teardown / re-enable of a tenant
make tenant-off TEAM=<slug> TARGET=real-talos KUBE_CONTEXT=admin@capstone
make tenant-on  TEAM=<slug> TARGET=real-talos KUBE_CONTEXT=admin@capstone
```

Reusable CI: tenant repos call `UA-MIS/platform-infra/.github/workflows/tenant-build.yaml@v1`
(prepare → scan+checks → build-and-push Kaniko → bump-dev). Templates are registered from
`platform-services/backstage/catalog/all.yaml`. Tenant blueprint: `tenants/_template`.
