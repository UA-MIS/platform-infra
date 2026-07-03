# VM path — wire the Harbor provisioner cred for `capstone:harbor-onboard`

**Audience:** platform operator (keyboard/cluster access). Agents cannot do the seal +
apply — those are cluster writes behind the classifier gate.

**What this unblocks:** the "New Capstone VM" (`new-capstone-vm`) scaffolder — the
KubeVirt / no-Docker tenant path — currently fails at step **4b `capstone:harbor-onboard`**
with:

```
capstone:harbor-onboard: `capstone.harbor.username` and `capstone.harbor.secret` are
required (the dedicated least-privilege provisioner robot). Refusing to call Harbor
unauthenticated.
```

Once the two keys below are sealed into `backstage-process-secrets`, the VM path completes
end to end.

---

## Root cause (why it fails today)

Two halves; only the second is still missing:

1. **Config (DONE — PR #114 + PR #222).** The action reads `capstone.harbor.baseUrl`,
   `capstone.harbor.username`, `capstone.harbor.secret`, `capstone.harbor.oidcGroupPrefix`
   from the Backstage backend config
   (`platform-services/backstage/app/plugins/scaffolder-backend-module-capstone/src/actions/harborOnboard.ts`,
   `readHarborConfig`). The keys are **flat** (`username`/`secret`, not
   `provisioner.username`). The Helm overlay
   `applicationsets/backstage-process-app.yaml` (the ONLY app-config the chart loads)
   already carries the matching block:

   ```yaml
   capstone:
     harbor:
       baseUrl: http://harbor-core.harbor.svc:80
       username: ${HARBOR_PROVISIONER_USERNAME}
       secret: ${HARBOR_PROVISIONER_SECRET}
       oidcGroupPrefix: UA-MIS
   ```

   The two `${...}` values interpolate from env vars injected by
   `backstage.extraEnvVarsSecrets: [backstage-process-secrets]`.

2. **Credential (MISSING — this runbook).** `backstage-process-secrets` does **not** yet
   contain `HARBOR_PROVISIONER_USERNAME` / `HARBOR_PROVISIONER_SECRET`. A Backstage
   config placeholder for an unset env var interpolates to empty → `getOptionalString`
   returns undefined → the action throws the "required" error above and never calls Harbor.

**The fix is to seal those two keys — reusing the robot that already exists.**

---

## Reuse the existing robot (do NOT mint a new one)

The container/Crossplane path already uses a system-level Harbor robot **`robot$provisioner`**
(project-create + robot + member admin — a superset of the `project:create` + `member:create`
this action needs). Its live token is in `crossplane-system/harbor-provider-creds` (sealed at
`platform-services/crossplane/creds/harbor-provisioner-creds-sealed.yaml`, JSON key
`credentials` = `{"url":...,"username":"robot$provisioner","password":"<token>"}`).

Reuse it: one system provisioner robot serves both the container (Crossplane) and VM
(Backstage) paths — no second robot, no second thing to rotate.

---

## Operator steps

Run from a checkout of `platform-infra`, on a branch (never commit sealed changes straight
to `main`). Controller coordinates are the repo standard:
`--controller-namespace kube-system --controller-name sealed-secrets-controller`.

```bash
export KUBECONFIG=clusters/real-talos/talos-kubeconfig
git checkout -b seal/backstage-harbor-provisioner

# 1) Pull the EXISTING robot$provisioner creds that Crossplane already uses. The
#    SealedSecret controller has decrypted them into a live Secret in crossplane-system.
CREDS=$(kubectl -n crossplane-system get secret harbor-provider-creds \
          -o jsonpath='{.data.credentials}' | base64 -d)
HARBOR_USER=$(echo "$CREDS" | jq -r .username)    # -> robot$provisioner
HARBOR_SECRET=$(echo "$CREDS" | jq -r .password)  # -> the live token
echo "username = $HARBOR_USER"                     # sanity-check the username only
test "$HARBOR_USER" = 'robot$provisioner' || echo "WARN: unexpected username"
#   (Fallback if you kept the token from the Crossplane go-live reseal: just set
#    HARBOR_USER='robot$provisioner' and HARBOR_SECRET=<that saved token> by hand.)

# 2) Seal the TWO new keys, scoped to backstage/backstage-process-secrets (strict scope:
#    the input Secret name MUST equal the SealedSecret CR name so the ciphertext can be
#    pasted into the existing file). Emit to stdout — do NOT --merge-into the committed
#    file (repo convention: --merge-into reparses/reflows YAML; hand-paste instead).
kubectl create secret generic backstage-process-secrets \
  --namespace backstage \
  --from-literal=HARBOR_PROVISIONER_USERNAME="$HARBOR_USER" \
  --from-literal=HARBOR_PROVISIONER_SECRET="$HARBOR_SECRET" \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
    --format yaml

unset CREDS HARBOR_SECRET   # clear plaintext from the shell after sealing
```

3) From that output, copy the two `spec.encryptedData` entries
   (`HARBOR_PROVISIONER_USERNAME` and `HARBOR_PROVISIONER_SECRET`) and **paste them into
   the existing** `platform-services/backstage/sealedsecret-oidc.yaml`, under
   `spec.encryptedData`, alongside the 6 current keys (`AUTH_OIDC_CLIENT_ID`,
   `AUTH_OIDC_CLIENT_SECRET`, `BACKEND_SECRET`, `GITHUB_APP_CLIENT_SECRET`,
   `GITHUB_APP_PRIVATE_KEY`, `POSTGRES_PASSWORD`). Leave those 6 untouched; leave the
   `template.metadata` (name `backstage-process-secrets`, namespace `backstage`) as-is.

