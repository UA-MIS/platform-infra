# Fault 01 — the auto-deploy trigger goes missing

## What you'll observe

You (or a teammate) merge a normal PR into `main`. Everything about the merge
itself looks fine — the PR's own checks were green, GitHub shows the merge
commit landed. But:

- Nothing new shows up under the repo's **Actions** tab for that merge commit.
  No `build-and-push` run at all — not failed, not queued, just absent.
- Your `dev` environment does not change. Whatever was last actually deployed
  stays deployed, even though `main` has moved on.
- `.devops/chart/overlays/dev/kustomization.yaml`'s `images[].newTag` value
  does not get bumped by CI the way it did before (or the way it's documented
  to).
- If you check ArgoCD, the `dev` Application looks **Synced** — but synced to
  the *old* manifest state, because nothing ever asked it to sync to a newer
  one. It is not "broken" in an obvious red way; it's just quietly stale.

The symptom is an absence, not an error — which is what makes it harder to
spot than a failing build.

## Where to look

- The Actions tab for the repo: is there a run at all for your merge commit?
- `.github/workflows/build-and-push.yaml`: what does its `on:` block actually
  say triggers a run?
- `.devops/promotion.yaml`: what does it *claim* triggers a deploy to `dev`?
  (Read the file's own header comment — it says where to look first.)

Compare those two answers.
