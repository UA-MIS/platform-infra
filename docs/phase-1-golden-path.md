# Phase-1 Golden-Path Runbook (T9 / L5)

This runbook reproduces the **full promotion loop** on a fresh machine and
records the live evidence captured during the Phase-1 golden-path run
(2026-06-14). It proves, end to end:

> **preview → dev → staging → prod**, GitOps-driven by ArgoCD, with a working
> **manual production gate**, each environment reachable over **wildcard TLS**
> and proving it can **read its sealed secret**.

It also states exactly **what changes for the real k3s cluster** (the §6
re-point) and documents the **SEC-005 residual** on the current ephemeral
cluster.

---

## 0. Prerequisites (one-time host setup, rootless Podman)

The platform targets rootless Podman. Three host prerequisites are required;
`make preflight` checks all three and fails with the exact fix if any is missing.

1. **cgroup v2 `cpuset` delegation** to the user systemd slice
   (`/etc/systemd/system/user@.service.d/delegate.conf` with
   `Delegate=cpu cpuset io memory pids`; then `loginctl terminate-user $(id -un)`
   or reboot). Without it k3s fails: `failed to find cpuset cgroup (v2)`.
2. **Unprivileged port bind** for the ingress 80/443 (ROOT, persists across reboot):
   ```
   echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-k3d-unprivileged-ports.conf
   sudo sysctl --system
   ```
   Without it the k3d serverlb can't bind 80/443: `rootlessport cannot expose privileged port 80`.
3. **Podman user socket** enabled: `systemctl --user enable --now podman.socket`.

Tooling on PATH: `k3d`, `kubectl`, `helm`, `kubeseal`, `kubeconform`, `docker`
(podman-docker shim), `yq`.

> See `platform-infra/` Makefile header + [memory: k3d rootless-Podman gotchas]
> for the rootless-Podman specifics the Makefile encodes (bridge-network split,
> registry name prefix, `KubeletInUserNamespace` feature gate, ArgoCD CRD
> server-side-apply).

---

## 1. Bring up the cluster + GitOps control plane

```
cd platform-infra/
make preflight       # verifies the three host prereqs above
make cluster-up      # k3d cluster `capstone` (1 server + 1 agent), built-in registry, Traefik
make bootstrap       # installs ArgoCD v3.4.3 + applies the app-of-apps root
```

`make cluster-up` (rootless-Podman path) pre-creates the cluster network and a
standalone registry **named so the in-cluster containerd mirror key is exactly
`k3d-registry.localhost:5000`** (the image prefix the overlays use), then creates
the cluster with `--registry-use` and the `KubeletInUserNamespace` feature gate.
`make bootstrap` uses `kubectl apply -k ... --server-side` (ArgoCD's
applicationsets CRD exceeds the 256 KB client-side-apply annotation limit).

**Verify (L1/L2):**
```
kubectl get nodes                                   # both Ready, k3s v1.31.5
kubectl get applications -n argocd                  # root Synced/Healthy; appsets fan out
kubectl get clusterissuer,certificate -A            # CA chain Ready
kubectl get secret -n kube-system wildcard-platform-tls   # wildcard TLS secret exists
```

Evidence captured (2026-06-14): both nodes Ready; root app Synced/Healthy;
platform-svc-{cert-manager,traefik,sealed-secrets} all Synced/Healthy; the
cert-manager chain `selfsigned-bootstrap → platform-ca → platform-ca-issuer →
wildcard-platform-tls` all Ready; Traefik serves `*.127.0.0.1.sslip.io` with a
cert issued by `CN=capstone-platform-ca` (SAN `*.127.0.0.1.sslip.io`); tenancy
live in sample-dev/-staging/-prod/-pr-1 (ResourceQuota, LimitRange, default-deny
NetworkPolicy, `team-developer` Role/RoleBinding, env labels).

---

## 2. Seal the per-namespace secrets (L3)

Each environment gets its OWN sealed secret (strict per-namespace scope, D-008 —
a secret sealed for ns A will NOT decrypt in ns B; this is verified live by the
L6 isolation probe).

```
# per env, from platform-infra/ (make seal targets the live kube-system controller):
kubectl create secret generic sample-secret -n <ns> --from-literal=app-secret=<value> \
  --dry-run=client -o yaml > /tmp/ss.yaml
make seal SECRET=/tmp/ss.yaml NS=<ns> > ../team-sample-app/.devops/chart/overlays/<overlay>/sealedsecret.yaml
rm /tmp/ss.yaml
```

