# Fault 03 — answer key (course staff only)

## The bug

`fault.patch` swaps the `overlay:` values for the `staging` and `prod` blocks
in `.devops/promotion.yaml`:

```diff
   staging:
-    overlay: ".devops/chart/overlays/staging"
+    overlay: ".devops/chart/overlays/prod"
   prod:
-    overlay: ".devops/chart/overlays/prod"
+    overlay: ".devops/chart/overlays/staging"
```

`gate:` values are untouched (`staging.gate: auto`, `prod.gate: manual`) — the
manual-approval step for prod still exists and still gets clicked, which is
exactly what makes this fault sneaky: the *process* looks correct (there's
still a gate, it still requires a human), but the human is approving the
promotion of the **wrong manifests** into `prod`.

On the platform side, `promotion.yaml` is read directly out of the app repo
by the tenant `ApplicationSet` via ArgoCD's git `files:` generator (see
`platform-infra/tenants/_template/applicationset-envs.yaml` — it uses
`(index .environments .env).overlay` verbatim as each Application's
`spec.source.path`). There is no independent platform-side copy of "which
overlay goes to which environment" to catch the swap — `promotion.yaml`
*is* the single source of truth, by design (its own header comment says so).
Swap it, and the platform faithfully deploys the swapped result; nothing
downstream double-checks the mapping.

## The concept (what this teaches)

A promotion pipeline can be structurally correct (two environments, each with
a declared trigger, overlay, and gate) while being *semantically* wrong (the
overlays are crossed). Config-as-code doesn't protect you from a config that
parses fine and is internally self-consistent but says the wrong thing — the
same class of mistake as accidentally swapping two variable assignments that
both compile. The fix requires understanding what the file is *supposed* to
mean, not just that it's well-formed YAML.

It's also a lesson in why the manual prod gate isn't a complete safety net by
itself: a human approving a sync only catches problems the human is actually
looking for. If nobody diffs the *rendered* manifest against what they
expect prod to look like, the gate rubber-stamps a mistake.

## The fix

Restore the correct pairing (self-evident once you read it carefully — the
overlay directory name should match the environment name):

```yaml
  staging:
    overlay: ".devops/chart/overlays/staging"
  prod:
    overlay: ".devops/chart/overlays/prod"
```

## Verifying recovery

1. `git revert` the fault commit (or hand-apply the inverse of `fault.patch`).
2. Push a new release tag (or force a resync of the existing one).
3. Confirm `staging`'s ArgoCD Application `spec.source.path` reads
   `.devops/chart/overlays/staging` and `prod`'s reads `.../overlays/prod`.
4. Confirm each namespace's actual Ingress host / replica count matches what
   its own overlay declares (not the other environment's).
