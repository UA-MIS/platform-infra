# Harbor pull cred (zero-touch) — runbook

**Bug #7 (onboarding chain).** A freshly-scaffolded zero-touch tenant's workload
`ImagePullBackOff`s on its **own** private image because the `harbor-pull`
image-pull Secret is never materialized in the tenant namespace:

```
Failed to pull image ".../<team>/<app>:<tag>": ... unauthorized
Warning FailedToRetrieveImagePullSecret  Unable to retrieve some image pull secrets (harbor-pull)
```

## Root cause

The zero-touch harbor-pull chain has two halves:

| Half | Owner | Status before fix |
|------|-------|--------------------|
| **Producer** — pull `RobotAccount` → connection secret `<team>-harbor-pull` (crossplane-system) → `PushSecret` → Vault `tenants/<team>/<env>/harbor-pull` (property `secret`) | Crossplane Composition (track-5) | ✅ worked (PushSecret `Synced`) |
| **Consumer** — an `ExternalSecret` in `<team>-<env>` that reads that Vault path and templates the `kubernetes.io/dockerconfigjson` Secret named `harbor-pull` | *nobody* | ❌ **missing** |

The Composition's design comment delegated the consumer to the tenant's app
overlay ("track-4"), but that consumer was **never shipped** — the zero-touch
skeleton overlay ships only `app-secret` / `database` ExternalSecrets, and the old
`make harbor-robot` SealedSecret path was retired for zero-touch tenants. So the
token reached Vault but never became a usable pull cred in the namespace. The
workload `ServiceAccount` still sets `imagePullSecrets:[harbor-pull]`, so the kubelet
logs `FailedToRetrieveImagePullSecret` and the pod never pulls.

## The fix (PR — `platform-services/crossplane/apis/composition.yaml`)

track-5 (the Composition) now **owns the consumer** too, rendering one
`harbor-pull` `ExternalSecret` per env (`dev`/`staging`/`prod`) into
`<team>-<env>` via a `provider-kubernetes` `Object`. It is symmetric with the
already-proven ARC `harbor-push-<team>` ExternalSecret in the same file:

- reads the platform **`vault-backend` ClusterSecretStore** (Vault key
  `tenants/<team>/<env>/harbor-pull`, property `secret`);
- templates a `kubernetes.io/dockerconfigjson` with the **deterministic** robot
  username `robot$<team>+<team>-pull` (unified-API `<project>+<robot>` prefix —
  the token is the only thing in Vault; the username is derived from `$team`);
- `dependsOn` the namespace Object + the harbor-pull PushSecret Object
  (provision-before-deploy → no ImagePullBackOff flap on first sync);
- `creationPolicy: Owner`, default `deletionPolicy: Retain` (a transient Vault
  miss won't yank a working pull cred from a running pod).

**Single owner:** the app overlay deliberately ships **no** harbor-pull, so there
is no dual-owner / ArgoCD `SharedResourceWarning` (verified: no tenant repo commits
a harbor-pull SealedSecret). The skeleton comments were updated to say "do not add
an overlay-owned harbor-pull" so nobody reintroduces the race.

**No Backstage rebuild required.** The fix lives in the Crossplane Composition,
synced by the `crossplane-apis` ArgoCD Application. The skeleton edits are
comment-only (documentation) and do not gate the fix.

### Preview namespaces
`<team>-preview` is intentionally **not** covered (its namespace is
ArgoCD-created, not a Composition Object, so there is no ns Object to gate on;
preview is security-gated and off by default). Follow-up if a preview-enabled
tenant needs private pulls: render a preview ES reading the `dev` Vault path.

## Recovery for the EXISTING `meow` tenant

The Composition change auto-heals every existing zero-touch tenant on the next
reconcile. Two paths:

### A. GitOps (preferred — zero manual secrets)
1. Merge the PR.
2. Sync the `crossplane-apis` Application (or wait for auto-sync):
   ```
   kubectl -n argocd annotate app crossplane-apis argocd.argoproj.io/refresh=hard --overwrite
   ```
3. Crossplane re-renders the `meow` `CapstoneTenant` XR and creates
   `xp-meow-{dev,staging,prod}-harborpull-es`. Confirm the ES + Secret land:
   ```
   kubectl get externalsecret harbor-pull -n meow-dev        # STATUS SecretSynced / READY True
   kubectl get secret harbor-pull -n meow-dev                # type kubernetes.io/dockerconfigjson
   ```
4. Clear the stuck pods so they re-pull immediately:
   ```
   kubectl -n meow-dev delete pod -l app=meow-app
   ```
   The Deployment recreates them; they should pull and go `1/1 Running`.

### B. Immediate live unblock (before the PR merges)
Apply the identical ExternalSecret by hand — it is byte-for-byte what the
Composition will manage, so GitOps adopts it with no drift and there is only ever
one ES named `harbor-pull` per namespace (no dual-owner):

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: harbor-pull
  namespace: meow-dev            # repeat for meow-staging, meow-prod
  labels:
    platform.capstone/component: tenant
    platform.capstone/team: meow
    platform.capstone/env: dev
spec:
  refreshInterval: "1h"
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: harbor-pull
    creationPolicy: Owner
    template:
      type: kubernetes.io/dockerconfigjson
      data:
        .dockerconfigjson: |
          {"auths":{"harbor.capstone.uamishub.com":{"username":"robot$meow+meow-pull","password":"{{ .secret }}","auth":"{{ printf "%s:%s" "robot$meow+meow-pull" .secret | b64enc }}"}}}
  data:
    - secretKey: secret
      remoteRef:
        key: tenants/meow/dev/harbor-pull    # staging/prod for the other envs
        property: secret
```

```
kubectl apply -f harbor-pull-meow-dev.externalsecret.yaml
kubectl get secret harbor-pull -n meow-dev          # appears within refresh
kubectl -n meow-dev delete pod -l app=meow-app      # clear the backoff
```

## Verify green

```
kubectl get pods -n meow-dev                 # meow-app  1/1 Running
kubectl get externalsecret harbor-pull -n meow-dev   # READY True, SecretSynced
```

## Notes / invariants
- The pull robot is **project-level** and pull-only (least privilege); the same
  token is written to all three env Vault paths.
- Do **not** add a harbor-pull SealedSecret/ExternalSecret to any tenant app
  overlay — that reintroduces the dual-owner race the Composition-owned model
  eliminates.
- Do not churn the pull `RobotAccount`'s `name`/`permissions` in the Composition
  post-onboarding: goharbor regenerates the token on replacement-forcing changes,
  forcing a one-time re-pull for every tenant (see the RobotAccount block header).