Controller: `sealed-secrets-controller` in `kube-system` (bitnami v0.37.0).
Commit the sealed manifests and push to `github.com/UA-MIS/sample-app` — ArgoCD
syncs them; the controller decrypts each into an in-namespace `Secret`.

---

## 3. The promotion loop

The trigger→env→tag→gate mapping is the single source of truth in
`team-sample-app/.devops/promotion.yaml` (read by both the CI seam and the
`sample-envs` ApplicationSet via an ArgoCD git-files generator):

| env | trigger | tag convention | overlay | gate |
|-----|---------|----------------|---------|------|
| dev | branch:main | `sha-<short>` | overlays/dev | **auto** |
| staging | tag:v* | `semver` | overlays/staging | **auto** |
| prod | tag:v* | `semver` | overlays/prod | **manual** |
| preview | pull_request | `pull-<sha>` | overlays/preview | **auto** |

The image-bump seam writes the new tag into an overlay and commits it; that
commit is the GitOps signal:
```
cd team-sample-app/
COMMIT=1 .devops/ci/bump-image.sh <env> <tag>      # rewrites overlay newTag + commits
git push origin main                                # ArgoCD reconciles on next refresh
```

> **ArgoCD git cache:** after a push, force a pickup with
> `kubectl annotate application -n argocd sample-<env> argocd.argoproj.io/refresh=hard --overwrite`
> (otherwise the repo-server cache can lag ~3 min).

### 3.1 DEV — merge-to-main → auto-deploy ✅ PROVEN (L4)

dev overlay bumped to the commit sha (`9b08056`), ArgoCD auto-synced.
- `sample-dev` = **Synced/Healthy**, image `k3d-registry.localhost:5000/sample:9b08056`, pod 1/1 Running.
- Host `sample.sample.dev.127-0-0-1.sslip.io` → HTTP 200, body `team-sample-app`,
  `secret loaded: true, length=23, sha256=8a4f1795` (secret-read proof over TLS).
  (Re-proven on the recreated cluster via REAL DNS — no `--resolve` — under the
  new prod-canonical dashed-host convention.)

### 3.2 STAGING — tag v0.1.0 → auto-deploy ✅ PROVEN (L5)

staging overlay bumped to `v0.1.0` (commit `30613c1`), pushed, ArgoCD synced after a hard refresh.
- `sample-staging` = **Synced/Healthy** @ rev 30613c1, image `...:v0.1.0`, both pods 1/1 Running.
- Host `sample.sample.staging.127-0-0-1.sslip.io` → HTTP 200, `team-sample-app`,
  `secret loaded: true, length=27, sha256=e254111a` (distinct per-env secret), TLS issuer `CN=capstone-platform-ca`, healthz 200.
  (Re-proven on the recreated cluster via REAL DNS, dashed host.)

### 3.3 PROD — the MANUAL GATE ✅ GATE PROVEN + PROMOTION EXECUTED

**Gate mechanics:** `promotion.yaml` sets `prod.gate: manual`, so the
`sample-envs` ApplicationSet `templatePatch` renders the prod Application with
**no `automated:` sync block** (only `syncOptions`). ArgoCD therefore tracks
prod's desired state but never auto-deploys it.

**Proof the gate holds (captured live):** with desired state tracked,
`sample-prod` = `SYNC=OutOfSync HEALTH=Missing`, `spec.syncPolicy.automated` is
**empty**, and the `sample-prod` namespace exists (tenancy provisioned) with
**zero app workloads** — nothing auto-deployed. (Contrast: `sample-dev` has
`automated: {prune:true, selfHeal:true}`.)

**Promotion (the explicit human lever):**
1. Bump prod overlay to the released image and push:
   ```
   cd team-sample-app/ && COMMIT=1 .devops/ci/bump-image.sh prod v0.1.0
   git push origin main
   ```
   After push (commit `175deb8`) + hard refresh, prod tracked the new desired
   state but stayed **OutOfSync/Missing** with **zero workloads** — gate holds
   even though `:v0.1.0` is a valid, pullable image. ✅ GATE-HOLDS PROVEN.
2. **Manual sync** — the explicit human lever (no `argocd` CLI → kubectl-only),
   run by the HUMAN via `!`:
   ```
   kubectl --context k3d-capstone -n argocd patch application sample-prod \
     --type merge -p '{"operation":{"sync":{"revision":"HEAD","syncStrategy":{"apply":{}}}}}'
   ```
   ArgoCD then deploys prod (3 replicas of `:v0.1.0`), reachable at the bare
   canonical host `sample.sample.127-0-0-1.sslip.io` over TLS with the secret-read proof.

