# tenants/crimson-copies-stripped-vm

Tenancy bootstrap for **crimson-copies-stripped**, deployed as a KubeVirt VM
rather than as a container tenant.

Rendered from `tenants/_template-vm/` (`__TEAM__`/`__APPNAME__` =
`crimson-copies-stripped`, `__SEMESTER__` = `2026-fall`) with three deliberate
differences, all confined to this rendered copy — **the blueprint is untouched**:

1. **`application-vm.yaml` replaces the blueprint's `applicationset-vm.yaml`.**
   The ApplicationSet sources the VM chart from the app repo's `.devops/` tree,
   which this tenant deliberately does not have — it is the student-start
   template, pinned to `60c1fbd`. A plain `Application` syncs the manifests from
   `tenants/_vm-workloads/crimson-copies-stripped` instead, which the VM
   AppProject already permits (`platform-infra` is one of its `sourceRepos`).
   See that directory's README for the full rationale.

2. **Quota and LimitRange bumped** — the blueprint sizes a ~4Gi guest that is
   merely *run*; this guest also *builds* the app under software emulation, so it
   gets 8 vCPU / 8Gi with explicit CPU limits. RAM is still not overcommitted
   (`requests == limits`). The LimitRange max had to move with it: its default
   `cpu: 1` limit would otherwise both throttle and outright reject the launcher.

3. **A sixth NetworkPolicy, `allow-egress-vm-external-https`.** The blueprint's
   five give the guest DNS + intra-namespace egress only; its single
   `0.0.0.0/0:443` rule is `podSelector`-scoped to the CDI importer, not to the
   VM. This guest provisions itself on first boot (apt, github.com, the npm
   registry), so without a `:443` grant on the virt-launcher pod, cloud-init
   hangs silently — and the guest has no working sshd to debug from. Scoped to
   `:443` only, reusing the blueprint's `except` list verbatim so nothing
   in-cluster becomes reachable.

## Layout

```
vm/appproject-vm.yaml        the VM-kind fence (rendered as-is)
vm/application-vm.yaml       syncs the guest from platform-infra
vm/namespaces/vm-prod.yaml   namespace + quota + limitrange + 6 netpols + RBAC
```

The guest itself lives in `tenants/_vm-workloads/crimson-copies-stripped/`.
