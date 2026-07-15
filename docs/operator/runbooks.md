# Operator runbooks

Ready-to-run, copy-pasteable keyboard procedures for the work that is **not yet
done** on the live platform, plus the from-scratch rebuild order.

> **Fish-safe.** The operator workstation shell is **fish**, which has **no
> heredoc** (`<<EOF` fails) and where `export VAR=value` silently fails (use
> `set -x VAR value`). Every command below avoids an outer-shell heredoc — policies
> are written to a **file** (with `printf`) and piped/copied in. Heredocs *inside*
> a script piped to `sh` in a pod are fine (that runs under `sh`, not fish).
>
> Set your context first:
> ```fish
> set -x KUBECONFIG (pwd)/clusters/real-talos/clusterconfig/talos-kubeconfig
> set -x KUBE_CONTEXT admin@capstone
> ```

---

## (A) #126 — snapshot CronJob auth

The `vault-raft-snapshot` CronJob (`platform-services/vault/raft-snapshot.yaml`,
daily `0 3 * * *`) authenticates to the main Vault via Kubernetes auth as SA
`vault-snapshot` (ns `vault`). The Vault-side **policy + role** are not created yet,
so the job fails `permission denied` until you run this once. See
[Vault & DR](vault-and-dr.md).

Needs a main-Vault root login. (k8s auth is already enabled per `vault/README.md`.)

```fish
# 1) Write the snapshot policy to a FILE (no heredoc) and copy it into vault-0.
printf '%s\n' 'path "sys/storage/raft/snapshot" { capabilities = ["read"] }' > /tmp/snapshot.hcl
kubectl -n vault cp /tmp/snapshot.hcl vault/vault-0:/tmp/snapshot.hcl

# 2) Log in to the MAIN Vault with the root token (paste it; it is not echoed by `read -s`).
#    `read` keeps the token out of fish history.
read -s -P "Vault root token: " VROOT
kubectl -n vault exec -i vault-0 -- vault login "$VROOT"

# 3) Create the policy from the file + the k8s-auth role (SA vault-snapshot, ns vault).
kubectl -n vault exec -i vault-0 -- vault policy write snapshot /tmp/snapshot.hcl
kubectl -n vault exec -i vault-0 -- vault write auth/kubernetes/role/snapshot \
    bound_service_account_names=vault-snapshot \
    bound_service_account_namespaces=vault \
    token_policies=snapshot token_ttl=10m

# 4) Clean up the local file + the token var.
rm -f /tmp/snapshot.hcl
set -e VROOT
```

### Verify a manual snapshot job writes a `.snap`

```fish
kubectl -n vault get cronjob vault-raft-snapshot
kubectl -n vault create job --from=cronjob/vault-raft-snapshot snap-test
kubectl -n vault wait --for=condition=complete job/snap-test --timeout=120s
kubectl -n vault logs job/snap-test            # expect "[snapshot] retained newest 14:" + a vault-raft-<UTC>.snap
kubectl -n vault delete job snap-test
```

If it fails `permission denied`, the policy/role didn't take — re-run step 3.
If it fails with a TLS error, `vault-server-tls` is missing `ca.crt` (re-issue the
cert from the cert-manager CA issuer; see the runbook §F).

---

## (B) #129 — Crossplane Phase-0

The full reasoning is in [Crossplane onboarding](crossplane-onboarding.md); the
authoritative cred scopes are in `platform-services/crossplane/creds/README.md`.
This is the condensed keyboard sequence. **Do it in order** — the providers stay
safely unauthenticated until the creds are real.

