# Gotchas & hard-won lessons

Each of these cost real time. Skim the headings; read the one that bites you. The
substrate-level gotchas (Talos, Rook-Ceph, Cilium, sops/age, the secret leak) live
in `docs/OPERATIONS-AND-HANDOFF.md` §7 — this page is the platform-services and
process layer.

---

## Process / methodology

### Copy-not-reference was the root of ~14 onboarding bugs

The single biggest bug generator was **copying** per-tenant config (CI chains,
manifests, robot wiring) into each new repo instead of **referencing** a shared
base. Every copy drifted, and each drift was its own bug: project missing,
`harbor-push` collisions, `__PRNUM__`/`__TEAM__` never substituted, appName/repo
mismatch, ESO whitelist gaps, malformed RBAC names. The fixes are structural, not
one-off patches:

- **Reusable CI:** one `tenant-build.yaml` reusable workflow
  (`on: workflow_call`, tagged `@v1`); each repo ships a tiny caller, not a copy of
  the chain.
- **Referenced base:** [Crossplane onboarding](crossplane-onboarding.md) renders
  the whole tenant from one reviewed Composition, so each former bug becomes a
  reconciling resource that "can't recur."

**Lesson for the successor:** when you find yourself about to copy a config block
into a new tenant/repo, stop — make it a reference (reusable workflow, shared
template, Composition field) instead.

### Verify PR ground truth against `origin`/`gh`, never a stale local worktree

Multiple bugs came from reasoning about, applying, or reviewing **stale local
files** — an old branch, an un-pulled checkout, a leftover render worktree, or a
PR pin to a branch that had since been deleted/force-pushed. The platform runs
several git worktrees at once, which makes this easy to do.

- Before reviewing or merging, read the bytes from origin:
  `git show origin/main:<path>` or `gh` API — not your local copy.
- Before `make bootstrap-reapply`, check out a clean `origin/main` and `git pull`
  (it applies the files **on disk**, not git — see [ArgoCD & GitOps](argocd-gitops.md)).
- When pinning a security clearance to a SHA, re-read the file bytes on each branch
  move; a CLEAR pinned to a since-deleted branch caught us once.

### Spawn parallel code agents with worktree isolation

Multi-track work (the tracks behind ESO, Crossplane, observability, reusable CI)
was built by spawning parallel agents, **each in its own git worktree**, so they
never clobbered each other's working tree. When you delegate parallel changes, give
each agent an isolated worktree rather than sharing one checkout.

### Agent mutual-deference loops

Two teammates each "conforming to the other's value" oscillates forever (a
scale-set name churned four times this way). Fix with **one-way authority**: the
committed config is the sole truth, the consumer build-reads it, the producer is
frozen — and adjudicate disputes via `git show HEAD` bytes, not prose or stale
commits.

---

## Vault / ESO

### ESO stale-reconcile after a Vault restart

After **any** vault-0 restart, pod delete, or migration, ESO may show
`InvalidProviderConfig` (a stale cached connection). Fix:

```bash
kubectl -n external-secrets rollout restart deploy external-secrets
```

This is the most common Vault-adjacent operator action — see
[Secrets & ESO](secrets-eso.md).

### Vault transit `encrypt` needs `create` **and** `update` capability

A transit auto-unseal policy that grants only `update` on `transit/encrypt/...`
isn't enough — the first encrypt against a path needs `create` too. Grant both
`create` and `update` (not just `update`) on the encrypt/decrypt paths, or the main
Vault can't seal/unseal against the unsealer.

### `OnDelete` StatefulSet strategy prevented an accidental Vault brick

The Vault StatefulSet uses `OnDelete`: spec changes do **not** auto-roll the pod —
you delete it to apply, on your schedule. An auto-roll into a bad config would have
sealed Vault with no operator present. Expect to delete `vault-0` deliberately
after a config change, and confirm it returns Ready (auto-unseals) before moving on.

---

## Shell (fish)

### fish has no heredoc → pipe a file

`<<EOF` fails at the fish prompt. For any Vault policy or JSON cred, write it to a
**file** (`printf '...' > /tmp/x.hcl`) and pipe/copy it in. A heredoc **inside** a
script piped to `sh` in a pod is fine — that runs under `sh`, not fish. See
[Runbooks](runbooks.md) for the file-piped patterns.

### `export VAR=value` silently fails in fish

It errors `Expected a string` and leaves the var unset — the root cause of a class
of empty-substitution bugs. Use `set -x VAR value`.

---

## ArgoCD / install-owned objects

### "Looks merged but nothing happened" — install-owned objects

`bootstrap/argocd-install/` and `bootstrap/platform-appproject.yaml` are **not
GitOps-reconciled**. Merging a `bootstrap/` PR updates git but leaves the live
cluster stale until `make bootstrap-reapply` — and that applies the files **on
disk**, so run it from a fresh `origin/main`. Symptom: a new app sits
`InvalidSpecError "repo not permitted"`.

### The `argocd-cm` SSA wipe

A bare `kubectl apply -k bootstrap/argocd-install --server-side --force-conflicts`
wipes `argocd-cm.data` (SSO + theme break) via a stale-annotation CSA→SSA prune.
Never run that bare apply — use `make bootstrap-reapply` (hardened + verified). See
[ArgoCD & GitOps](argocd-gitops.md).

### "Synced/Healthy" is not proof it works

