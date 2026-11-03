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

## The same blind spot, on the discovery side

This ledger exists because VM tenants were invisible to **teardown**. They are subject to
the identical failure on the **discovery** side: `vm-app/template.yaml` applies the
`capstone-tenant` topic exactly as the container templates do, and without it the catalog
never ingests the repo and the portal cannot see the tenant — healthy, serving, and
absent. On 2026-10-07 two of the three VM tenants here were in that state.

So `hack/tenant-onboarding-reconcile.py` reads **this directory as well as**
`tenants/_claims/`, and its `CLAIM_SOURCES` entry is what makes VM tenants covered rather
than silently skipped. The first draft read only `_claims/` and printed a clean result over
all three VM tenants — if a third tenant kind is ever added, add it to `CLAIM_SOURCES` or
the check will be confidently wrong rather than merely incomplete (it raises on an
unrecognised `kind` for exactly this reason).

Note the schema difference the check has to account for: VM ledgers keep `team`/`appName`
at the **top level**, while `CapstoneTenant` claims nest them under `spec:`.

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