```fish
# 0) SRE review on origin/main (NOT a stale worktree):
#    platform-services/crossplane/rbac/provider-kubernetes-rbac.yaml   (the ClusterRole = blast radius)
#    platform-services/crossplane/apis/composition.yaml                (what gets minted)
#    platform-services/crossplane/creds/README.md                      (the scopes to grant)

# 1) Reseal the 3 provider creds with REAL, NON-ADMIN scoped values (per creds/README.md).
#    Build each JSON in a FILE (no heredoc), then create+seal+replace the stub. Example (GitHub App);
#    repeat for harbor-provider-creds (provisioner robot) and vault-provider-creds (tenant-provisioner token):
#    -- write /tmp/gh.json with your editor or printf, then:
kubectl create secret generic github-provider-creds \
  --namespace crossplane-system --from-file=credentials=/tmp/gh.json --dry-run=client -o yaml \
| kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller --format yaml \
  > platform-services/crossplane/creds/github-app-creds-sealed.yaml
rm -f /tmp/gh.json
#    (commit the resealed creds on a branch + PR; they decrypt only in-cluster.)

# 2) Create the two Vault roles the Composition needs (run inside vault-0, logged in as root).
#    The writer role is a committed SCRIPT (its heredoc runs under sh in the pod — fine):
read -s -P "Vault root token: " VROOT
kubectl -n vault exec -i vault-0 -- vault login "$VROOT"
kubectl -n vault exec -i vault-0 -- sh \
  < platform-services/external-secrets/vault-policies/crossplane-push-role.sh
#    tenant-provisioner policy (scope in creds/README.md): write a /tmp/tenant-provisioner.hcl FILE, then:
kubectl -n vault cp /tmp/tenant-provisioner.hcl vault/vault-0:/tmp/tp.hcl
kubectl -n vault exec -i vault-0 -- vault policy write tenant-provisioner /tmp/tp.hcl
#    (then mint a token with -policy=tenant-provisioner for the vault-provider-creds value in step 1.)
set -e VROOT; rm -f /tmp/tenant-provisioner.hcl

# 3) Merge the resealed-creds PR, then add the crossplane chart repo to the AppProject + VERIFY.
make bootstrap-reapply KUBE_CONTEXT=$KUBE_CONTEXT
kubectl -n argocd get appproject platform -o jsonpath='{.spec.sourceRepos}' | tr ',' '\n' | grep crossplane

# 4) Sync the stack in wave order.
argocd app sync platform-crossplane-core
argocd app sync platform-crossplane-runtime    # providers come up + AUTHENTICATE (check: kubectl get providers)
argocd app sync platform-crossplane-apis

# 5) Validate ONE XR end-to-end BEFORE opening the gate (cluster-side; agents can't):
crossplane render <xr.yaml> platform-services/crossplane/apis/composition.yaml \
  platform-services/crossplane/providers/functions.yaml
#    hand-apply one CapstoneTenant, confirm the full fan-out reconciles green, then:
argocd app sync platform-crossplane-claims
```

After one real tenant onboards zero-touch, do the template-side cutover that drops
the app-overlay SecretStore — see
`platform-services/backstage/templates/new-capstone-project/CROSSPLANE-CUTOVER.md`
and [Crossplane onboarding](crossplane-onboarding.md).

---

## (C) Rebuild-from-scratch merge/apply order

If you rebuild the platform onto a fresh cluster, the order is:

1. **Substrate (out-of-band, not GitOps):** Talos nodes + Cilium + Rook-Ceph per
   `docs/phase-4-runbook.md` and `docs/cilium-cni-runbook.md`. Wait for 3× nodes
   Ready and Ceph `HEALTH_OK`.
2. **Sealing-key continuance:** restore the Sealed Secrets sealing key and the
   sops/age key from the handoff vault **before** anything tries to decrypt
   committed SealedSecrets (`docs/OPERATIONS-AND-HANDOFF.md` §5). A new cluster
   without the migrated sealing key means every SealedSecret breaks.
3. **GitOps install:**
   ```fish
   make bootstrap TARGET=real-talos KUBE_CONTEXT=admin@capstone
   ```
   ArgoCD comes up and fans out platform-services + tenants. Re-run
   `make bootstrap-reapply` if any app shows `InvalidSpecError "repo not permitted"`
   (install-owned `sourceRepos`).
4. **Vault bring-up:** create `vault-server-tls`, init + unseal, enable KV v2 +
   k8s auth (`vault/README.md` §D), then the **auto-unseal** migration
   ([Vault & DR](vault-and-dr.md) / runbook §C–§D), then **(A)** above for the
   snapshot role. Once live, **(D)** below takes over day-to-day unsealing —
   no more manual Shamir typing on every restart.
5. **ESO wiring:** the ESO Vault role + `ClusterSecretStore`
   ([Secrets & ESO](secrets-eso.md) §2–§3); then `make vault-onboard` per tenant.
6. **Netpols (security gate, manual-sync):**
   `argocd app sync platform-netpol-controlplane` and
   `... platform-netpol-runners`; run the deny-test before going internet-facing.
7. **Crossplane (optional, gated):** **(B)** above.
8. **Observability:** verify the monitoring stack and rotate the Grafana password
   + wire the `platform-oncall` receiver ([Observability](observability.md)).

---

## (D) Vault auto-unseal via GitHub Actions (one-click + automatic)

**What this is for.** `vault-unsealer` (ns `vault-unsealer`, single-node, Shamir
3-of-5, MANUAL unseal by design — see [Vault & DR](vault-and-dr.md)) sits
sealed after every restart until a human types 3 Shamir shares. The main
3-node Vault auto-unseals *against* the unsealer via Transit, so a sealed
unsealer cascades into main-Vault raft-quorum loss and an ESO
`ClusterSecretStore` outage platform-wide — the 2026-07-13 incident (24h
outage) this automates away. The workflow lives in the private ops repo
`ccsmith33/capstone-ops-secrets` (NOT this repo) —
`.github/workflows/unseal-vault.yaml`, triggered by `workflow_dispatch` (the
button) or a `*/10 * * * *` cron. It checks
`https://vault-unsealer.vault-unsealer.svc:8200/v1/sys/seal-status` and, if
sealed, submits Shamir keys from `vault/unsealer-keys.txt` in that same repo
until the threshold is met.