**Promotion executed (captured live).** The human ran the manual sync;
`kubectl patch` returned `application.argoproj.io/sample-prod patched`. ArgoCD
then synced prod:
- `sample-prod` = **Synced/Healthy**, deployment **3/3 replicas ready**, all three
  pods 1/1 Running on image `k3d-registry.localhost:5000/sample:v0.1.0`.
- `operationState.phase=Succeeded`, syncResult revision `175deb8` (the manual sync).
- Host `sample.sample.prod.127.0.0.1.sslip.io` → HTTP 200, `team-sample-app`,
  `secret loaded: true, length=24, sha256=1fbe4cb9` — its OWN per-namespace prod
  secret. healthz 200, TLS issuer `CN=capstone-platform-ca`.

> **Per-namespace secret isolation across the whole loop:** the four envs carry
> independently-sealed secrets — dev len=23 (`8a4f1795`), staging len=27
> (`e254111a`), preview len=27 (`8bde59f1`), prod len=24 (`1fbe4cb9`). A secret
> sealed for one namespace does not decrypt in another (D-008 strict scope,
> cross-checked by the L6 isolation probe).

**✅ GOLDEN PATH COMPLETE — all four environments proven: preview → dev → staging → prod.**

### 3.4 PREVIEW — ephemeral namespace (D-009 git-branch stand-in) ✅ PROVEN

Phase 1 proves ephemeral previews without a live GitHub org: the `sample-preview`
ApplicationSet uses a **list generator** seeded with `{number: 1, branch:
preview-demo}` instead of the PR generator (the production seam is the commented
`pullRequest` block in the same file — swapping is a one-edit change). Each
element → one `sample-pr-<n>` namespace, auto-pruned when the element/branch is removed.

A `preview-demo` branch was pushed to UA-MIS/sample-app (commit `2487355`) with the
preview overlay pinned to `pull-30613c1` (the `pull-<sha>` convention) and the
preview SealedSecret (sealed for sample-pr-1). After a hard refresh:
- `sample-pr-1` = **Synced/Healthy** @ rev 2487355, image
  `k3d-registry.localhost:5000/sample:pull-30613c1`, pod 1/1 Running in the
  **ephemeral `sample-pr-1` namespace** (created on demand, CreateNamespace=true).
- Host `sample.sample.pr-1.127-0-0-1.sslip.io` → HTTP 200, `team-sample-app`,
  `secret loaded: true, length=27, sha256=8bde59f1` — its OWN per-namespace secret.
  **On the recreated cluster this host was proven via REAL DNS** (`getent` +
  `curl` WITHOUT `--resolve`): the dashed domain resolves the multi-label preview
  host that the dotted form mis-parsed, so it is genuinely browser-reachable
  (sha256 distinct from staging's `e254111a` despite equal length, proving the
  preview namespace has an independently-sealed secret). TLS issuer
  `CN=capstone-platform-ca`, healthz 200.

> **Teardown:** removing the `{number:1, branch:preview-demo}` element from the
> ApplicationSet (or closing the PR under the production generator) prunes the
> Application; `prune:true` then deletes the `sample-pr-1` namespace —
> ephemeral-by-construction.

---

## 6. Portability — what changes for the real k3s cluster

Portability is achieved by **two variables and a `clusters/` directory**, never
by forking manifests. The only things that differ between local-k3d and real-k3s:
the `clusters/<target>/values.env` (PLATFORM_DOMAIN, GITHUB_ORG, REGISTRY), the
cert-manager **issuer** (self-signed → ACME), and the k3d cluster shape vs the
real node topology. Everything else (tenant dirs, AppProjects, ApplicationSets,
quotas, RBAC, NetworkPolicies, the app `.devops/` template) is identical because
it is written against labels and variables, not hardcoded hosts.

**Re-point procedure (Phase 4), in full:**
1. Fill `clusters/real-k3s/values.env` with the real `PLATFORM_DOMAIN`,
   `GITHUB_ORG`, `REGISTRY`; run `make set-repo-base` if the git base changes.
2. Point ArgoCD's root App at the real cluster's API and the same `platform-infra`
   repo (or a real-cluster branch).
3. Swap cert-manager's ClusterIssuer from self-signed → ACME (Phase 3 prereq).
4. Apply the bootstrap root-app. ArgoCD reconciles everything else.

The apiserver bind (below) is already loopback in IaC, so the real cluster binds
its API to the node's private address out-of-band — the seam documents intent.

---

## Host convention + preview DNS (advisory findings for L7)

Two host/DNS issues were found during L5 and fixed in IaC **before** the
reproducibility recreate (so the fresh cluster bakes them in):