4) Commit on the branch, open a PR, merge. ArgoCD (`platform-services-appset`, auto-sync)
   applies the updated SealedSecret; the controller decrypts it and the two new keys land in
   the `backstage-process-secrets` Secret.

```bash
git add platform-services/backstage/sealedsecret-oidc.yaml
git commit -m "seal(backstage): HARBOR_PROVISIONER_* (reuse robot\$provisioner) for capstone:harbor-onboard"
git push -u origin seal/backstage-harbor-provisioner
# open + merge the PR (branch protection = the gate)
```

5) **Roll the Backstage pod** so it re-reads the enlarged secret as env vars (env changes
   are injected at container start; a running pod won't pick them up). `Recreate` strategy:

```bash
kubectl -n backstage rollout restart deployment/backstage
kubectl -n backstage rollout status  deployment/backstage --timeout=180s
```

### Verify the credential is wired

```bash
# both keys now present in the live secret:
kubectl -n backstage get secret backstage-process-secrets \
  -o jsonpath='{.data.HARBOR_PROVISIONER_USERNAME}{"\n"}{.data.HARBOR_PROVISIONER_SECRET}{"\n"}' \
  | head   # both lines must be non-empty base64

# the env vars are visible inside the running pod (username only — never echo the secret):
kubectl -n backstage exec deploy/backstage -- printenv HARBOR_PROVISIONER_USERNAME
#   -> robot$provisioner
```

---

## Full `new-capstone-vm` runthrough (end to end)

**Prereqs:** the credential steps above are done and the pod rolled; the operator can sign
in to The Process as a UA-MIS member who is on the `team` slug they will use (or is a
`labmx` platform-staff admin — the action's SEC-020 ownership check requires one or the
other). KubeVirt + CDI installed and KVM confirmed on the Talos nodes (ADR-032 open Q1) —
required for the VM to actually RUN, not for the scaffold to succeed.

1. **Open the wizard.** The Process → **Create** → **"New Capstone VM (no Docker)"**
   (`template.metadata.name: new-capstone-vm`).

2. **Fill the fields.** `appName` (DNS-1123 label, e.g. `legacy-inventory`), `team` (your
   canonical team slug, must match a GitHub Team you're on), `season`/`year`,
   `baseImage` (default public Fedora containerDisk is fine for a first run), vCPUs/RAM/disk,
   `port`. Run it.

3. **What to expect, step by step:**
   - `preflight` — passes (no repo/catalog/tenant name collision).
   - `fetch-skeleton-vm` — renders the VM chart (VirtualMachine + DataVolume on ceph-block
     + cloud-init + Service/Ingress + validation-only CI).
   - `publish` — creates `github.com/UA-MIS/<appName>` (private, branch-protected).
   - `register` — the component appears in the catalog.
   - **`harbor-onboard` — the step that used to fail now SUCCEEDS.** It authenticates as
     `robot$provisioner` and idempotently creates the private, auto-scan Harbor project
     `<team>` and maps OIDC group `UA-MIS:<team>` → Developer. Re-runs are safe (409 =
     already exists = OK). Logs show `project '<team>' created.` (or `already exists`).
   - `render-tenant` — renders `tenants/team-<team>/` from `tenants/_template/`.
   - `tenant-pr` — opens the review-gated onboarding PR to `UA-MIS/platform-infra`
     (`onboard-vm-team-<team>`).

4. **Grant (reviewer).** Review + **merge** the onboarding PR. On merge, `tenants-appset`
   reconciles the `<team>-vm-prod` tier (baseline PSA namespace, VM-sized quota, the
   AppProject whitelist for `kubevirt.io/VirtualMachine` + `cdi.kubevirt.io/DataVolume`).
   No push robot is needed (no image build); a pull robot is needed only if `baseImage` is a
   **private** containerDisk (that command is in the PR body).

5. **The student merges their repo to `main`.** CI validates the VM manifests (no Kaniko
   build). ArgoCD deploys the VirtualMachine; CDI imports the disk; cloud-init runs the app
   on first boot.

### Verify the VM comes up

```bash
export KUBECONFIG=clusters/real-talos/talos-kubeconfig
NS=<team>-vm-prod

# Harbor project exists (created by harbor-onboard):
#   Harbor UI -> Projects -> <team>  (private, auto-scan)

# CDI imports the disk, then the VM starts:
kubectl -n "$NS" get datavolume,pvc                     # DataVolume -> Succeeded, PVC Bound
kubectl -n "$NS" get vm,vmi                              # VirtualMachine -> Running; VMI Running
kubectl -n "$NS" get vmi <appName> -o jsonpath='{.status.phase}{"\n"}'   # -> Running

# App reachable at the ingress host once cloud-init's starter is up:
curl -fsS https://<appName>.capstone.uamishub.com/ -o /dev/null -w '%{http_code}\n'   # -> 200
```

If `harbor-onboard` still reports the "required" error after all this: the pod was not
rolled (step 5) or the paste in step 3 landed under the wrong CR name/namespace — re-check
`kubectl -n backstage exec deploy/backstage -- printenv HARBOR_PROVISIONER_USERNAME`.