### The button path (the normal way to unseal)

1. Go to `ccsmith33/capstone-ops-secrets` → **Actions** → **unseal-vault** →
   **Run workflow**.
2. Watch the run. It logs whether the unsealer was already unsealed
   (idempotent no-op) or had to submit keys, and fails LOUD (red X) if it's
   still sealed after trying every key in the file.

### Cron auto-heal (the normal way you never have to notice)

The same workflow runs on its own every 10 minutes. Almost every tick is a
fast no-op (already unsealed) — you only need the button for the rare case
where you want to confirm recovery immediately instead of waiting up to 10
min, or where the cron itself can't run (see the kill-switch and the
GitHub-App/runner-coverage caveat below).

### Incident kill-switch — `UNSEAL_PAUSED`

If you need to stop BOTH the cron and the button (e.g. investigating *why*
the unsealer keeps sealing, and you don't want the automation fighting your
diagnosis): in `capstone-ops-secrets` → **Settings → Secrets and variables →
Actions → Variables**, set `UNSEAL_PAUSED` to `true`. Every run then exits
with a notice and does nothing. Delete the variable (or set it back to
`false`) to resume.

### One-time setup (do this once, before you rely on the cron)

1. Get the unsealer's 5 Shamir shares from its ORIGINAL `vault operator init`
   output (this is the same material [Vault & DR](vault-and-dr.md) already
   tells you to write down offline — this is a second, git-tracked copy of it
   for automation). If that original output is gone, `vault operator rekey`
   the unsealer to mint a fresh set:
   ```fish
   kubectl -n vault-unsealer exec -it vault-unsealer-0 -- sh -c 'VAULT_SKIP_VERIFY=1 vault operator rekey -init -key-shares=5 -key-threshold=3'
   # then -nonce=<nonce> -key=<share> for each existing share to complete it
   ```
2. In `capstone-ops-secrets`, edit `vault/unsealer-keys.txt` — replace each
   `REPLACE_WITH_UNSEAL_KEY_N` placeholder line with one real key (one per
   line). Commit + push to `main`.
3. Set the repo Variable `UNSEAL_PAUSED` to `false` (or leave it unset —
   unset defaults to NOT paused).
4. Hand-run the workflow once (button path above) to confirm the keys are
   correct before trusting the cron.

**Where the plaintext keys live, and why:** see the header comment in
`unseal-vault.yaml` and the PR that introduced it. Short version — this
platform's ~3-person staff turns over every year, GitHub Actions Secrets are
write-only (a successor can't read them back out), and an automated job
holding a SOPS/age decryption key just relocates the same problem. The
trade-off (read access to `capstone-ops-secrets` = unseal capability, NOT
Vault-data-read capability) is accepted — keep that repo private.

### Runner coverage caveat

`capstone-ops-secrets` is a **personal** repo (`ccsmith33`), not under the
**UA-MIS** org. The ARC listener's GitHub App (`ua-mis-arc-runners`) is
installed on the UA-MIS org only — it does **not** cover personal-account
repos. Until `capstone-ops-secrets` is moved into UA-MIS (recommended — this
also serves the turnover goal: a personal-account repo is itself a
continuity risk) or an equivalent runner registration is added, the
workflow's `runs-on: ua-mis-kaniko` jobs queue with no listener to pick them
up, and NEITHER the button nor the cron actually unseals anything. Check
first: Actions tab on a run — if it says "Waiting for a runner" indefinitely,
this is why.

### Manual fallback — when GitHub/ARC themselves are down

If GitHub Actions or the ARC runners are unavailable (whatever caused THAT
outage), unseal by hand, 3 times (once per key, threshold 3-of-5):

```fish
kubectl exec -it -n vault-unsealer vault-unsealer-0 -- sh -c 'VAULT_SKIP_VERIFY=1 vault operator unseal'
# paste one Shamir share, repeat 2 more times (any 3 of the 5 in
# capstone-ops-secrets' vault/unsealer-keys.txt, or your offline copy)
```

Verify: `kubectl -n vault-unsealer exec -it vault-unsealer-0 -- vault status`
should show `Sealed  false`. The main Vault then auto-unseals on its own next
restart (or immediately, if it was already waiting on the unsealer) — no
further manual steps needed on the main Vault itself.