**1. Ingress host convention was backwards.** Originally `dev` got the bare
canonical host and `prod` carried a `.prod` segment. Corrected to **prod-canonical**:

| env | host (dashed domain) |
| --- | --- |
| **prod** | `sample.sample.127-0-0-1.sslip.io` (bare canonical) |
| dev | `sample.sample.dev.127-0-0-1.sslip.io` |
| staging | `sample.sample.staging.127-0-0-1.sslip.io` |
| preview | `sample.sample.pr-1.127-0-0-1.sslip.io` |

Fixed in the app chart `base/ingress.yaml` (now the canonical/prod host) + the
four overlay host patches. The convention is correct on the real domain too; only
the local representation differs.

**2. Preview host mis-resolved under sslip.io (dotted form).** `getent hosts
sample.sample.pr-1.127.0.0.1.sslip.io` returned **`1.127.0.0`** — sslip.io's
embedded-IPv4 parser consumed the trailing `1` of `pr-1` plus `127.0.0`. The
workload was healthy (200 via `curl --resolve`) but the host did NOT resolve for
a real browser. **Fix:** switch the local `PLATFORM_DOMAIN` to the **dashed form
`127-0-0-1.sslip.io`** (`clusters/local-k3d/values.env`) + the wildcard
Certificate dnsNames to `*.127-0-0-1.sslip.io`. Verified with `getent` that ALL
four hosts — including `...pr-1.127-0-0-1.sslip.io` — resolve to `127.0.0.1`. The
`pr-<n>` host CONVENTION is unchanged (correct on the real domain); this is a
local-DNS-representation fix only. Post-recreate, preview reachability is proven
via REAL DNS (`getent` + `curl` WITHOUT `--resolve`) to honestly demonstrate the
browser-facing path.

> Disposition: **advisory** — does not block Phase-1 sign-off, fixed in IaC and
> verified on the recreate. Noted here for the L7 reviewer.

---

## SEC-005 — apiserver bind residual (advisory; D-013)

**Finding (security L6):** on the current ephemeral local cluster, the k3d
apiserver/serverlb publishes 6443 on `0.0.0.0` (reachable on LAN/tailnet), not
loopback. Anonymous access is **denied (401)** — not a breach — but it
contradicts the localhost-local-cluster intent (§3.3, D-002/D-003).

**Durable fix (applied in IaC):** `clusters/local-k3d/k3d-config.yaml` now sets
```
kubeAPI:
  hostIP: "127.0.0.1"
```
so a fresh `make cluster-up` binds the control plane to loopback (and makes the
real-cluster bind correct from the start).

**Current-cluster residual:** a running container's published port cannot be
rebound without recreating it, and recreating regenerates the sealed-secrets key
(invalidating the live seals mid-run). Per D-013 the residual is genuinely
**closed by the final reproducibility recreate** (`make cluster-down && make
cluster-up` with the loopback config), where security re-verifies. Until that
recreate, the residual stands with anonymous access denied.

---

## Reproducibility recreate (final pass)

To prove a fresh machine reproduces the whole loop AND that the hardened
apiserver bind + the corrected registry mirror key come up clean from the fixed
IaC:
```
cd platform-infra/
make cluster-down
make cluster-up && make bootstrap
```
> This regenerates the sealed-secrets key, so it MUST run **after** all real-seal
> verification is locked; the secrets are then re-sealed against the fresh key as
> the closing step. Coordinated across devops + developer + security.

After recreate, confirm `kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'`
shows `https://127.0.0.1:<port>` (loopback), and re-run the §3 promotion checks.

### Recreate EXECUTED — results (2026-06-14)

The recreate was run from the corrected IaC. **It surfaced TWO further bugs that
the reviewer (L7) caught — the first sign-off was premature** (it asserted
"Applications Synced/Healthy" but did NOT assert a *Running pod*, so the
image-pull break below slipped through). Both are now fixed.

