# ${{ values.appName }} — bring your own code

**Your code goes here.** This repo was scaffolded as a *blank / bring-your-own-code* project:
it ships a tiny placeholder app so it is **green on the very first CI build and deploy** — you
replace it with your real app, incrementally, and stay green the whole way.

## What to do

1. **Replace the placeholder.** Delete `main.go` (and this starter) and add your own app, in
   any language or framework you like.
2. **Put your build in the `Dockerfile`.** Edit the multi-stage `Dockerfile` to build and run
   *your* app. It is a normal Dockerfile — the platform CI builds it with Kaniko.
3. **Keep two contracts and you stay green:**
   - **Listen on `$PORT`.** The platform sets the `PORT` environment variable; bind to it
     (default `8080`). Don't hardcode a different port.
   - **Answer `GET /healthz` with `200`.** The liveness/readiness probes hit `/healthz`; keep
     it returning 200 and **independent of any database**, so the pod stays Ready even before a
     database is provisioned.

## Don't touch `.devops/`

`.devops/` (and `.github/`) are the platform's deployment machinery — the kustomize/Helm chart,
the CI workflows, and the components + promotion model. Leave them as-is; they already know how
to build your `Dockerfile` and deploy it. Change your **app** and your **`Dockerfile`**,
nothing else, and every push to `main` deploys.

## Need a database?

Add a `DATABASE_URL` via The Process **Secrets** tab (or pick a database in the New Project
wizard) and read it from the environment — a standard `mysql://…` / `postgres://…` URL. The
placeholder uses no database, so your repo is green with or without one.
