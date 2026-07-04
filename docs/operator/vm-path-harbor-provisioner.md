# VM path — mint the scoped Backstage Harbor robot for `capstone:harbor-onboard`

**Audience:** platform operator (keyboard/cluster access). Agents cannot mint the robot,
seal, or apply — those are Harbor/cluster writes behind the classifier gate.

**What this unblocks:** the "New Capstone VM" (`new-capstone-vm`) scaffolder — the
KubeVirt / no-Docker tenant path — currently fails at step **4b `capstone:harbor-onboard`**
with:

```
capstone:harbor-onboard: `capstone.harbor.username` and `capstone.harbor.secret` are
required (the dedicated least-privilege provisioner robot). Refusing to call Harbor
unauthenticated.
```

Once the robot below is minted and its two keys are sealed into `backstage-process-secrets`,
the VM path completes end to end.

---

## Decision — D-M4-3: a dedicated, scoped Backstage Harbor robot (NOT a reuse)

**Decision.** `capstone:harbor-onboard` authenticates as its own **dedicated** system-level
Harbor robot (proposed name `robot$backstage-provisioner`), scoped to the exact minimum the
action calls, and its credential lives **only** in `backstage/backstage-process-secrets`.

**Why not reuse `robot$provisioner` (the Crossplane provider robot):**

1. **ADR-031 isolation.** ADR-031's Decision fixes the providers' admin creds "**only** in
   `crossplane-system` … **never in Backstage**." Copying `harbor-provider-creds` into the
   `backstage` namespace would break that isolation and widen the web-facing backend's trust.
2. **It's a placeholder.** `platform-services/crossplane/creds/harbor-provisioner-creds-sealed.yaml`
   is a committed placeholder ciphertext (won't decrypt) until Crossplane go-live (#129,
   unapplied) — so a reuse wouldn't even work today.
3. **Least privilege.** `robot$provisioner` also holds robot-admin (project + robot + member).
   The Backstage robot needs only project-create + member-create, so a separate identity is a
   smaller blast radius on the internet-facing component.

**Scope (verified against `harborOnboard.ts`)** — the action makes exactly two write calls:

| Action call | Harbor API | Required robot permission |
| --- | --- | --- |
| create the private, auto-scan project `<team>` | `POST /api/v2.0/projects` | **system** scope, `resource: project`, `action: create` |
| map OIDC group `UA-MIS:<team>` → Developer | `POST /api/v2.0/projects/<team>/members` | **project** scope (all projects, `namespace: "*"`), `resource: member`, `action: create` |

Nothing else (no repository push/pull, no robot-create, no delete). This is a security-scope
choice on a web-facing component, hence a logged decision.

> **Operator: mirror D-M4-3 into the canonical decision log.** The authoritative
> `artifacts/context/decision-log.md` is maintained by the orchestrator (not in this repo's
> tree). Add the D-M4-3 entry there as well so the log stays complete.

---

## Root cause (why it fails today)

Two halves; only the second is still open:

