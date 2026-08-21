# tenants/_vm-workloads/crimson-copies-stripped

The KubeVirt workload for the **crimson-copies-stripped** VM tenant: the guest
itself, its cloud-init, and its public surface.

## Why the VM manifests live here and not in the app repo

Every other VM tenant follows the blueprint (`tenants/_template-vm/`), whose
`applicationset-vm.yaml` syncs a VM chart out of the **app repo** at
`.devops/chart/overlays/prod`, discovered through `.devops/promotion.yaml`.

`crimson-copies-stripped` deliberately cannot do that. It is the **student-start
template**: its `main` is pinned to the reviewed pre-deploy commit `60c1fbd`, and
authoring a `.devops/` tree, Dockerfiles and build/promote workflows onto it is
precisely the work students do in later stories. Putting deploy infrastructure
back on that repo to satisfy the ApplicationSet would hand them the answer key —
the reason this tenant was moved off the container tier in the first place.

So the manifests live platform-side and a plain `Application`
(`tenants/crimson-copies-stripped-vm/vm/application-vm.yaml`) syncs this
directory. That does **not** widen the fence: the VM AppProject already lists
`UA-MIS/platform-infra` among its `sourceRepos` (identical to the container
project), and the destination is still only `crimson-copies-stripped-vm-prod`.

## Why the `_` prefix

`tenants/_*` is excluded from `applicationsets/tenants-appset.yaml`. That matters
here: the tenant bootstrap app syncs its directory with `recurse: true` into the
`argocd` namespace, so a VM manifest sitting inside `tenants/crimson-copies-stripped-vm/`
would be swept up and applied to the wrong namespace. Keeping the workload behind
the existing underscore exclusion avoids that without touching the appset.

## Contents

| File | What it is |
| --- | --- |
| `virtualmachine.yaml` | the guest — Ubuntu 24.04 via a CDI `DataVolume` on ceph-block, 8 vCPU / 8Gi, explicit CPU limits |
| `cloudinit-sealedsecret.yaml` | first-boot provisioning, sealed (it carries a read-only deploy key) |
| `service-ingress.yaml` | ClusterIP + Traefik Ingress for the storefront and staff hosts |

## The deployment this produces

Traditional, non-containerized, by design — it is the "before" state students are
given to modernize:

- Node 22, **MariaDB installed natively via apt** (not `docker run mysql`), and
  nginx on the box. No Docker anywhere on the guest.
- The app cloned at `60c1fbd`, built in place with pnpm, and run by the app
  repo's **own four systemd units**, installed verbatim from `deploy/vm/systemd/`.
- Demo accounts seeded by the repo's own `db:seed`: `staff` / `staffpass123` and
  `customer` / `customerpass123`.
- One instance. No dev/staging/prod split, no image registry, no ESO, no ArgoCD
  inside the app.

## Operating notes

- **Software emulation.** The cluster's KubeVirt CR still sets
  `useEmulation: true`, so this guest is QEMU TCG, not KVM. It works; first boot
  (pnpm install + two `next build`s) is just slow. Flipping that flag is a
  platform-wide change tracked separately and deliberately not bundled here.
- **No SSH.** The guest has no reachable sshd (a known ADR-032 gap). Observe a
  boot with `virtctl console vm/crimson-copies-stripped -n crimson-copies-stripped-vm-prod`,
  or read `http://<svc>:8080/log` from inside the namespace — port 8080 is on the
  Service but deliberately absent from the Ingress.
- **Egress.** The tier's blueprint netpols do not let the guest reach the
  internet at all (the one `0.0.0.0/0:443` rule is scoped to the CDI importer
  pod). `allow-egress-vm-external-https` in this tenant's namespace bundle grants
  the guest `:443` — without it, first boot hangs with no surfaced error.
- **Pet, not cattle.** RWO ceph, no live migration; a node drain cold-restarts
  the guest. State lives on the disk, and cloud-init does not re-run.
