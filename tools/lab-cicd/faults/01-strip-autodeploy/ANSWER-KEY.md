# Fault 01 — answer key (course staff only)

## The bug

`fault.patch` removes the `branches: [main]` line from the `push:` trigger in
`.github/workflows/build-and-push.yaml`, leaving only `tags: ["v*.*.*"]` and
`pull_request:`. GitHub Actions only starts a `build-and-push` run for events
that match a declared trigger — a merge to `main` (a `push` event with
`ref: refs/heads/main`) no longer matches anything, so the workflow simply
never runs. No error is raised anywhere; GitHub just doesn't schedule it.

Because `build-and-push` never runs, its `bump-dev` job (which rewrites
`.devops/chart/overlays/dev/kustomization.yaml`'s `images[].newTag` and
commits it) never runs either — so the dev overlay never changes, and ArgoCD
has nothing new to sync. `dev` stays on whatever tag was last actually built.

## The concept (what this teaches)

`.devops/promotion.yaml` is the team's own documented contract for what
triggers each environment:

```yaml
dev:
  trigger: "branch:main"
  ...
```

`.github/workflows/build-and-push.yaml` is supposed to *implement* that
contract, but nothing enforces that the two files agree — they're both
hand-authored YAML, and it's entirely possible (as here) for the workflow
file to drift out of sync with what the promotion contract says it should do.
The lesson: when a promotion path stops working, don't just assume the CI
platform is broken — cross-reference the declared contract
(`promotion.yaml`) against the file that's supposed to implement it
(`build-and-push.yaml`'s `on:` block), the same way you'd audit any other
config-as-code pair that's supposed to stay in lockstep but isn't
automatically kept that way.

## The fix

Restore the `branches: [main]` trigger:

```yaml
on:
  push:
    branches: [main]          # -> dev image (mutable sha tag), pushed
    tags: ["v*.*.*"]          # -> prod/staging image (immutable semver), pushed
  pull_request:
```

## Verifying recovery

1. Merge a trivial PR (or push directly if branch protection allows) to
   `main`.
2. Confirm a `build-and-push` run appears in the Actions tab for that commit
   and goes green.
3. Confirm `.devops/chart/overlays/dev/kustomization.yaml`'s `newTag` changes
   in a follow-up commit authored by `ua-mis-ci` (the `bump-dev` job).
4. If the repo is wired to a live ArgoCD Application, confirm it picks up the
   new tag on its next sync.