1. **Config (DONE — PR #114 + PR #222).** The action reads `capstone.harbor.baseUrl`,
   `capstone.harbor.username`, `capstone.harbor.secret`, `capstone.harbor.oidcGroupPrefix`
   from the Backstage backend config
   (`platform-services/backstage/app/plugins/scaffolder-backend-module-capstone/src/actions/harborOnboard.ts`,
   `readHarborConfig`). The keys are **flat** (`username`/`secret`, not
   `provisioner.username`). The Helm overlay `applicationsets/backstage-process-app.yaml`
   (the ONLY app-config the chart loads) already carries the matching block:

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
   contain `HARBOR_PROVISIONER_USERNAME` / `HARBOR_PROVISIONER_SECRET`. An unset env var
   interpolates to empty → `getOptionalString` returns undefined → the action throws the
   "required" error above and never calls Harbor.

**The fix is to mint the scoped robot (D-M4-3) and seal its two keys.**

---

## Operator steps

Run from a checkout of `platform-infra`, on a branch (never commit sealed changes straight
to `main`). Controller coordinates are the repo standard:
`--controller-namespace kube-system --controller-name sealed-secrets-controller`.

### 1) Mint the dedicated scoped robot (Harbor v2.15 unified API)

Harbor v2.15 removed the legacy per-project robots endpoint; all robot creation goes through
`POST /api/v2.0/robots` (see [harbor.md](harbor.md) "The unified robots API"). Authenticate
as `admin` (creating a system robot needs admin), in-cluster against `harbor-core.harbor.svc`.

```bash
set -euo pipefail
export KUBECONFIG=clusters/real-talos/talos-kubeconfig

# admin cred — never leaves the cluster (read straight from the harbor ns)
HARBOR_ADMIN_PASSWORD=$(kubectl -n harbor get secret harbor-admin \
  -o jsonpath='{.data.HARBOR_ADMIN_PASSWORD}' | base64 -d)

# Mint a SYSTEM-level robot with EXACTLY project:create (system) + member:create (all
# projects). duration -1 = non-expiring. Run this from a pod/shell that can reach
# harbor-core.harbor.svc (e.g. `kubectl -n harbor exec` into a core pod, or a debug pod).
ROBOT_JSON=$(curl -sS -u "admin:${HARBOR_ADMIN_PASSWORD}" \
  -H 'Content-Type: application/json' \
  -X POST http://harbor-core.harbor.svc:80/api/v2.0/robots \
  -d '{
        "name": "backstage-provisioner",
        "description": "Backstage capstone:harbor-onboard — project:create + member:create ONLY (D-M4-3; cred lives ONLY in backstage ns, ADR-031-clean).",
        "duration": -1,
        "level": "system",
        "permissions": [
          { "kind": "system",  "namespace": "/", "access": [ { "resource": "project", "action": "create" } ] },
          { "kind": "project", "namespace": "*", "access": [ { "resource": "member",  "action": "create" } ] }
        ]
      }')
unset HARBOR_ADMIN_PASSWORD

# Parse the one-time name + secret from the response.
HARBOR_USER=$(echo "$ROBOT_JSON" | jq -r '.name')     # e.g. robot$backstage-provisioner
HARBOR_SECRET=$(echo "$ROBOT_JSON" | jq -r '.secret')

# HARD FAIL if the mint did not return a usable credential — do NOT proceed to seal an
# empty secret (that would deploy an empty env var and the action would still fail closed).
test -n "$HARBOR_USER"   && [ "$HARBOR_USER"   != "null" ] || { echo "ERROR: robot name empty — mint failed: $ROBOT_JSON" >&2; exit 1; }
test -n "$HARBOR_SECRET" && [ "$HARBOR_SECRET" != "null" ] || { echo "ERROR: robot secret empty — mint failed: $ROBOT_JSON" >&2; exit 1; }
echo "minted robot: $HARBOR_USER"     # username only — never echo the secret
```

> If the robot already exists (409) on a re-run, delete the old one in the Harbor UI
> (Administration → Robot Accounts) or via `DELETE /api/v2.0/robots/<id>` and re-mint — the
> secret is shown only once, so a lost token means a fresh robot.

### 2) Seal the two keys into `backstage-process-secrets`

Strict scope: the input Secret name MUST equal the SealedSecret CR name
(`backstage-process-secrets`) and namespace (`backstage`) so the ciphertext can be pasted
into the existing file. Emit to stdout — do **not** `--merge-into` the committed file (repo
convention: `--merge-into` reparses/reflows YAML and strips header comments; hand-paste
instead — see [argocd-gitops.md](argocd-gitops.md)).

```bash
# still in the same shell (HARBOR_USER / HARBOR_SECRET set + asserted non-empty above)
kubectl create secret generic backstage-process-secrets \
  --namespace backstage \
  --from-literal=HARBOR_PROVISIONER_USERNAME="$HARBOR_USER" \
  --from-literal=HARBOR_PROVISIONER_SECRET="$HARBOR_SECRET" \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
    --format yaml

unset HARBOR_SECRET ROBOT_JSON   # clear plaintext from the shell after sealing
```

3) From that output, copy the two `spec.encryptedData` entries
   (`HARBOR_PROVISIONER_USERNAME` and `HARBOR_PROVISIONER_SECRET`) and **paste them into the
   existing** `platform-services/backstage/sealedsecret-oidc.yaml`, under `spec.encryptedData`,
   alongside the 6 current keys (`AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`,
   `BACKEND_SECRET`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`,
   `POSTGRES_PASSWORD`). Leave those 6 untouched; leave `template.metadata` (name
   `backstage-process-secrets`, namespace `backstage`) as-is.

4) Commit on the branch, open a PR, merge. ArgoCD (`platform-services-appset`, auto-sync)
   applies the updated SealedSecret; the controller decrypts it and the two new keys land in
   the live `backstage-process-secrets` Secret.

```bash
git add platform-services/backstage/sealedsecret-oidc.yaml
git commit -m "seal(backstage): HARBOR_PROVISIONER_* (dedicated scoped robot, D-M4-3) for capstone:harbor-onboard"
git push -u origin seal/backstage-harbor-provisioner
# open + merge the PR (branch protection = the gate)
```

5) **Roll the Backstage pod** so it re-reads the enlarged secret as env vars (env is injected
   at container start; a running pod won't pick it up). `Recreate` strategy:

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

# the env var is visible inside the running pod (username only — never echo the secret):
kubectl -n backstage exec deploy/backstage -- printenv HARBOR_PROVISIONER_USERNAME
#   -> robot$backstage-provisioner
```

---

## Full `new-capstone-vm` runthrough (end to end)

**Prereqs:** the mint + seal steps above are done and the pod rolled; the operator can sign
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
     `robot$backstage-provisioner` and idempotently creates the private, auto-scan Harbor
     project `<team>` and maps OIDC group `UA-MIS:<team>` → Developer. Re-runs are safe
     (409 = already exists = OK). Logs show `project '<team>' created.` (or `already exists`).
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

If it instead fails with `create project '<team>' failed: HTTP 403` or `map group … failed:
HTTP 403`, the robot's permissions are too narrow — re-mint per step 1 with BOTH access
entries (system `project:create` **and** project `member:create` at `namespace: "*"`).
