# ${{ values.appName }}

${{ values.description }}

Scaffolded by **The Process** onto the UA-MIS capstone platform golden path.

## Quick start

1. Clone this repo and edit `app/` (your code). Leave `.devops/` alone.
2. Run the tests: `cd app && go test ./...`.
3. Open a pull request — a **preview** environment is built automatically.
4. Merge to `main` — **dev** auto-deploys.
5. Tag `vX.Y.Z` — **staging** auto-deploys; **prod** waits on the manual gate.

## Deployment targets

| Environment | URL |
| --- | --- |
| dev | `https://${{ values.appName }}.${{ values.team }}.dev.<platform-domain>` |
| staging | `https://${{ values.appName }}.${{ values.team }}.staging.<platform-domain>` |
| prod | `https://${{ values.appName }}.${{ values.team }}.<platform-domain>` |

## The `.devops/` contract

The platform owns everything under `.devops/`. Your only knobs are the four fields in
`.devops/app-metadata.yaml` (`team`, `semester`, `app-name`, `port`).

## Secrets

Your team's secrets live as **SealedSecrets** under `.devops/secrets/`. You do **not**
run `kubeseal` yourself — open the **Secrets** tab on your component in The Process,
enter a key/value and the target env(s), and it opens a PR that adds
`.devops/secrets/<key>.sealedsecret.yaml`. Merge it and ArgoCD applies it. Secrets are
**write-only** (you can't read a sealed value back; to change one, set it again). See
`.devops/secrets/README.md` for the full pattern.

## Switching to a Debian/Ubuntu base image (apt) — read before you do

The starter is Go-on-`scratch`, which needs no `apt`. If you switch a build or runtime
stage to a Debian-family base (`node:*-slim`, `python:*-slim`, `debian:*-slim`, …) and
run `apt-get`, your CI build will fail on the platform runners **unless** you use the
bootstrap block shipped (commented) in `app/Dockerfile`. Two platform facts cause it:

- The CI runner's egress allows external **:443 only** (no external :80) — Debian apt
  defaults to `http://…` (:80) and is blocked, so you must rewrite apt sources to HTTPS.
- Slim Debian bases ship **no `ca-certificates`** bundle, so the first HTTPS fetch can't
  verify the cert — bootstrap with peer-verify off for that one fetch to install
  `ca-certificates`, then verify normally afterward.

Copy the verbatim block from the bottom of `app/Dockerfile` into any Debian-base stage
that runs `apt`. It is the exact, proven pattern the platform's own images use.

> Base images are pulled from Docker Hub today. At cohort scale this can hit Docker Hub
> rate limits; when the platform's pull-through cache is available, prefer pulling your
> base via the platform Harbor proxy (the platform team will announce the `FROM` host).
