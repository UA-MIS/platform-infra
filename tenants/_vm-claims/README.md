# tenants/_vm-claims — the VM-tenant teardown ledger (ADR-032a)

One small **inert marker file** per live VM tenant: `tenants/_vm-claims/<team>-<app>.yaml`.
The `New Capstone VM` scaffolder writes it into the onboarding PR alongside
`tenants/team-<team>/`.

## Why this exists

VM tenants are **not** Crossplane-provisioned. They deploy from the git **directory**
generator (`applicationsets/tenants-appset.yaml`) over `tenants/team-<team>/vm/`, so they
have **no `tenants/_claims/<team>-<app>.yaml` CapstoneTenant claim**. The Backstage
teardown UI (`capstone-tenants-backend` → `listTenants`) enumerates **only**
`tenants/_claims/*.yaml`, so a VM tenant would be **invisible to teardown** — creatable
through the portal but not de-provisionable (violating the "no `kubectl` for devs"
principle). This ledger closes that gap: `listTenants` also reads `_vm-claims/`, and each
marker carries the metadata + the `teardownPath` the teardown PR removes.

## Inert by construction

`_vm-claims` is underscore-prefixed, so **every** tenant generator skips it:
- the `tenants` ApplicationSet excludes `tenants/_*`;
- `platform-crossplane-claims` syncs only `tenants/_claims` (not `_vm-claims`).

Nothing ever tries to apply `kind: VmTenantLedger`. These files are a ledger, not a
manifest.

## Teardown contract

Tearing down a VM tenant = a PR that `git rm`s **both** the marker **and** its
`teardownPath` (`tenants/team-<team>/`). On merge:

1. the `tenants` ApplicationSet drops the `tenant-<team>` bootstrap App;
2. ArgoCD prunes the VM AppProject + the `<team>-vm-envs` ApplicationSet +
   the `<team>-vm-prod` namespace;
3. namespace GC deletes the `VirtualMachine`/`DataVolume` and **reclaims the rootdisk
   PVC** — `ceph-block` uses `reclaimPolicy: Delete`, so the RBD image is freed (no
   orphaned disk). The pet-disk decoupling in the VM chart is done at the **ArgoCD** layer
   (`Prune=false`), **not** a PV `Retain`, precisely so teardown still reclaims the disk.

Admin-only, repo-archive, and topic-strip are identical to container teardown
(`teardownCore.ts`). The `listTenants`/`teardownTenant` changes that consume this ledger
require a Backstage backend rebuild — see `artifacts/design/decisions/adr-032a-vm-tenant-access-ux.md` §D6.

## Marker schema

```yaml
apiVersion: platform.capstone/v1
kind: VmTenantLedger
metadata:
  name: <team>-<app>
team: <team>
appName: <app>
semester: <YYYY-season>
layout: vm
teardownPath: tenants/team-<team>
```
