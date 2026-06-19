# UA-MIS Capstone IDP — Operations & Handoff Manual

> **Audience:** the next capstone student, faculty member, or successor administrator who
> inherits this platform. Moderate Kubernetes knowledge assumed; **no prior context on this
> build** assumed. This is the single document you should be able to operate the platform from.
>
> **Status of this doc:** written 2026-06-18 against the live 3-node Talos cluster. Where the
> platform is mid-transition (the Cilium CNI swap, the public-domain cutover), this manual says
> so plainly and points at the open PRs. Treat memory-derived "gotchas" as hard-won lessons, but
> verify a command against the live cluster before trusting it blindly.
>
> **The one thing that must not be lost:** the *org-owned credentials* in §5. If those are tied
> to a graduating student's personal accounts, the platform dies at graduation. Read §5 first.

---

## Table of contents

1. [What this is](#1-what-this-is)
2. [Architecture](#2-architecture)
3. [Access — how to reach everything](#3-access)
4. [Day-2 operations](#4-day-2-operations)
5. [CONTINUANCE — what a successor must own](#5-continuance)
6. [Current state & pending work](#6-current-state--pending-work)
7. [Troubleshooting / gotchas](#7-troubleshooting--gotchas)
8. [Appendix — decision-log index & glossary](#8-appendix)

---

## 1. What this is

This is an **Internal Developer Platform (IDP)** for University of Alabama MIS capstone teams.
It is the self-service infrastructure on which student teams build, deploy, and run their capstone
applications, the same way an industry platform team serves product teams.

A capstone team gets, with **no cluster access and no kubectl**:

- A **git-driven deploy pipeline**: push code → CI builds an image → ArgoCD deploys it.
- **Four environments** per app: `preview` (per-PR), `dev`, `staging`, `prod` — with a
  **PM-clickable approval gate** in front of prod (no CLI).
- **Single sign-on** with their GitHub identity (UA-MIS org membership), across every platform tool.
- **Isolation**: their own namespaces, resource quotas, RBAC, and (once the CNI swap lands)
  enforced network policy — one team cannot see or touch another's workloads.
- A **stable URL** for each app.

### Why it exists

Capstone teams historically lost time to environment setup, "works on my machine" drift, and
ad-hoc deployment. The IDP makes the **paved road** (git push → running app, persistent storage,
secrets, SSO) the *easy* road, so students spend their semester on their product, not on YAML —
while getting genuine exposure to industry-standard tooling (Kubernetes, GitOps, OCI registries,
SSO, CI runners).

### The hardware, in one line

The platform runs on **3× Dell OptiPlex 7080 Micro PCs** running **Talos Linux** as a
hyperconverged Kubernetes cluster, plus a separate **database tier** host. It is designed to run
in a single apartment/lab today and scale to ~15 boxes on campus later, **by adding boxes, not
upgrading them** (D-031, D-035).

### Two halves of the platform (important mental model)

| Half | Who owns it | Where it lives |
| --- | --- | --- |
| **Platform** (this) | the platform admin (you) | `UA-MIS/platform-infra` repo — *the single source of truth* |
| **Apps** | each student team | `UA-MIS/team-<name>-app` repos (a `.devops/` template wires them in) |

ArgoCD continuously reconciles the cluster to match `platform-infra`. **You change the platform by
merging a PR to that repo, not by running `kubectl` against the cluster.** That discipline (GitOps)
is what makes the whole thing reproducible and recoverable.

---

## 2. Architecture

### 2.1 The stack at a glance

```
                          ┌─────────────────────────────────────────────────────────┐
   GitHub (UA-MIS org)    │            ualaims TAILSCALE TAILNET (overlay)          │
   ├ platform-infra ──────┼──► ArgoCD (GitOps reconciler, app-of-apps)              │
   ├ team-<name>-app  ────┼──► ARC runners ──► Kaniko build ──► Harbor (registry)   │
   └ OAuth app (SSO) ─────┼──► Dex (OIDC broker) ◄── ArgoCD / Harbor / Backstage    │
                          │                                                          │
   (Phase-3, planned)     │   ┌──────────────── 3× OptiPlex 7080 (Talos) ────────┐  │
   Cloudflare Tunnel ─────┼──►│  capstone-n1   capstone-n2   capstone-n3         │  │
   capstone.uamishub.com  │   │  CP+etcd       CP+etcd       CP+etcd (bootstrap)  │  │
                          │   │  Cilium eBPF CNI (kube-proxy replacement)        │  │
                          │   │  Rook-Ceph OSD Rook-Ceph OSD Rook-Ceph OSD       │  │
                          │   │       └────── Ceph replica-3 (ceph-block SC) ────┘  │
                          │   └──────────────────────────────────────────────────┘  │
                          │                                                          │
                          │   ua-mis-db-1 (Debian; Postgres 17 + MariaDB 11.8) ◄─────┘  off-cluster DB tier
                          └─────────────────────────────────────────────────────────┘
```

### 2.2 Components & responsibilities

| Layer | Component | Version (live) | Responsibility | Decision |
| --- | --- | --- | --- | --- |
| Node OS / k8s | **Talos Linux** | v1.13.4 / k8s **v1.31.5** | Immutable, API-only node OS (no SSH); 3-node converged HA control plane + etcd quorum | D-024/ADR-017, D-035, **D-040** |
| CNI | **Cilium** (swapping in) | 1.17.4 | eBPF dataplane, `kubeProxyReplacement`, **NetworkPolicy enforcement** | D-036 (swap), PR #42 |
| Storage | **Rook-Ceph** | chart **v1.19.7** (Ceph v20.2.1) | replica-3 block storage; `ceph-block` default StorageClass | D-037 |
| GitOps | **ArgoCD** | upstream install | Reconciles the whole platform from `platform-infra` (app-of-apps) | T3, D-012 |
| Registry | **Harbor** | chart v1.19.x | Per-team OCI image registry, Trivy scan-on-push, OIDC login | D-028 |
| SSO broker | **Dex** | v2.45.1 | One OIDC broker → GitHub-org (UA-MIS) membership/team gating; all tools federate to it | D-017 |
| CI | **ARC** (Actions Runner Controller) | gha-runner-scale-set v0.14.x | Self-hosted GitHub Actions runners; **rootless Kaniko** builds (no docker socket) | D-022/D-032 |
| Overlay | **Tailscale** | system extension | The network fabric: stable `100.x` addressing across apartment/campus; DERP relay fallback | D-035 |
| Ingress | **Traefik** | bundled | Host-header routing to apps/services | D-010 |
| Certs | **cert-manager** | — | TLS; Phase-3 → Let's Encrypt DNS-01 (DigitalOcean) for `*.capstone.uamishub.com` | D-036 |
| Secrets (bootstrap) | **Sealed Secrets** | bitnami | Encrypts secrets safe to commit to git; the sealing key is a **root secret** | D-006 |
| Secrets (runtime, planned) | **Vault + ESO** | not deployed | Keyless per-team dynamic secrets via ServiceAccount → Vault → ExternalSecret | D-018/D-019 |
| Public access (planned) | **Cloudflare Tunnel** (`cloudflared`) | app present, Degraded | Outbound-only public reachability for `capstone.uamishub.com`; no inbound ports | D-023/D-036 |
| Data tier | **PostgreSQL 17 + MariaDB 11.8** on `ua-mis-db-1` | Debian | Off-cluster, shared multi-tenant relational DB (one DB+role per team); Patroni HA after db-2 | D-029 |

### 2.3 How they fit (the request flows)

**Deploy flow (a student ships code):**
1. Student opens a PR / merges to `main` in `team-<name>-app`.
2. A GitHub Actions workflow runs on an **ARC self-hosted runner** in-cluster (no GitHub minutes).
3. The workflow builds the image **rootless with Kaniko** (no privileged docker daemon) and pushes
   to the team's **Harbor** project (`harbor.../<name>/<app>:<tag>`), Trivy-scanned on push.
4. The workflow bumps the image tag in the app's `.devops/promotion.yaml` (the one editable seam).
5. **ArgoCD** sees the change and reconciles the team's namespaces to the new image. Non-prod tracks
   `main` automatically; **prod is pinned to an immutable `vX.Y.Z` tag** and only moves after a PM
   clicks **Approve** in the team's GitHub Environment (D-020/D-030).

**Login flow (SSO):**
- User clicks "Log in with GitHub" on ArgoCD/Harbor/etc. → tool redirects to **Dex** → Dex redirects
  to **GitHub** → GitHub confirms the user is in the **UA-MIS** org and which teams → Dex issues
  tokens carrying `UA-MIS:<team-slug>` group claims → the tool maps that group to a scoped RBAC role.
- Only **one** GitHub OAuth app (registered self-service in UA-MIS) backs everything.

**Storage flow:** a PVC with no StorageClass gets the default `ceph-block`; Rook-Ceph provisions an
RBD volume replicated across all 3 nodes (survives one node loss).

### 2.4 The single most important convention: one slug everywhere (D-026)

A team's identifier is **one kebab-case slug** (`<name>`, e.g. `walmart-s26`) used *identically*
as: the GitHub Team slug, the Dex OIDC group suffix (`UA-MIS:<name>`), the ArgoCD AppProject name,
the namespace prefix (`<name>-dev` / `-staging` / `-prod` / `-pr-N`), the Harbor project, the Vault
path, and the app's hostname label. **Never a `team-` prefix.** ArgoCD RBAC matches `<project>/<app>`,
so any divergence makes the team's scoped role silently inert (this was bug SEC-006). `make validate`
guards it.

### 2.5 Domain map (the platform's bounded contexts)

| Domain | Components | Notes |
| --- | --- | --- |
| `cluster-substrate` | Talos configs (`clusters/real-talos/`), Cilium, etcd, Tailscale | The node/CNI/overlay layer; talhelper-managed, out-of-band of GitOps |
| `gitops-core` | `bootstrap/`, ArgoCD install, app-of-apps root, AppProjects | The reconciliation root; partly install-owned (see §7) |
| `platform-services` | `platform-services/*` + matching `applicationsets/*` | ArgoCD-managed cluster services (Harbor, Dex, Rook, ARC, cert-manager, …) |
| `tenancy` | `tenants/_template`, `tenants/team-*`, `tenants-appset` | Per-team namespaces/quota/RBAC/netpol, generated from the team list |
| `ci` | `platform-services/arc`, `applicationsets/arc-*`, harbor robots | ARC runners, Kaniko, harbor-push isolation |
| `storage` | `platform-services/rook-ceph`, `applicationsets/rook-ceph-*` | Ceph operator + cluster + StorageClass |
| `data-tier` | `ua-mis-db-1` (off-cluster), `docs/db-tier-runbook.md` | Postgres/MySQL, not a k8s node |

---

## 3. Access

### 3.1 The overlay: Tailscale (`ualaims` tailnet)

Everything is reachable over the **`ualaims` organization Tailscale tailnet**. Nodes joined as
**tagged devices** (`tag:talos-node`) using a reusable, non-ephemeral auth key. The human's personal
devices are separate "user devices." This is what gives the cluster stable addressing
(`100.x` IPs) regardless of the underlying DHCP network — apartment or campus.

- **To get on the tailnet:** be added to the `ualaims` tailnet (an admin invites you), install
  Tailscale, `tailscale up`. After that, the nodes and DB host are reachable by their `100.x` IPs.
- **Tag cap awareness:** the Tailscale free plan allows **50 tagged devices**. Talos's converged
  1-node-per-box model uses one tag per box, so ~15 boxes at full scale stays well under the cap
  (this efficiency was a factor in choosing Talos over Proxmox — D-040). Team workloads do **not**
  consume slots (reached via node routes, not as tailnet devices).
- **LAN lifeline:** all 3 nodes are also on the lab LAN (`10.237.171.5/.6/.8`). If Tailscale ever
  breaks, you can still reach a node on the same switch by its LAN IP — see the talosctl note below.

### 3.2 Node IPs (live, 2026-06-18)

| Node | Role | LAN IP | Tailscale `100.x` | Notes |
| --- | --- | --- | --- | --- |
| `capstone-n1` | control-plane (converged) | `10.237.171.5` | `100.120.67.119` | |
| `capstone-n2` | control-plane (converged) | `10.237.171.6` | `100.89.87.126` | |
| `capstone-n3` | control-plane (converged) | `10.237.171.8` | `100.117.55.70` | **bootstrap/etcd-init node; apiserver endpoint is pinned here** (D-038) |
| `ua-mis-db-1` | off-cluster DB tier | — | `100.114.172.94` | `ssh db1`; Postgres 17 + MariaDB 11.8 |

> The Tailscale `100.x` addresses can change if a node is re-keyed. Confirm with `tailscale status`
> or the tailnet admin console before relying on a specific one. The **apiserver endpoint is pinned
> to n3** (`https://100.117.55.70:6443`) — losing n3 currently loses the API endpoint (single-endpoint,
> not HA; certSANs already cover all 3 nodes so widening to HA needs no cert re-issue — D-038).

### 3.3 Tools: kubectl, talosctl, k9s

**Config file locations (these belong in the handoff vault — see §5):**

| File | What | Used by |
| --- | --- | --- |
| `clusters/real-talos/clusterconfig/talos-kubeconfig` | cluster-admin kubeconfig (context `admin@capstone`) | `kubectl`, `k9s` |
| `clusters/real-talos/clusterconfig/talosconfig` | Talos machine-management config | `talosctl` |
| `~/.config/sops/age/keys.txt` | **age PRIVATE key** — decrypts `talsecret`/`talenv` | `sops`, `talhelper` |

> ⚠ **The kubeconfig and talosconfig are gitignored under `clusterconfig/`** and must never be
> committed (a prior leak put cluster CA keys + an admin kubeconfig on the public repo — fully
> remediated/re-keyed, but the lesson stands; see §7).

**kubectl / k9s (read-only is safe; writes go through GitOps):**
```bash
export KUBECONFIG=/path/to/platform-infra/clusters/real-talos/clusterconfig/talos-kubeconfig
kubectl get nodes -o wide
kubectl -n argocd get applications
k9s   # picks up $KUBECONFIG
```
> The operator's workstation shell is **fish**, where `export VAR=value` **silently fails**. In fish
> use `set -x KUBECONFIG /path/...`. This bites constantly — see §7.

**talosctl (node operations — there is no SSH to Talos nodes):**
```bash
export TALOSCONFIG=/path/to/platform-infra/clusters/real-talos/clusterconfig/talosconfig
talosctl -n 100.117.55.70 health          # cluster health
talosctl -n 100.117.55.70 dmesg           # node logs
talosctl -n 100.117.55.70 get members     # discovery
# LAN lifeline if Tailscale is down (same-switch):
talosctl -e 10.237.171.5 -n 10.237.171.5 version
```
> `talosctl apply-config` dials the **talosconfig endpoint**, not `-n`. If the endpoint is
> unreachable, override inline with `-e <reachable-ip>`. (See §7.)

### 3.4 Reaching the platform services

**Today (interim):** services are addressed in-cluster and over the overlay; the public domain is
not yet cut over. ArgoCD has an Ingress; reach it via the cluster's ingress host (Traefik) over the
tailnet, or `kubectl -n argocd port-forward svc/argocd-server 8080:443` for a quick local view.

**After the Phase-3 cutover (planned, D-036):** every service gets a real public URL under
`capstone.uamishub.com`:

| Service | Public URL (planned) |
| --- | --- |
| ArgoCD | `argocd.capstone.uamishub.com` |
| Harbor | `harbor.capstone.uamishub.com` |
| Dex (issuer) | `id.capstone.uamishub.com` |
| Backstage | `backstage.capstone.uamishub.com` (not yet deployed) |
| Grafana | `grafana.capstone.uamishub.com` (not yet deployed) |
| Vault | `vault.capstone.uamishub.com` (not yet deployed) |
| **Tenant app (prod)** | `<appname>.capstone.uamishub.com` |
| **Tenant app (non-prod)** | `<env>.<appname>.capstone.uamishub.com` (`dv.`, `qa.`, `<branch>.`) |

A single `*.capstone.uamishub.com` wildcard cert + Traefik Host-routing serves all of it. **Reserved
names** (`argocd`, `harbor`, `id`, `backstage`, `grafana`, `vault`) must be rejected as team slugs at
onboarding so a team can't shadow a platform host (D-036).

---

## 4. Day-2 operations

### 4.1 The golden rule

**You do not `kubectl apply` to change the platform.** You open a PR against `UA-MIS/platform-infra`,
get it reviewed, merge it, and ArgoCD reconciles. Direct pushes to `main` are blocked by branch
protection; direct `kubectl apply` to the shared cluster is blocked by the agent classifier and
discouraged for humans (it creates drift ArgoCD will fight or that bootstrap-reapply must repair).

The few exceptions (install-owned objects that ArgoCD does **not** reconcile) are handled by
`make bootstrap` / `make bootstrap-reapply` — see §4.3 and §7.

### 4.2 Bootstrapping the platform onto the cluster

The cluster substrate (Talos + Cilium + Rook) is brought up out-of-band per
`docs/phase-4-runbook.md` and `docs/cilium-cni-runbook.md`. Once the 3 nodes are Ready and Ceph is
HEALTH_OK, the GitOps platform is installed with **one command** (note the context override for the
real cluster — the target defaults to the k3d context):

```bash
cd platform-infra
make bootstrap TARGET=real-talos KUBE_CONTEXT=admin@capstone
```

This installs ArgoCD, applies the `platform` AppProject, and applies the app-of-apps root
(`bootstrap/root-app.yaml`). ArgoCD then pulls everything else (`platform-services/`, `tenants/`,
`applicationsets/`) from git and reconciles it. It is **idempotent** — safe to re-run.

After any PR that changes anything under `bootstrap/`, run:
```bash
make bootstrap-reapply KUBE_CONTEXT=admin@capstone
```
(See §4.3 / §7 for *why* — the bootstrap objects are deliberately not GitOps-reconciled.)

### 4.3 GitOps flow (PR → ArgoCD sync)

1. Branch from `main`, edit manifests, commit, push, open a PR.
2. CI/validation + ≥1 review (branch protection requires it).
3. Merge. ArgoCD detects the change and syncs (most apps auto-sync; prod and a few
   security-gated apps are manual-sync by design — see §6).
4. Verify: `kubectl -n argocd get applications` — the app should be `Synced/Healthy`.

> **"Synced/Healthy" is not proof it works** (ADV-002). An app can be green with every pod in
> `ImagePullBackOff`, and an app whose only object is a sync hook shows green while the hook never
> ran. Always assert the actual pods reach `Running` / the actual behavior happened. `make
> verify-image-pull` checks the registry-mirror class of failure.

### 4.4 Onboarding a new team/tenant

Tenancy is **generated from the team list** — copy the template, substitute two tokens, commit.
No imperative kubectl:

```bash
cd platform-infra
TEAM=acme SEMESTER=2026-fall
cp -r tenants/_template tenants/team-$TEAM
grep -rl '__TEAM__\|__SEMESTER__' tenants/team-$TEAM \
  | xargs sed -i "s/__TEAM__/$TEAM/g; s/__SEMESTER__/$SEMESTER/g"
git add tenants/team-$TEAM
git commit -m "onboard team $TEAM ($SEMESTER)"
# branch + PR + merge — ArgoCD creates the AppProject, namespaces (quota/limitrange/netpol/RBAC),
# and the team's ApplicationSets.
```

The companion identity/registry steps (do these alongside the PR):
1. **GitHub Team** `slug=<name>` under the semester parent team; add the students. (The semester
   parent team has *no* platform role — it's a grouping only, for isolation; D-027.)
2. **Harbor project + OIDC mapping:** `make harbor-onboard NAME=<name>` (creates the project, maps
   the `UA-MIS:<name>` OIDC group → Developer role).
3. **Image-pull robot:** `make harbor-robot NAME=<name> ENV=<env>` → seal the output as the team's
   `imagePullSecret`.
4. **CI push robot (when CI is wired):** `make harbor-push-robot NAME=<name> RUNNER_NS=arc-runners-<name>`
   → the `harbor-push` SealedSecret in the team's runner namespace (per-team isolation, D-033).
5. **Reserved-name check:** reject `<name>` if it collides with a platform host (§3.4).

**De-provisioning a graduated cohort is one git operation:** `git rm -r tenants/team-*` for that
semester and commit — ArgoCD prunes the AppProjects, namespaces, and everything in them. Every
object carries a `platform.capstone/semester` label.

### 4.5 Where secrets live

| Secret class | Mechanism | Where the key/root-of-trust lives |
| --- | --- | --- |
| Platform/bootstrap secrets (Dex, Harbor OIDC, ARC GitHub App, …) | **Sealed Secrets** — encrypted in git, decrypted in-cluster | **the sealing key** (a k8s secret in `kube-system`, label `sealedsecrets.bitnami.com/sealed-secrets-key=active`) — a **root secret**, must be in the handoff vault |
| Talos cluster secrets (CA keys, bootstrap token) | `talsecret.sops.yaml`, **sops/age-encrypted** | **age private key** at `~/.config/sops/age/keys.txt` — handoff vault |
| Tailscale node auth key | `talenv.sops.yaml`, sops/age-encrypted | same age key |
| Runtime app secrets (planned) | **Vault + External Secrets Operator** — nothing in git, only a reference | Vault (not yet deployed; D-018/D-019) |

**To seal a new secret for git:**
```bash
make seal SECRET=path/to/secret.yaml NS=<namespace> > sealed.yaml
```
When **adding a key to an existing SealedSecret**, you must recover the existing values first, rebuild
the full Secret with the new key, and re-seal *all* keys together (kubeseal replaces the whole
encryptedData). Always `kubeseal --validate` against the live controller and grep the tree for
plaintext before committing. (See §7.)

> **The sealing key is the linchpin of secret continuance.** It was deliberately *migrated* from the
> old k3d cluster to the Talos cluster (rather than re-sealing everything) so the committed
> SealedSecrets keep decrypting (D-035). If you ever rebuild the cluster, migrate this key or every
> SealedSecret must be re-created from plaintext you no longer have.

### 4.6 Branch protection / PR process

Both `platform-infra` and `sample-app` have branch protection on `main`: PR required, ≥1 review,
dismiss-stale reviews, conversation resolution, linear history, force-push + deletion blocked.
`enforce_admins` is currently **off** (build velocity) — flip it on once the build settles.
`require_code_owner_reviews` is **off** pending a `platform-team` GitHub Team (see §5/§7).

Process: `branch → commit → push → gh pr create → review → merge`. The agent tooling can create
branches and PRs but **not** push to `main` directly (server-side protection + classifier).

### 4.7 Runbooks (read these for the substrate-level procedures)

| Runbook | Covers |
| --- | --- |
| `docs/phase-4-runbook.md` | Talos image build, per-node install, etcd bootstrap, Rook-Ceph bring-up, pre-apply gate |
| `docs/cilium-cni-runbook.md` | The flannel→Cilium swap on Talos+Tailscale (the in-progress work) |
| `docs/db-tier-runbook.md` | Postgres 17 + MariaDB 11.8 on `ua-mis-db-1`, pgBackRest, nftables, SSH key-only |
| `docs/phase-1-golden-path.md` | The original k3d golden-path proof (historical reference for the full app loop) |
| `docs/custom-domain.md` | How a team points its own domain at its project (registrar 301; D-034) |

---

## 5. CONTINUANCE

> **This is the most important section.** A capstone platform must survive the graduation of the
> student who built it. The failure mode is *not* technical — it's that the keys to the kingdom are
> tied to a personal account that disappears. Fix that first.

### 5.1 The principle

Every account, credential, and domain the platform depends on must be **owned by the
institution/department or a long-lived org**, not by a graduating student's personal account. Where
something is still personal, **migrate it to an org-owned account before the builder leaves.**

### 5.2 Org-owned accounts that MUST be institutionally held

| Asset | Must be owned by | Why it's load-bearing | Status / action |
| --- | --- | --- | --- |
| **`ualaims` Google Workspace** | the department | It backs the **Tailscale tailnet** identity *and* the **Cloudflare** account for the public domain | Confirm the `ualaims` Google account is dept-controlled with ≥2 admins; **do not** let it lapse to one student |
| **Tailscale tailnet (`ualaims`)** | dept (via `ualaims` Google) | The entire cluster's network fabric + addressing; losing it loses node-to-node + admin reach | Already on the org tailnet (re-keyed 2026-06-18). Keep ≥2 tailnet admins |
| **Cloudflare account** | dept (via `ualaims` Google) | Runs the Cloudflare Tunnel + hosts the delegated `capstone.uamishub.com` subtree (Phase-3) | Create/confirm under `ualaims`; needed at the domain cutover |
| **UA-MIS GitHub org** | the department / faculty | Holds `platform-infra`, all team app repos, the SSO OAuth app, ARC runner registration, branch protection | Confirm ≥2 org **owners** who are faculty/staff, not only a student |
| **DigitalOcean** (DNS for `uamishub.com`) | whoever owns `uamishub.com` (dept) | Authoritative DNS; the Phase-3 cutover delegates *only* the `capstone.` subtree to Cloudflare via one NS record | Get a DO API token (cert-manager DNS-01) into the vault; never touch apex/`attendance` |
| **`uamishub.com` domain registration** | dept | The platform's public identity | Confirm registrar account is dept-owned and auto-renewing |

### 5.3 The handoff vault (assemble this before the builder leaves)

A single secured store (password manager / sealed offline medium) containing:

- [ ] The **age private key** (`~/.config/sops/age/keys.txt`) — decrypts Talos secrets.
- [ ] The **Sealed Secrets sealing key** (export: `kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key=active -o yaml`) — decrypts every committed SealedSecret.
- [ ] The **kubeconfig** (`clusterconfig/talos-kubeconfig`) and **talosconfig**.
- [ ] **Tailscale** admin access (via the `ualaims` Google account) + how to mint a `tag:talos-node` reusable auth key.
- [ ] **Cloudflare** + **DigitalOcean** API tokens.
- [ ] **GitHub org owner** access + the SSO **OAuth app** client-id/secret.
- [ ] **DB tier**: the `ops` SSH key for `ua-mis-db-1` and the DB admin credentials.
- [ ] A pointer to **this document** and the **decision log** (`artifacts/context/decision-log.md`).

> Treat the age key, the sealing key, and the kubeconfig as **root secrets**: transfer offline,
> never commit, never paste into chat/CI logs.

### 5.4 The GitHub Education / Team upgrade — a FACULTY/INSTITUTION action

There is a concrete continuance item **a student cannot do alone**: upgrading the UA-MIS org to
**GitHub Team/Enterprise via GitHub Education**.

- **Why it matters:** branch protection, required reviewers/Environments (the prod-gate, D-020),
  CODEOWNERS-enforced reviews, and org-level controls are most robust on a paid tier; GitHub
  Education can provide this **free** for an academic org. During this build, `require_code_owner_reviews`
  had to stay **off** and `enforce_admins` **off** partly because the org tier + a `platform-team`
  GitHub Team weren't fully in place — i.e. **the org's plan/teams limited what branch protection
  could enforce** (the branch-protection finding in D-027 / Phase-1.5).
- **Why a student can't do it:** the **GitHub Education / Enterprise upgrade is granted to the
  institution** (verified `.edu` org via a faculty/staff member or the institution itself), not to an
  individual student. A graduating student's verification lapses with them.
- **Action for the successor / faculty:** have a **faculty member or the institution** claim/maintain
  the UA-MIS org's GitHub Education status, ensure ≥2 faculty org owners, and create the
  `@UA-MIS/platform-team` GitHub Team (referenced by CODEOWNERS) so code-owner review and
  `enforce_admins` can be turned on.

### 5.5 The decision log

`artifacts/context/decision-log.md` is the *why* behind every non-obvious choice (D-001…D-041).
**Read it before reversing anything** — several decisions were close calls that were re-litigated and
reversed (e.g. D-039 Proxmox → D-040 stay-on-Talos). It is the authoritative record; this manual
summarizes, it does not replace it. See §8 for an index of the load-bearing ones.

### 5.6 "First week as the new admin" checklist

1. **Get access:** join the `ualaims` tailnet; obtain the handoff vault (§5.3); confirm you are a
   GitHub org owner.
2. **Confirm you can see the cluster (read-only):**
   `export KUBECONFIG=.../talos-kubeconfig && kubectl get nodes` (expect 3× Ready) and
   `kubectl -n argocd get applications`.
3. **Confirm Ceph health:** `kubectl -n rook-ceph get cephcluster` (expect `HEALTH_OK`).
4. **Read, in order:** this manual → the decision log (skim D-026, D-029, D-035, D-036, D-040) →
   `docs/phase-4-runbook.md` and `docs/cilium-cni-runbook.md`.
5. **Verify secret continuance:** confirm you can `sops -d clusters/real-talos/talsecret.sops.yaml`
   (proves the age key works) and that the sealing key is in the vault.
6. **Confirm org ownership is institutional:** ≥2 faculty/staff own the GitHub org, Tailscale tailnet,
   Cloudflare, and DigitalOcean — not just one person.
7. **Make one trivial GitOps change end-to-end** (e.g. a README tweak) to exercise the
   branch → PR → merge → ArgoCD-sync loop before you need it under pressure.
8. **Review the open PRs and pending work** in §6 — know what's mid-flight.

---

## 6. Current state & pending work

> Snapshot taken **2026-06-18** from the live cluster (`admin@capstone`). Honest, not aspirational.

### 6.1 What is LIVE and working

- **3-node Talos cluster**, all Ready, HA (3-member etcd quorum), k8s v1.31.5 / Talos v1.13.4.
- **Rook-Ceph replica-3**, `HEALTH_OK`, `ceph-block` is the default StorageClass, PVCs bind.
- **ArgoCD** app-of-apps reconciling the platform; most apps `Synced/Healthy`.
- **Sealed Secrets** with the migrated sealing key (Dex/Harbor/ARC secrets decrypt).
- **Dex** SSO broker, **cert-manager**, **ARC** controller + runner scale-set, **metrics-server**,
  **CoreDNS custom**, **sealed-secrets** — all `Synced/Healthy`.
- **Cilium 1.17.4** active on all 3 nodes (functional; cross-node pod-to-pod proven; apiserver
  reachable over both LAN and Tailscale).

### 6.2 What is degraded / in-progress (live ArgoCD status)

| App | Status | Reason / note |
| --- | --- | --- |
| `platform-harbor` / `platform-svc-harbor` | **Degraded** | Harbor is up but not fully green — pending `PLATFORM_DOMAIN` (still `REPLACE_ME` → not browser-reachable + OIDC redirects break) and the `harbor-configure-oidc` job re-run |
| `platform-svc-cloudflared` | **Degraded** | Cloudflare Tunnel app present but the public cutover is gated on the domain decision + deny-test |
| `platform-netpol-controlplane` | **OutOfSync** (Healthy) | Manual-sync by design (SEC-011 gate); **inert until Cilium swap is clean** |
| `platform-netpol-runners` | **OutOfSync / Missing** | Same — netpol enforcement pending the CNI swap |
| `platform-svc-traefik` | **OutOfSync / Missing** | Mid-reconcile during the CNI/ingress work |
| `sample-dev` / `sample-staging` / `sample-pr-1` | **Degraded** | Sample app images still reference the old `k3d-registry.localhost`; needs a Harbor-targeted CI push (developer fix in the external `sample-app` repo) |
| `sample-prod` | **OutOfSync / Missing** | Pinned to a prod tag not yet cut |

### 6.3 The two open PRs (know these)

- **PR #42** — `feat(p4): talconfig cni:none + disable kube-proxy for Cilium` (`p4/cilium-talconfig-patch`).
  The talconfig change that makes the Cilium swap *clean* (sets `cni: none` so Talos stops managing
  flannel/kube-proxy). Cilium already works by CNI-config precedence, but flannel + kube-proxy
  DaemonSets linger until this lands + nodes are re-applied/rebooted. **Do not merge until** `cni:none`
  is confirmed live on all 3 nodes (the prior apply was from the wrong branch — see §7).
- **PR #37** — `feat(p3): flip PLATFORM_DOMAIN to capstone.uamishub.com [HOLD MERGE]`
  (`p3/platform-domain-flip`, DRAFT). The batch one-variable domain flip. **Held** until the hardware
  cluster + CNI are settled and the deny-test passes.

### 6.4 Sequenced pending work (the critical path)

1. **Finish the Cilium swap cleanly** (PR #42): checkout the branch, `talhelper genconfig`, confirm
   both `cni: none` and `proxy.disabled: true` render, re-apply all 3 nodes + reboot one-at-a-time
   (wait Ready between — Ceph is replica-3), confirm flannel/kube-proxy DaemonSets auto-clear, merge #42.
2. **Deny-test** (security gate): from an `arc-runners` pod, the apiserver via node-IP **and** via
   Tailscale `100.x` MUST fail; DNS / kube-service / Harbor MUST succeed. This flips all NetworkPolicies
   from "inert" to "proven-enforced" (see §7 — flannel never enforced them).
3. **Domain cutover** (PR #37 + D-036): set `PLATFORM_DOMAIN=capstone.uamishub.com`, delegate the
   `capstone.` subtree from DigitalOcean to Cloudflare (one NS record), stand up cert-manager DNS-01
   wildcard + `cloudflared` tunnel, then delete the Phase-2 hacks (skip-verify, `oidc_verify_cert:false`,
   the CoreDNS split-horizon rewrite — all become unnecessary with real public certs).
4. **Re-run `harbor-configure-oidc`** once the domain is live, get Harbor fully green.
5. **Not yet deployed (backlog):** **Backstage** (developer portal), **Vault + ESO** (runtime
   secrets, D-018/D-019), **Grafana/observability**, the **db-2 + Patroni** HA pair (D-029), and
   **resource governance** (Goldilocks + VPA RequestsOnly + per-tenant LimitRange/Quota, D-041).
6. **Branch-protection hardening:** create `@UA-MIS/platform-team`, turn on `require_code_owner_reviews`
   and `enforce_admins` (needs the GitHub Education/Team work — §5.4).
7. **Low-priority:** git-history scrub of the (now-dead) leaked Phase-4 secrets (force-push is
   settings-denied; a human lifts it). The leaked creds are all revoked/re-keyed — this is hygiene.

---

## 7. Troubleshooting / gotchas

These are hard-won, each cost real time. Skim the headings; read the one that bites you.

### Shell & tooling

- **The workstation shell is fish — `export VAR=value` SILENTLY FAILS** (`Expected a string`). This
  was the root cause of a whole class of empty-value bugs (unset `TS_AUTHKEY`/`SCHEMATIC_ID` →
  empty substitutions → wrong Talos image installed). In fish use `set -x VAR value`. For talhelper
  vars, put them in `talenv.sops.yaml` (auto-loaded), **not** shell exports.
- **Grabbing the wrong cluster:** `kubectl`/`k9s` default to whatever context is current — easy to
  hit the old k3d cluster by accident. Always set `KUBECONFIG` to the Talos kubeconfig explicitly.
- **`talosctl apply-config` dials the talosconfig *endpoint*, not `-n`.** If genconfig rewrote the
  endpoint to an unreachable placeholder, override inline with `-e <reachable-ip>`. Symptom:
  `dial tcp: lookup ... no such host` even with `-n` set.
- **No `$(...)` anywhere in talconfig / patches / ExtensionServiceConfig.** talhelper's envsubst only
  does `${VAR}`, never command substitution — a literal `$(hostname)` shipped and broke `tailscale up`.
  The runbook's pre-apply gate now greps for `$(`.

### Storage (Rook-Ceph)

- **Rook chart v1.20+ REMOVED the classic in-operator CSI driver.** v1.20.1 only ships the
  `ceph-csi-operator` path, which in this combo never created the RBD Driver CR → no provisioner →
  every PVC stuck `Pending`. **Fix: pin both `rook-ceph` and `rook-ceph-cluster` to v1.19.7**
  (`csi.rookUseCsiOperator:false`, `csi.enableRbdDriver:true`). **Revisit at any Rook chart bump** —
  v1.20+ needs the separate ceph-csi-drivers chart path.
- **`cephBlockPools[].storageClass.parameters` is taken WHOLESALE, not merged.** Listing only
  imageFormat/imageFeatures/fstype DROPS the 4 CSI secret pairs → PVCs fail `provided secret is empty`.
  You must list the **full set** including all four `csi.storage.k8s.io/{provisioner,controller-expand,controller-publish,node-stage}-secret-{name,namespace}` pairs (provisioner/expand/publish → `rook-csi-rbd-provisioner`, node-stage → `rook-csi-rbd-node`, all in ns `rook-ceph`). SC params are immutable, so the fix is `kubectl delete sc ceph-block` and let ArgoCD recreate (safe — the SC holds no data; Pending PVCs reattach by name).
- **Ceph disk must be EMPTY.** The 7080 SATA SSDs shipped with leftover Windows GPT partitions;
  Rook refuses non-empty disks. The runbook has a human-gated `talosctl wipe disk sda` step — **never
  wipe nvme0n1** (that's the Talos OS disk). Target disks by stable `/dev/disk/by-id` WWN, not `sda`
  (the kernel name floats when a USB stick is inserted).
- **ArgoCD owns adopted Helm releases.** A manual `helm upgrade` of e.g. the Rook operator fails with
  a field-manager conflict against `argocd-controller`. Apply changes via ArgoCD sync, not helm.

### ArgoCD / bootstrap (the "looks green but didn't apply" classes)

- **Two objects are install-owned and NOT GitOps-reconciled, by design:**
  `bootstrap/argocd-install/` (the ArgoCD install + argocd-server patches) and
  `bootstrap/platform-appproject.yaml` (the `platform` AppProject `sourceRepos` allowlist). When you
  merge a PR touching `bootstrap/`, **git is updated but the live cluster stays stale** until you run
  `make bootstrap-reapply`. (Seen as: Harbor blocked on a missing `sourceRepos` entry; the UI theme
  404'd because a new volume mount never reached the live Deployment.)
- **The argocd-cm SSA wipe-gotcha (cost hours).** `argocd-cm` is co-managed: the install ships only
  `resource.customizations.*`; the GitOps app owns `ui.*` (theme) + `oidc.*` (SSO). A **standalone**
  `kubectl apply -k bootstrap/argocd-install --server-side --force-conflicts` **wiped the entire
  `argocd-cm.data`** (SSO + theme broke) because a stale `last-applied-configuration` annotation made
  kubectl do a CSA→SSA migration that pruned the GitOps keys. **`make bootstrap-reapply` is hardened
  against this** (strips the stale annotation → applies → **force-syncs** the GitOps app to re-assert
  ui/oidc → rolls argocd-server → asserts the keys are present, failing loudly otherwise) and is
  **live-proven safe**. **Never** run the bare standalone install apply against argocd-cm — use
  `bootstrap-reapply`.
- **A hook-only ArgoCD app never fires its hook.** Sync hooks run only during a sync *operation*; an
  app whose only object is a hook has nothing OutOfSync, so no operation ever starts — the hook stays
  dormant while the app shows Synced/Healthy. **Fix:** make the Job a *regular* resource with
  `sync-options: Force=true,Replace=true,ServerSideApply=false` (Replace alone falls to `create` →
  "already exists" loop; SSA-app-wide is incompatible with Replace). Drop `ttlSecondsAfterFinished`
  so the object persists. This bit the Harbor `configure-oidc` job; it applies to every Helm-app
  post-config Job.
- **Verify-step regex order:** the Harbor API returns settings as `{"editable":true,"value":...}` —
  `editable` *before* `value`. A regex like `"auth_mode":{"value":...}` never matches and false-fails
  a working PUT. Isolate the object first, then pull `value` order-independently.

### Networking / CNI (the big current one)

- **Plain flannel does NOT implement NetworkPolicy.** On the original Talos config every committed
  NetworkPolicy (default-deny, control-plane hardening, per-tenant isolation, runner isolation) was
  **inert** — they showed `Synced/Healthy` (objects applied) but were **never enforced**. This is why
  the platform **cannot go internet-facing** until the CNI swap + deny-test are done: the
  compensating control for the OIDC skip-verify hacks ("in-cluster MITM is fenced by default-deny")
  did not actually exist under flannel.
- **The Cilium swap is functional but not yet clean.** Cilium 1.17.4 is active and working (the
  load-bearing flag is **`bpf.hostLegacyRouting=true`**, which cleared the risk of eBPF breaking the
  Tailscale overlay). But `cni: none` did not apply in the live machine config (the apply ran from the
  wrong branch), so the Talos-managed `kube-flannel` + `kube-proxy` DaemonSets still exist with
  `managedFields=talos` — **do not `kubectl delete` them until `cni:none` is confirmed live**, or
  Talos will recreate them. Finish via PR #42 (§6.4).
- **NetworkPolicy CIDRs were hardcoded to k3d ranges.** k3d used pods `10.42/16`, svc `10.43/16`,
  nodes `10.89.0.0/24`; Talos uses pods `10.244/16`, svc `10.96/12`, real node IPs. The re-param to
  Talos ranges (plus a Tailscale CGNAT `100.64.0.0/10` block on runner egress — the apiserver is also
  reachable over the tailnet, a new hole on Talos) merged in PR #40. Always re-parameterize netpol
  CIDRs via the `clusters/` seam when the substrate changes.
- **Dual-CNI service-routing trap:** while both flannel and Cilium configs are present, routing works
  by CNI-config file precedence (`05-cilium.conflist` > flannel). It works, but it's fragile — get to
  the clean single-CNI state (PR #42) rather than relying on precedence.

### Secrets

- **Sealing-key migration, not re-seal:** moving clusters, the k3d sealing key was migrated to Talos
  so committed SealedSecrets keep decrypting. A new cluster = a new key = every SealedSecret breaks
  unless you migrate. The sealing key is a **root secret** (offline transfer, delete the backup after).
- **Re-sealing a multi-key SealedSecret:** recover the existing values first
  (`kubectl -n <ns> get secret <name> -o jsonpath='{.data.<key>}' | base64 -d`), rebuild the full
  Secret + new key, re-seal all together — kubeseal replaces the whole `encryptedData`. `--validate`
  + grep for plaintext before commit.
- **sops/age path_regex must be BASENAME-anchored** (`(^|/)talsecret\.sops\.ya?ml$`) — a
  dir-prefixed regex silently fails to match when you run `sops` from inside that dir (no encryption,
  no error). The age recipient must be a **bare single token** (a folded `>-` scalar or trailing
  comment corrupts it → "invalid recipient encoding").
- **The Phase-4 secret leak (remediated, lesson stands):** a public-repo PR branch once committed a
  live Tailscale key, the Talos cluster CA private keys (unencrypted despite a `.sops` filename), and
  an admin kubeconfig. All revoked/re-keyed; the cluster runs on a fresh CA on the org tailnet.
  **Root cause: no `.gitignore` above `clusterconfig/`, and the `.sops` file was never actually
  encrypted.** The fix (`.sops.yaml` creation rules + a hardened `.gitignore` + a mandatory
  encrypt-and-verify runbook step) is in place — but **always** verify `talsecret`/`talenv` are
  encrypted (`grep ENC[` and `sops -d` round-trip) before any commit.

### Bootstrap / theme deadlocks

- **Fresh-cluster theme deadlock:** `argocd-server` mounts `argocd-ui-theme-cm`, which is created by
  a platform-service that only syncs *after* ArgoCD is up → deadlock on a fresh cluster. `make
  bootstrap` now creates that ConfigMap imperatively before the rollout (PR #31).
- **k3d/rootless-Podman gotchas** (only relevant if you spin up the local k3d dev cluster, not the
  Talos prod cluster): no `bridge` network on Podman; the registry name gets a forced `k3d-` prefix
  (double-prefix → ImagePullBackOff); kubelet needs `KubeletInUserNamespace=true`; serverlb needs
  privileged-port sysctl + a restart after bouncing a server node. See
  `memory/k3d-rootless-podman-gotchas.md` and `docs/phase-1-golden-path.md`.

---

## 8. Appendix

### 8.1 Decision-log index (the load-bearing ones)

Full record: `artifacts/context/decision-log.md` (D-001…D-041). The ones worth knowing:

| D-ID | Decision |
| --- | --- |
| D-002 | Local dev cluster = k3d (k3s-in-Docker) — the inner-loop / proof substrate |
| D-006 | Bootstrap secrets = Sealed Secrets |
| D-012 | ArgoCD pulls `UA-MIS/platform-infra` + `sample-app` as **public** repos (anonymous) |
| D-017 | SSO = **Dex** brokering **GitHub-org (UA-MIS)** membership as the sole identity (Keycloak/Entra dropped) |
| D-018/D-019 | Runtime secrets = self-hosted **Vault + External Secrets Operator** (keyless; not yet deployed) |
| D-020/D-030 | Prod gate = GitHub Environments "Approve" (UI, no CLI); prod tracks an immutable `vX.Y.Z` tag, non-prod tracks `main` |
| D-022/D-032 | CI = **GitHub Actions + ARC + Kaniko → Harbor** (Tekton considered, rejected on student-familiarity) |
| D-026 | **One slug `<name>` everywhere** (team / namespace / Harbor / RBAC / OIDC group / host) |
| D-027 | UA-MIS team→RBAC mapping (`labmx`=admin; project=child team; semester=grouping, no role) |
| D-028 | Harbor via Helm-source ArgoCD app; Trivy scan-on-push + warn (not block) |
| D-029 | DB strategy = dedicated **off-cluster** Postgres+MySQL tier, shared multi-tenant, Patroni HA |
| D-031 | Elastic fleet: valid at 5 boxes, scales to 15+ by adding boxes; role-by-label |
| D-033 | Per-team CI push-credential isolation (per-team runner namespaces) |
| D-034 | Team custom domains = registrar-side 301 redirect; platform does nothing |
| D-035 | Phase-4 hardware buildout: 3× Talos converged nodes + Tailscale overlay + Debian DB tier |
| **D-036** | **Platform domain = `capstone.uamishub.com`** (dedicated subtree; resolves D-007); Cloudflare Tunnel via whole-subtree delegation; LE DNS-01 wildcard via DigitalOcean |
| D-037 | Rook-Ceph replica-3 from the start (all 3 boxes dual-disk) |
| D-038 | apiserver endpoint pinned to n3's Tailscale IP (single-endpoint; HA is a later add) |
| D-039 → **D-040** | Considered switching to Proxmox+k3s, then **reversed — stay on Talos** (immutable, tag-efficient, AI-assisted recovery; VMs via KubeVirt on-demand) |
| D-041 | Resource governance (Goldilocks + VPA RequestsOnly + per-tenant LimitRange/Quota) — backlogged |

### 8.2 Glossary

- **IDP** — Internal Developer Platform.
- **GitOps** — desired state lives in git; a controller (ArgoCD) continuously reconciles the cluster to it.
- **App-of-apps** — one ArgoCD Application that points at a set of child Applications, so the whole platform is bootstrapped from a single root.
- **Talos** — an immutable, API-only Linux distribution purpose-built for Kubernetes (no SSH, no shell; managed via `talosctl`).
- **Cilium** — an eBPF-based CNI providing pod networking, kube-proxy replacement, and NetworkPolicy enforcement.
- **Rook-Ceph** — Ceph (distributed storage) operated by the Rook operator inside Kubernetes.
- **Dex** — a lightweight OIDC broker that federates upstream identity providers (here, GitHub).
- **ARC** — Actions Runner Controller; runs GitHub Actions self-hosted runners as autoscaling pods.
- **Kaniko** — builds container images inside a container without a Docker daemon or root.
- **Sealed Secrets** — encrypts a Secret so the ciphertext is safe to commit to git; only the in-cluster controller (holding the sealing key) can decrypt it.
- **sops / age** — file-level encryption (used for the Talos cluster secrets); `age` is the key format.
- **Tailnet** — a Tailscale private network; the platform's overlay fabric (`ualaims` tailnet).
- **Converged / hyperconverged node** — a node that is simultaneously control-plane, storage, and workload host (the 5-box floor model).

---

*Maintained in `platform-infra/docs/OPERATIONS-AND-HANDOFF.md`. When a decision changes, update the
decision log first (the source of truth), then reconcile this manual. Keep it honest about what is
live vs. planned — a stale handoff doc is worse than none.*