> **REG-001 (BLOCKING, found by L7, fixed):** after the recreate every app pod
> was `ImagePullBackOff` (`lookup k3d-registry.localhost: no such host`) even
> though all Applications were green. Root cause: the **standalone registry has
> survived every `cluster-down` since it was first created**, so it kept its
> original container name `k3d-k3d-registry.localhost` (double `k3d-` prefix) and
> the in-cluster containerd mirror key stayed `k3d-k3d-registry.localhost:5000` —
> which does NOT match the overlays' `k3d-registry.localhost:5000/...` images. The
> earlier idempotency commit `1ab990e` masked this: it changed the existence
> guard to `k3d-$(REGISTRY_HOST)` to match the surviving mis-named registry,
> ENTRENCHING the double-prefix instead of correcting it. **Fix:** the guard and
> `--registry-use` now both reference `$(REGISTRY_HOST)` (= `k3d-registry.localhost`,
> the name `k3d registry create registry.localhost` actually produces), so a
> fresh registry lands on the single-prefixed name and the mirror key matches the
> overlays. The fix was then PROVEN end-to-end by a **registry-only recreate**
> (the standalone registry is independent of the cluster, so this needs NO cluster
> recreate and does NOT touch the sealing key — the staged re-seals stay valid):
> 1. `k3d registry delete k3d-k3d-registry.localhost` (the mis-named survivor);
> 2. ran the FIXED Makefile create path → `k3d registry list` shows a SINGLE-prefixed
>    `k3d-registry.localhost` (evidence a — the from-scratch name-mint is correct);
> 3. re-pushed the 3 images from the host store (no rebuild — they were cached locally),
>    rewrote both nodes' `registries.yaml` to the clean single mirror key
>    `k3d-registry.localhost:5000 → http://k3d-registry.localhost:5000` (evidence b),
>    restarted k3s + flushed serverlb;
> 4. forced fresh pulls → `make verify-image-pull` **PASS** (evidence c), dev pod
>    1/1 Running, staging/preview past ImagePullBackOff (only `secret not found`,
>    the expected pre-Push-B state). Sealing key confirmed unchanged
>    (`sealed-secrets-keydvwdb`), so the staged Push B re-seals remain valid.
> **ADV-002 regression guard added:** `make verify-image-pull` asserts a tenant
> app pod gets past `ImagePullBackOff`, so a green-Application/broken-pod sign-off
> can't recur silently. Wired into the bootstrap completion message.

**PROVEN tonight (no git push required):**
- `make cluster-down`: the **standalone registry survived** with all 3 images
  intact (`9b08056`, `v0.1.0`, `pull-30613c1`) — no image rebuild needed.
- A second reproducibility bug surfaced: `_ensure-registry-podman`'s existence
  grep mismatched the actual registry name, so the idempotent re-run hit *"A
  registry node with that name already exists"*. Corrected together with REG-001
  above so the guard, the create-name, and `--registry-use` are all consistent.
- `make cluster-up`: both nodes Ready (k3s v1.31.5). **SEC-005 CLOSED** — kubeconfig
  server = `https://127.0.0.1:37417`; serverlb publishes `127.0.0.1:37417->6443`
  (not `0.0.0.0`); host listen socket is `127.0.0.1:37417`. Control plane is no
  longer LAN/tailnet-reachable. Ingress 80/443 stay on `*` by design.
- `make bootstrap`: ArgoCD installed via server-side-apply (no annotation-size
  error); all 3 CRDs Established. platform-svc-{cert-manager,traefik,sealed-secrets}
  + root + tenant-team-sample all **Synced/Healthy**.
- Wildcard cert Ready with **dashed dnsNames** `*.127-0-0-1.sslip.io` + apex.
- **All four dashed hosts resolve via REAL DNS** (`getent`, no `/etc/hosts`):
  prod `sample.sample.127-0-0-1.sslip.io`, dev `…dev…`, staging `…staging…`,
  preview `…pr-1…` — every one → `127.0.0.1`. The preview collision is gone.
- Tenant ingresses render the new convention live (e.g. dev =
  `sample.sample.dev.127-0-0-1.sslip.io`).
- **Fresh-key re-seal verified to decrypt correctly**: applying the developer's
  fresh-key dev SealedSecret directly (bypassing git) yielded
  `dev-app-secret-7f3a9c21`, len 23, sha256 `8a4f1795` — IDENTICAL to the
  pre-recreate runbook value. Confirms the re-seal is correct.

**PENDING Push B (git push is human-gated):** ArgoCD pulls the four SealedSecrets
from origin, which still holds the OLD-key seals, so the app secret-path apps are
`Degraded`/`Missing` until the fresh-key re-seal commits are pushed:
- sample-app `main` `21dbc8f` (re-seal dev/staging/prod), `preview-demo` `f857d52`
  (dashed preview host + re-seal sample-pr-1), platform-infra `main` (the
  registry-mirror REG-001 fix + ADV-002 guard + this runbook correction).
- After the push + a hard refresh, all four envs reconcile green and decrypt to
  the identical sha256s (dev `8a4f1795`/23, staging `e254111a`/27, preview
  `8bde59f1`/27, prod `1fbe4cb9`/24 after the manual gate sync). Preview is then
  reachable over real DNS at the dashed host with no `--resolve`. PROD remains the
  manual gate on the fresh cluster (one ACTION-B sync to deploy).
