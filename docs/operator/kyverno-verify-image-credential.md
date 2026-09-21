# SEC-043 — Harbor credential for `verify-image-signature`

## Why

Kyverno's `verify-image-signature` ClusterPolicy (Audit mode) fetches every
Harbor-hosted image's manifest to check its cosign signature. With no registry
credential it hits Harbor **anonymously** and gets `401 UNAUTHORIZED`, which the
PolicyReport records as a verification failure — indistinguishable from
"genuinely unsigned." That noise is why the reports were unusable.

## What was minted (agent-completed, 2026-09-21)

A Harbor **system-level, pull-only** robot, scoped to `namespace: "*"` (every
project) because the policy's `imageReferences` is
`harbor.capstone.uamishub.com/*` — it must be able to read any project's
manifest, but must never push to any of them:

```
POST http://harbor-core.harbor.svc:80/api/v2.0/robots
{
  "name": "kyverno-verify", "duration": -1, "level": "system",
  "permissions": [{"kind": "project", "namespace": "*",
                   "access": [{"resource": "repository", "action": "pull"}]}]
}
```

Result: robot id `1657`, name `robot$kyverno-verify`. Verified via an in-cluster
job (not persisted, no live workload touched):
- anonymous GET on a private-project manifest → `401`
- same request with the robot's basic-auth creds → `200` (full manifest returned)
- the same creds attempting a blob-upload POST (push) → `401` — confirms pull-only

## What still needs a human (agents are classifier-gated from prod secret
writes — same rule as `docs/operator/in-cluster-db-tier-runbook.md` §2)

Write the robot's username/password into Vault at the path the
`harbor-kyverno-verify` ExternalSecret already reads
(`platform-services/kyverno/externalsecret-harbor-verify.yaml`). No Vault
policy change is needed — `secret/data/platform/*` is already covered by the
`external-secrets-ro` policy.

```sh
kubectl -n vault exec -i vault-0 -- \
  env VAULT_CACERT=/vault/userconfig/vault-server-tls/ca.crt sh <<'EOF'
vault kv put secret/platform/harbor/kyverno-verify \
  username='robot$kyverno-verify' \
  password='<the robot secret — delivered out-of-band, not in this file>'
EOF
```

The actual robot secret was reported directly to the operator in-session (never
committed to git or logged to a durable file). If it's ever needed again: Harbor
UI → Robot Accounts → `kyverno-verify` (id 1657) → regenerate, or re-run the
mint job below and overwrite the Vault value — regenerating invalidates the old
secret immediately, so update Vault in the same breath.

Re-mint job (idempotent name reuse will 409 if the robot still exists — delete
it first in the Harbor UI, or pick a new name and update the ExternalSecret's
remote key + `imageRegistryCredentials.secrets` together):

```sh
kubectl -n harbor delete job harbor-robot-kyverno-verify --ignore-not-found
cat <<'JOB' | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata: {name: harbor-robot-kyverno-verify, namespace: harbor}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: robot
        image: curlimages/curl:8.11.1
        env:
        - {name: HARBOR_ADMIN_PASSWORD, valueFrom: {secretKeyRef: {name: harbor-admin, key: HARBOR_ADMIN_PASSWORD}}}
        command: ["/bin/sh","-eu","-c"]
        args:
        - >-
          curl -sS -u "admin:$HARBOR_ADMIN_PASSWORD"
          -X POST http://harbor-core.harbor.svc:80/api/v2.0/robots
          -H 'Content-Type: application/json'
          -d '{"name":"kyverno-verify","duration":-1,"level":"system","description":"Kyverno verify-image-signature (SEC-043) — cluster-wide PULL ONLY, no push, any project","permissions":[{"kind":"project","namespace":"*","access":[{"resource":"repository","action":"pull"}]}]}'
JOB
kubectl -n harbor wait --for=condition=complete --timeout=60s job/harbor-robot-kyverno-verify
kubectl -n harbor logs job/harbor-robot-kyverno-verify   # {"name":..,"secret":..} — paste into the vault kv put above
kubectl -n harbor delete job harbor-robot-kyverno-verify
```

## Verifying it worked

```sh
kubectl -n kyverno get externalsecret harbor-kyverno-verify   # SecretSyncError -> True once Vault has the value
kubectl -n kyverno get secret harbor-kyverno-verify -o jsonpath='{.type}'  # kubernetes.io/dockerconfigjson
```

Fresh admissions (new pod/replicaset rollouts after the value lands) should
start producing genuine `pass`/`fail` PolicyReport results instead of
`UNAUTHORIZED`-flavored `fail`. Existing reports are stale until their owning
resource is re-admitted — `background: false` on this policy means there is no
periodic rescan.

## When Enforce becomes realistic

Not yet, and not close. Using the minted robot creds, a one-off in-cluster check
(2026-09-21) probed every distinct `harbor.capstone.uamishub.com/*` image
referenced by a currently-running pod (50 images) for a cosign `.sig` OCI
artifact at its digest: **0 of 46 checked were signed** (4 errored resolving a
digest — multi-arch/`@sha256`-pinned refs — not counted either way). Every live
tenant workload today predates PR #672 (scaffolder cosign-signing). Flipping to
Enforce today would block 100% of running workloads. Re-run this check
periodically as tenants rebuild through the signing scaffolder; Enforce becomes
worth considering once a large majority of live images carry a `.sig` — until
then Audit is correct and the report's job is just to make "signed" vs
"unsigned-but-authenticated" visible, not to gate anything.