An app can be green with every pod in `ImagePullBackOff`, and a **hook-only** app
shows green while its hook never ran (a sync hook only fires during a sync
*operation*; if nothing is OutOfSync, no operation starts). Make post-config jobs
**regular** resources with `Force=true,Replace=true,ServerSideApply=false` and drop
`ttlSecondsAfterFinished`. Always assert the real pods/behavior, not just the
ArgoCD tile. `make verify-image-pull` checks the registry-mirror failure class.

---

## KubeVirt VM tenants

### A VM guest with no IP reports as perfectly healthy

Every Kubernetes-side signal for a KubeVirt VM is about the **launcher pod**, not the
guest. Measured on `paper-papas`, 2026-08-31: VMI `Running` + `Ready`, `<app>-ssh`
Service holding a live Endpoint, guest booted to a login prompt with sshd listening —
and the guest had not transmitted a single frame in three days. The Endpoint exists
because the launcher pod has an IP; the guest's own network is invisible to all of it.

The decisive check is one command, and it is upstream of every NetworkPolicy:

```bash
kubectl exec -n <team>-vm-prod <launcher-pod> -c compute -- ip -s link show tap0
```

`RX: 0 bytes 0 packets` = the guest never spoke. Nothing in Cloudflare or in a
NetworkPolicy can produce that number, so stop debugging them.

**Read the failure kind, not just the failure.** From `ns/cloudflared` to the VM's
`:22` — `No route to host` means the policy let you through and the guest is not
answering ARP (no IP); `timed out` means a policy dropped you; `Connection refused`
means the guest is up and sshd is not. On 2026-08-31 `:22` gave EHOSTUNREACH while
`:80` from the same pod timed out, which cleared the `:22` policy in one shot.

### Two artifacts nobody knows exist, and both are better than `virtctl console`

- **The full guest boot log** is retained as a sidecar container:
  `kubectl logs -n <ns> <launcher-pod> -c guest-console-log`. `virtctl console` only
  shows what the guest prints *after* you attach, and on an image whose kernel
  cmdline lacks `console=ttyS0` it shows nothing at all.
- **A PNG screenshot of the guest's VGA console**, via a subresource:
  `kubectl get --raw "/apis/subresources.kubevirt.io/v1/namespaces/<ns>/virtualmachineinstances/<vm>/vnc/screenshot"`.
  This is how "is the guest even booted?" was answered in seconds after a silent
  serial console had made it look dead.

### Guest networking dies on the SECOND boot if netplan is MAC-pinned

KubeVirt masquerade gives the guest **the launcher pod's MAC**, and the CNI
regenerates that MAC for every pod — so the guest's MAC changes on every restart.
Without an explicit `networkData`, cloud-init writes a fallback netplan pinned to
`match: {macaddress: ...}`, and it will not rewrite it later because
`default_update_events = {NETWORK: {BOOT_NEW_INSTANCE}}` and a restart keeps the same
instance-id. First boot works; the first restart strands the VM forever.

Invisible on an ephemeral `containerDisk` (every boot is a first boot) — it only bites
VMs on a persistent rootdisk PVC, which is every real tenant. That asymmetry is worth
remembering: **a reproduction on a containerDisk will tell you the bug does not
exist.**

Fixed in the scaffold with two independent belts — name-matched `networkData` in
`virtualmachine.yaml`, and `updates: {network: {when: ['boot']}}` in
`cloud-init.yaml` — both enforced by `make validate` step 11 and by the tenant repo's
`.devops/ci/validate-vm.py`. Full write-up: [VM tenant SSH](vm-ssh-cloudflare-access.md).

Repairing a VM that is **already** stranded takes **two** restarts, not one: at the
local stage cloud-init reads the user-data it cached on the previous boot, so the boot
that first delivers the new user-data is still driven by the old copy. Measured, after
the one-restart version of this advice was written and turned out to be wrong.
Rebuilding the VM is one step instead of two.

### `ns/cloudflared` is PodSecurity `restricted` — a naive probe fails silently

`kubectl run busybox` there is rejected at admission. **A probe that cannot run looks
exactly like a service that is down.** Give probe pods `runAsNonRoot`, `runAsUser`,
`seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`,
`capabilities.drop: [ALL]`, and use an image already pullable in that namespace
(`python:3.12-slim`).

---

## Harbor

### Harbor v2.15 removed the legacy per-project robots API

`POST /api/v2.0/projects/<name>/robots` returns `NOT_FOUND` even when the project
exists. Use the **unified** `POST /api/v2.0/robots` with `level: project` and the
project in `permissions[].namespace`; the returned `name` is prefixed
`<project>+<name>` (that's the docker username). The `make harbor-robot` targets
already do this — see [Harbor](harbor.md).

### Shared `harbor-push` is last-write-wins

One shared `harbor-push` secret on the single org-wide scale set means only one
team's push cred is live at a time. The per-team model (one scale set per team,
`harbor-push-<team>`, `runs-on: <team>-kaniko`) — rendered declaratively by
Crossplane onboarding — is the fix.

### Image tags are 12-char short-sha, not 7

CI tags images with a **12-char** short-sha (`cut -c1-12`), not the 7-char form git
and GitHub display. An ApplicationSet image bump that copies the 7-char display sha
gets `ImagePullBackOff`. Read the pushed tag from the build log.
