# ADR-032a — What a "VM tenant" IS: SSH access, clone-and-run, and the pet-vs-immutable disk

- **Status:** Proposed (design stub — needs operator decisions on the marked items). **D2 (SSH transport) RESOLVED 2026-07-14** — see the note under D2; D3/D4 remain open. Amends **ADR-032** (resolves its open Q7 "console/SSH access"; refines the §Runtime model disk lifecycle).
- **Date:** 2026-07-12
- **Repo:** platform-infra
- **Deciders:** operator (Clayton) + security track; drafted by architect
- **Relates to:** ADR-032 (KubeVirt VM workloads), ADR-028/D-036 (Cloudflare-Tunnel edge), SEC-011 (Cilium netpol enforcement), the `tenants/_template-vm` VM blueprint (this PR).

---

## Context — the intent vs. what exists

The operator's definition of a VM tenant: **a team gets a full machine they SSH into, clone their app repo onto, and run their stack there** — a *pet* dev-VM, not the immutable cloud-init/GitOps container flow.

What the platform delivers today (post-#376, first VM tenant `tenantvm`):
- a KubeVirt `VirtualMachine` reachable at an **HTTP ingress** (`<app>.capstone.uamishub.com`, port 8080),
- **console/VNC** via `virtctl` (RBAC-scoped), gated behind a `changeme` password,
- **no SSH**, **no clone-and-run**, and a disk whose lifecycle is bound to the VM object.

Three gaps to close: **(1) SSH access, (2) the clone-and-run model, (3) disk persistence / the immutable-vs-pet tension.** Two hard operator constraints frame (1):
- **C1:** teams must reach the VM with a **standard `ssh` client** from their own laptop — **no client install, no VPN**.
- **C2:** Tailscale is an **admin-only** overlay (students are not on the tailnet), and `virtctl console` is **break-glass only**, not the daily workflow.

## The binding infrastructure reality (this is the crux)

Public exposure on this platform is **one Cloudflare Tunnel**, token-based, with a **single dashboard route**: `*.capstone.uamishub.com → http://traefik.kube-system.svc:80` (**HTTP only**). There is **no MetalLB / no LoadBalancer IP pool**, **no public TCP entrypoint**, and the deployment network is shared apartment wifi that **blocks inbound** and even outbound non-443 UDP (`clusters` + `platform-services/cloudflared/deployment.yaml`).

Consequence: a literal `ssh student@host:22` from the open internet — no client, no VPN — **is not reachable on today's edge.** Raw TCP/22 to the cluster requires one of: Cloudflare **Spectrum** (paid TCP proxy), a **routable public IP + port-forward** (blocked by apartment wifi; possible once the fleet moves), or a client-side tunnel (`cloudflared access` / Tailscale — both violate C1/C2). This is the decision the operator must make; the app-layer design below is identical regardless of which transport wins.

## Decision

### D1 — Auth: key-based SSH, wired now (no decision needed)

- The team's **SSH public key** is a scaffolder wizard input (`sshPubKey`), installed by cloud-init into `ssh_authorized_keys`; **password login is disabled** (`ssh_pwauth: false`). Public keys are **not secrets** — no Vault/SealedSecret; they live in the (already-whitelisted) cloud-init object. `ssh_import_id: gh:<user>` is the documented "add teammates" path (pulls from `https://github.com/<user>.keys`, which students already maintain for git).
- **Implemented in this PR** (`skeleton-vm/.devops/chart/base/cloud-init.yaml` + the `sshPubKey` input). This is the unambiguous half and stands regardless of transport.

### D2 — Transport: the app-layer target is fixed; the public path is an operator choice

Every option below points at the **same per-tenant `ClusterIP` SSH Service** (`<app>-ssh` :22, added to `skeleton-vm` in this PR). Per-tenant isolation is by Service→namespace; the tenant `default-deny` + `allow-ingress-traefik-and-intra-ns` NetworkPolicies already permit ingress **only** from the Traefik tier (kube-system) — one team cannot reach another's SSH Service (SEC-011 posture preserved).

| Option | Native `ssh` client? (C1) | Per-tenant isolation | Needs | Verdict |
| --- | --- | --- | --- | --- |
| **A. Traefik `IngressRouteTCP` per-tenant TCP port** (`ssh -p 22NN student@ssh.capstone.uamishub.com`) + a public TCP entrypoint (Spectrum **or** public-IP port-forward) | **Yes** (standard client, `-p`) | Yes (port→Service) | a public TCP entrypoint (**$ or public IP**); Traefik TCP entrypoints 2200–22xx; one `IngressRouteTCP` per tenant (`HostSNI(*)`, no SNI needed) | **RECOMMENDED native path.** SSH has no SNI, so multiplexing is **by port, not hostname** — one dedicated port per VM. |
| **B. Per-VM `LoadBalancer` :22** (`ssh student@<vm-dns>`) | Yes (standard, port 22) | Yes (IP→Service) | MetalLB/LB pool **and** routable public IPs — **neither exists today** | Cleanest UX **if** infra existed; blocked on this homelab. |
| **C. Cloudflare Access browser-rendered SSH** (`https://ssh-<app>.…` web terminal) | **No** (browser, not a client) — but **zero install, zero VPN** | Yes (Access app per tenant) | Cloudflare Zero-Trust config (free ≤50 users) + a tunnel `ssh://` route to the Service | **RECOMMENDED zero-infra INTERIM** — works on today's edge with no new hardware/spend; satisfies "no install/no VPN" but not "standard client". |
| **D. `cloudflared access ssh` ProxyCommand** (`ssh` works after a one-binary install) | Partial (client install) | Yes | tunnel `ssh://` route + the `cloudflared` binary on the laptop | Power-user path; **violates C1** (install) — offer as opt-in only. |
| **E. Shared SSH bastion pod** that proxies to `<team>-vm` by identity | Yes | Yes (bastion RBAC) | a bastion to own + public TCP for the bastion (same edge problem) | Adds a component **and** still needs a public TCP entrypoint — no net win over A. |
| Tailscale / `virtctl` | — | — | — | **Excluded by C2** (admin-only / break-glass). |

**Recommendation:** ship **C (Access browser SSH)** as the interim that works today with no spend, and adopt **A (Traefik per-port TCP)** as the durable native-`ssh` path the moment a public TCP entrypoint exists — decision gate below. Both reuse the exact same in-cluster Service + netpol, so no rework when switching.

**OPERATOR DECISION (D2):** pick the public TCP entrypoint for path A — **Cloudflare Spectrum** (paid, keeps the Cloudflare edge model, `ssh host:22`), **or** a routable public IP on the fleet post-apartment-wifi (free, needs port-forward + a Traefik TCP entrypoint range) — or run with **C** indefinitely. Until then, **C** is live-able.

> **RESOLVED — 2026-07-14.** Operator directive: "ssh method doesn't matter as long as
> it's the easiest/cheapest." That is **Option C** (Cloudflare Access browser SSH),
> shipped alongside **Option D** (`cloudflared access ssh` as a native-client
> `ProxyCommand`) as an opt-in for anyone who installs the `cloudflared` binary — both
> ride the same Cloudflare Tunnel `ssh://` Public Hostname + Access application, so
> offering both costs nothing extra. **Not adopted:** A/B/E (all need a public TCP
> entrypoint the deployment network doesn't have, or a bastion component with no net
> win over A). Ships: the `allow-ingress-cloudflared-ssh` NetworkPolicy (port 22 from
> ns `cloudflared`) in `tenants/_template-vm/vm/namespaces/vm-prod.yaml` (applies to
> every future VM tenant at onboarding time — no live VM tenant exists to backport as
> of this writing, `team-tenantvm` was torn down for a clean re-test the same day),
> onboarding-PR checklist/operator-steps updates, and end-user docs, in the PR that
> added this note. The Cloudflare Public Hostname + Access
> application themselves remain per-tenant **dashboard** steps (the tunnel is
> token-based/remotely-managed — no git-side ingress config exists to template) — see
> `docs/operator/vm-ssh-cloudflare-access.md` for the operator checklist. Revisit A
> only if native `ssh <host>:22` (no `-p`, no ProxyCommand) becomes a hard requirement
> and the team is willing to pay for Spectrum or the fleet gets a routable public IP.
>
> **⚠ SUPERSEDED (2026-07-14) by ADR-038** on two points:
> 1. **The per-tenant dashboard steps are now AUTOMATIC.** The Public Hostname route +
>    Access application are provisioned by the in-cluster `cf-vm-access` reconciler
>    (`platform-services/cf-vm-access/`), which reads each VM tenant's `<app>-ssh`
>    Service and drives the Cloudflare API (token-managed tunnel config GET-merge-PUT +
>    Access app), creating on onboard and removing on teardown. The manual checklist
>    survives only as the pre-token-setup fallback. See ADR-038.
> 2. **The SSH hostname is `ssh-<app>.capstone.uamishub.com` (single hyphenated label),
>    NOT the dotted `ssh.<app>.capstone.uamishub.com` this note and the docs originally
>    specified.** The platform TLS cert `*.capstone.uamishub.com` is a one-level wildcard
>    that does not cover a 2-label host — the dotted form fails the HTTPS/Access TLS
>    handshake. Corrected in ADR-038 + the operator doc.

### D3 — Clone-and-run: cloud-init bootstraps the MACHINE; the team clones + runs (true pet)

cloud-init installs the **runtime prerequisites** (git, the language toolchain, sshd, the team's key) and prints an MOTD; the team **SSHes in and `git clone`s their app repo and runs it** — matching "a machine they SSH into, clone their app repo onto, and run their stack there" verbatim. Default = the team clones (using their own GitHub creds at the terminal), so **no repo deploy-key/token lives in the VM**.

- This reconciles the current "repo = VM manifest + cloud-init" model: the scaffolded repo is the **VM's infra** (chart + cloud-init); the **app** the team develops is cloned in at runtime. They may be the **same** repo (app code at root, VM infra under `.devops/`) or a **separate** app repo — the VM doesn't care.
- **Optional live-on-boot variant:** a `.devops/vm/bootstrap.sh` contract cloud-init runs on first boot to auto-clone+start (GitOps-ish demo URL). This needs a **read-only deploy key or token in the VM** to clone a private repo — a secret-handling decision. **OPERATOR DECISION (D3):** default to manual clone (no in-VM secret), or offer the auto-clone variant with a per-VM deploy key (Vault/SealedSecret)? Recommendation: **manual clone by default**, auto-clone as an opt-in later.

### D4 — Persistence: make the disk a real pet (decouple it from the VM object)

- The rootdisk is a **PVC on ceph-block (RBD, RWO)** — it **survives VM reboots** and `virtctl stop/start` (same VMI, same PVC; cloud-init runs **once** on first boot via an on-disk semaphore, so a reboot does **not** re-bootstrap). Good pet behavior.
- **The tension:** the skeleton uses `dataVolumeTemplates`, whose PVC lifecycle is **bound to the `VirtualMachine` object**. A GitOps prune/recreate of the VM (or an ArgoCD self-heal that deletes+recreates it) **deletes the disk and re-imports a fresh one** → cloud-init re-runs → **the team's in-VM work is wiped.** That is the immutable-vs-pet collision.
- **Recommendation:** switch the rootdisk to a **standalone `DataVolume`/PVC** (independent lifecycle) referenced by the VM as a `persistentVolumeClaim` volume, annotated `argocd.argoproj.io/sync-options: Prune=false` + a Retain reclaim policy, so recreating the `VirtualMachine` does **not** touch the disk. This is a `skeleton-vm` chart change (git-served, no rebuild); **not yet implemented in this PR** — flagged because it interacts with the CDI import model and the VM-tier deny-test, and warrants a security-track look. **OPERATOR/SECURITY DECISION (D4).**
- **Stance to state explicitly to teams (docs):** the VM tier is a **PET** — mutable and persistent; GitOps will not reset in-VM state, and conversely **in-VM changes are NOT captured in git** (push work you care about back to the repo). This is the deliberate opposite of the container tiers' immutable posture.

### D5 — Teardown: a first-class VM de-provision path (the invisible-to-teardown gap)

**Problem.** The Backstage teardown UI (`capstone-tenants-backend` → `listTenants` → `teardownCore.teardownTenant`) enumerates **only** `tenants/_claims/*.yaml` (Crossplane `CapstoneTenant` claims) and tears a tenant down by `git rm`-ing that one claim file (→ ArgoCD prunes the XR → Crossplane cascade-deletes). VM tenants have **no** claim — they deploy from the git **directory** generator over `tenants/team-<team>/vm/`. So a VM tenant is **creatable but not tear-down-able through the portal** — an admin would have to hand-`git rm` the tree (a `kubectl`-for-devs violation, and easy to leave orphans).

**Options weighed** (both need a backend rebuild — the compiled TS teardown backend cannot learn about VM tenants without a code change):

1. **`_vm-claims/` ledger marker (RECOMMENDED).** VM onboarding emits an **inert** marker `tenants/_vm-claims/<team>-<app>.yaml` (this PR — `skeleton-vm-ledger` + the `fetch-vm-ledger` step; **no rebuild** on the emit side). `listTenants` gains a second scan of `_vm-claims/`; `teardownTenant` removes the marker **and** its `teardownPath` (`tenants/team-<team>/`). *Pros:* preserves `listTenants`'s uniform "one ledger file per tenant" contract + `TenantSummary` shape; a stable delete-key + display metadata with no manifest parsing; symmetric with the `_claims` model the code already embodies. *Con:* a marker to keep in sync (mitigated: it is emitted once by the same scaffolder run that renders the tree).
2. **Second live source (scan `tenants/team-*/vm/`).** `listTenants` also scans team dirs for a `vm/` subtree; teardown removes the tree. *Pro:* no new file (no drift). *Con:* couples `listTenants` to the directory layout + more GitHub API calls; no partial no-rebuild win. 

**Chosen: option 1** — reuse of the existing ledger-file mental model wins, and the emit half ships now with no rebuild.

**Why removing the tree is sufficient + reclaims the disk.** `git rm -r tenants/team-<team>/` → the `tenants` ApplicationSet's directory generator drops the `tenant-<team>` bootstrap App (automated `prune`) → ArgoCD prunes the VM AppProject, the `<team>-vm-envs` ApplicationSet (→ its `<team>-vm-prod` Application → the `VirtualMachine`/`DataVolume`/`Service`/`Ingress`/cloud-init `Secret`), and the `<team>-vm-prod` **namespace**. Namespace GC then deletes the rootdisk **PVC**; because `ceph-block` is `reclaimPolicy: Delete`, the **RBD image is freed — no orphan**. This is exactly why the D4 pet-disk decoupling must be done at the **ArgoCD layer (`Prune=false`), NOT a PV `Retain`**: `Prune=false` stops an *in-life* VM-recreate from wiping the disk, while still letting *teardown* (namespace deletion) reclaim it. A PV `Retain` would orphan the RBD image on teardown — explicitly rejected.

### D6 — Backend change spec (rebuild-gated follow-up; specified, not compiled here)

Precise, minimal changes to `plugins/scaffolder-backend-module-capstone/src/teardownCore.ts` (admin-authz spine, octokit-via-App, archive+topic-strip all **unchanged**):

- `TenantSummary`: add `layout?: 'container' | 'vm'` and `teardownPaths: string[]` (container = `[claimPath]`; VM = `[markerPath, 'tenants/team-<team>']`).
- `readTeardownConfig`: add `vmClaimsDir` (default `tenants/_vm-claims`).
- `listTenants`: after the `_claims` scan, scan `_vm-claims/` the same way; mark those rows `layout: 'vm'` and set `teardownPaths` from the marker's `teardownPath` (read via the existing `scanField`). Rows sort/merge into one list — the UI is unchanged.
- `teardownTenant`: branch on `layout`. Container path is as-is. VM path removes **multiple files** — the marker + every file under `tenants/team-<team>/` — which the per-file `deleteFile` API can't do atomically; use the **Git Trees API**: read the base tree, build a new tree with the `team-<team>/` subtree + the marker blob removed, create one commit, point the teardown branch at it, open the PR. (Same PR/branch/confirm-name/admin flow; the body explains the directory-generator prune + PVC/RBD reclaim instead of the Crossplane cascade.)
- Archive-repo + strip-`capstone-tenant`-topic on `UA-MIS/<appName>`: **identical** to container teardown.

This is the one rebuild in the whole VM-tenant workstream; it is small and localized to `teardownCore.ts` (+ its tests). Everything else (structural fix, SSH auth, the ledger emit) is git-served and rebuild-free.

## Consequences

- **Positive:** a VM tenant becomes what the operator described — SSH in, clone, run, persist. Key-based auth + password-off closes the `changeme` hole. The in-cluster Service + netpol are transport-agnostic, so the interim (C) and the durable native path (A) share one design with zero rework.
- **Negative / open:** true native `ssh` (A/B) is **blocked on a public-TCP-entrypoint decision** (Spectrum $ or a public IP) — until then teams use browser SSH (C). Per-port muxing (A) means teams use `ssh -p 22NN`, not bare `:22`. The pet-disk change (D4) trades GitOps reproducibility for persistence (intended) and needs a security review. Public SSH — even key-only, even per-tenant — is a new attack surface the security track must sign off (fail2ban/rate-limit at the entrypoint, per-tenant netpol scoping already in place).

## What this PR implements vs. defers

- **Implemented (unambiguous, git-served, NO Backstage rebuild):** `sshPubKey` wizard input; cloud-init `ssh_authorized_keys` + `ssh_pwauth: false`; per-tenant `<app>-ssh` ClusterIP Service; the `_vm-claims/` teardown-ledger emit (`skeleton-vm-ledger` + `fetch-vm-ledger` step + the ledger dir/README); this ADR.
- **D2 resolved (this PR, 2026-07-14):** public SSH transport = Cloudflare Tunnel SSH
  (Option C interim + Option D opt-in), reusing the existing $0 tunnel — see the
  RESOLVED note under D2 and `docs/operator/vm-ssh-cloudflare-access.md`. The
  in-cluster half (netpol + docs + onboarding-PR checklist) is git-served; the
  Cloudflare Public Hostname + Access application are still a per-tenant **operator
  dashboard step** (not automatable without a Cloudflare API token in-hand).
- **Deferred to operator/security decision:** D3 auto-clone deploy-key, D4 standalone-DataVolume pet disk (with `Prune=false`, not PV `Retain`).
- **Deferred to a deliberate backend rebuild (specified in §D6):** `listTenants`/`teardownTenant` consuming the `_vm-claims/` ledger + Git-Trees directory removal. This is the ONE rebuild in the workstream.
- None of the deferred items blocks the Part-A structural fix, the key-based-auth baseline, or the ledger emit.
