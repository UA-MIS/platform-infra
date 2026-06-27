# Phase-2 scaffolder cutover — imperative onboarding → CapstoneTenant XR (ADR-031)

This is the **Phase-2** template change (ADR-031 §11). It is **documented, not yet
applied** to `template.yaml`, because flipping it before Crossplane is installed and a
hand-applied XR is proven (Phase 0/1) would emit XRs to a Composition that does not
exist — breaking onboarding. Apply this cutover only **after**:

1. `platform-services/crossplane/` is installed (the 4 ArgoCD apps healthy), and
2. a hand-applied `CapstoneTenant` XR stands up a working tenant end-to-end.

The emit action (`capstone:emit-tenant-claim`) is **already shipped + registered**
(inert until the template references it).

## What changes in `template.yaml`

**Keep** (the hybrid, ADR-031 §9a — repo CONTENT stays Backstage-templated):
- step `fetch-skeleton` (`fetch:template`)
- step `publish` (`publish:github`)
- step `register` (`catalog:register`)

**Remove** the three imperative platform steps:
- `harbor-onboard` (`capstone:harbor-onboard`)
- `render-tenant` (`capstone:render-tenant`)
- `tenant-pr` (`publish:github:pull-request` — the human-merged onboarding PR)

**Add** in their place (the zero-touch seam):

```yaml
    # 5) Emit the ONE CapstoneTenant XR (ADR-031). A reviewed-once Crossplane
    #    Composition expands it into the full tenant (repo wiring + Harbor + Vault +
    #    the k8s tenancy fence). No render-tenant, no onboarding PR, no operator make.
    - id: emit-claim
      name: Emit tenant claim (CapstoneTenant XR)
      action: capstone:emit-tenant-claim
      input:
        team: ${{ parameters.team }}
        appName: ${{ parameters.appName }}
        semester: ${{ parameters.year }}-${{ parameters.season | lower }}
        port: ${{ parameters.port }}
        targetPath: ./claim

    # 6) Commit the XR to platform-infra main — NO PR, NO human merge (ADR-031 §7
    #    Option A). The platform GitHub App is on the branch-protection BYPASS LIST
    #    for tenants/_claims/**, so this commits directly. ArgoCD (platform-crossplane-
    #    claims) syncs it; Crossplane reconciles. Two ways to realize the direct commit:
    #      (a) a `publish:github:pull-request` to platform-infra with auto-merge enabled
    #          for the App (simplest with built-in actions), OR
    #      (b) a small `capstone:commit-to-main` action (Octokit createOrUpdateFileContents
    #          on main via the App) — the cleanest realization of "no PR". Pick at Phase 2.
```

## Why the claim file, not a direct cluster apply

Keeps cluster-write creds off the web-facing Backstage backend, gives a git audit
ledger, and makes de-provisioning `git rm tenants/_claims/<team>-<app>.yaml`
(consistent with the existing `platform.capstone/semester` cohort-GC model). See
ADR-031 §7 (Option A chosen over Option B).

## ⚠ App overlay / skeleton MUST drop the ESO plumbing at cutover

The Crossplane Composition OWNS the per-tenant ESO plumbing — it renders the
`vault-tenant` **SecretStore**, the `vault-ca` **ConfigMap**, and the `eso-tenant`
**ServiceAccount** in each tenant namespace. So at cutover the app overlay / scaffolder
skeleton (`.devops/chart/overlays/*/`) **must DROP its own copies** of:

- `secretstore.yaml` (the `vault-tenant` SecretStore), and
- the `vault-ca` ConfigMap (if shipped there).

If both the overlay and the Composition ship them, they become **dual-owner** objects
→ ArgoCD `SharedResourceWarning` blocks sync (the exact harbor-pull #123 class of bug
this whole effort eliminates). The app overlay keeps ONLY the **consumer**
ExternalSecrets it owns (`app-secrets`, `harbor-pull`) — those read from the
Composition-owned SecretStore. One owner per object.

## Output text update

The current template's "one thing is gated: a platform onboarding PR ... a reviewer
must merge it" copy becomes: *"nothing is gated — your namespaces/RBAC/Harbor/Vault
are provisioned automatically; give it a minute."*
