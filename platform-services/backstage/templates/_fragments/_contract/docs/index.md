# ${{ values.appName }}

${{ values.description }}

Scaffolded by **The Process** onto the UA-MIS capstone platform golden path.

## What is in this repo
{% if values.single %}
This is a **single-component** app: one component, one image, one Deployment, one Ingress.
{%- else %}
This is the **frontend + backend** layout: two components in one repo, two images, two
Deployments, one Ingress routing `/api` to the backend and `/` to the frontend.
{%- endif %}

| Your code lives in | Role | Served at |
| --- | --- | --- |
{%- for c in values.components %}
| `${{ c.context }}/` | ${{ c.kind }} | `${{ c.path }}` |
{%- endfor %}

The components are declared in `.devops/components.yaml`. **Everything under `.devops/` is
owned by the platform — edit your code, leave that directory alone.**

## Quick start

1. Clone this repo and edit {% for c in values.components %}`${{ c.context }}/`{% if not loop.last %} + {% endif %}{% endfor %} — that is your code.
2. Run the tests with whatever your stack uses (`npm test`, `pytest`, `go test ./...`,
   `cargo test`, `mvn test`, `dotnet test`, `bin/rails test`, …). CI runs your stack's
   checks for you on every push and pull request — see
   `.github/workflows/build-and-push.yaml` for exactly what it runs.
3. Open a pull request — CI **builds and checks** your code. It does **not** deploy a
   preview environment (see below).
4. Merge to `main` — **dev** auto-deploys.
5. Tag `vX.Y.Z` — **staging** auto-deploys.
6. **prod** is promoted by a human running the **Promote to prod** workflow
   (`.github/workflows/promote-to-prod.yaml`, run manually from the Actions tab).

### About per-PR preview environments

Per-PR preview environments are **deferred on this platform and have never run for any
tenant**. A pull request builds and pushes an image, but nothing deploys it. If you see a
preview toggle or a preview overlay in this repo, it is inert — ignore it. Test your
changes in **dev** after merging.

## Why is my build "Queued"?

Builds run **2 at a time** to fit the shared cluster (the Kaniko runner scale set is
capped at two), so when several builds land close together the extra ones **wait their
turn** — GitHub shows them as **Queued** / *"Waiting for a runner"*. This is normal:
**nothing is broken, and you don't need to do anything** — your build starts automatically
the moment a build slot frees up.

Once a runner picks up your build, its **run Summary** (and, on a pull request, a pinned
comment) tells you **how long it waited** and **how many of this repo's builds were ahead
of it**. (A build that is still queued can't post this yet — it runs no code until a
runner starts it — so the note appears as soon as yours begins.)

## Deployment targets

| Environment | URL |
| --- | --- |
| dev | `https://${{ values.appName }}.dev.<platform-domain>` |
| staging | `https://${{ values.appName }}.staging.<platform-domain>` |
| prod | `https://${{ values.appName }}.<platform-domain>` |

## The `.devops/` contract

The platform owns everything under `.devops/`. Your knobs are the team/cohort fields in
`.devops/app-metadata.yaml` (`team`, `semester`, `app-name`, `port`) and the component
list in `.devops/components.yaml` (each component's build context, image, port, and
ingress path).

## Secrets

You do **not** put secret values in git. Open your component in The Process, go to the
**Secrets** tab, enter a key and value and pick the target environment(s). The portal
writes the **value** into your team's Vault path and opens a **pull request** that adds
the key name and a Vault pointer — never the value — to
`.devops/chart/overlays/<env>/app-secret.externalsecret.yaml`.

Merge that PR and ArgoCD applies it; the External Secrets Operator reads the value from
Vault and materializes the Kubernetes Secret your pod reads.

Secrets are **write-only**: you cannot read a value back through the portal, and to change
one you set it again. See `.devops/secrets/README.md` — that directory is the
human-facing documentation, **not** where the manifests live (a manifest there would sit
outside the kustomize chart root and ArgoCD would fail to build it).

## Switching to a Debian/Ubuntu base image (apt) — read before you do

If you switch a build or runtime stage in your Dockerfile to a Debian-family base
(`node:*-slim`, `python:*-slim`, `debian:*-slim`, …) and run `apt-get`, your CI build will
fail on the platform runners **unless** you use the bootstrap block shipped (commented) at
the bottom of your component's Dockerfile{% if not values.single %} (there is one per component){% endif %}. Two platform facts cause it:

- The CI runner's egress allows external **:443 only** (no external :80) — Debian apt
  defaults to `http://…` (:80) and is blocked, so you must rewrite apt sources to HTTPS.
- Slim Debian bases ship **no `ca-certificates`** bundle, so the first HTTPS fetch can't
  verify the cert — bootstrap with peer-verify off for that one fetch to install
  `ca-certificates`, then verify normally afterward.

Copy the verbatim block from the bottom of the relevant Dockerfile — {% for c in values.components %}{% if c.buildType != "mobile-artifact" %}`${{ c.context }}/${{ c.dockerfile }}`{% if not loop.last %}, {% endif %}{% endif %}{% endfor %} — into any Debian-base stage
that runs `apt`. It is the exact, proven pattern the platform's own images use.

> **Base images already come through the platform's Harbor pull-through cache.** Your
> Dockerfile's `FROM` lines point at `harbor.capstone.uamishub.com/dockerhub-proxy/…`, which
> proxies Docker Hub and keeps the cohort clear of Docker Hub's rate limits. Keep it that
> way — swapping a `FROM` back to a bare `docker.io` image is how a build starts failing
> with `toomanyrequests` halfway through the semester. (A few stages pull from
> `gcr.io/distroless` or `mcr.microsoft.com` instead; those are not Docker Hub and are not
> rate-limit exposed.)
