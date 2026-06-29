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
| kubeseal --controller-namespace sealed-secrets --controller-name sealed-secrets --format yaml \
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
   snapshot role.
5. **ESO wiring:** the ESO Vault role + `ClusterSecretStore`
   ([Secrets & ESO](secrets-eso.md) §2–§3); then `make vault-onboard` per tenant.
6. **Netpols (security gate, manual-sync):**
   `argocd app sync platform-netpol-controlplane` and
   `... platform-netpol-runners`; run the deny-test before going internet-facing.
7. **Crossplane (optional, gated):** **(B)** above.
8. **Observability:** verify the monitoring stack and rotate the Grafana password
   + wire the `platform-oncall` receiver ([Observability](observability.md)).
