# Wizard go-live runbook — activate the unified "New Project" wizard in the running portal

The unified wizard (`templates/new-project/template.yaml`) is driven by a NEW scaffolder
backend action, **`capstone:compose-project`** (source: `platform-services/backstage/app/
plugins/scaffolder-backend-module-capstone/src/actions/composeProject.ts`). That action is
compiled INTO The Process image — it is **not** live until a portal image that contains it
is built and deployed. Registering the template in the catalog (done) is necessary but not
sufficient: without the new image the wizard renders but its `compose` step fails with
`action 'capstone:compose-project' is not registered`.

This is the standard **rebuild → bump → verify** flow for any change under
`platform-services/backstage/app/**`.

---

## 0. Prerequisite — merge the wizard PR

Merging the wizard PR (#154 + this companion) lands `app/plugins/...` on `main`. Because the
change touches `platform-services/backstage/app/**`, the merge commit **auto-triggers** the
`backstage-process-build-push` workflow (its `on.push.paths` includes
`platform-services/backstage/app/**`). No manual dispatch needed.

> The build runs on the self-hosted ARC/Kaniko runners and pushes
> `harbor.capstone.uamishub.com/backstage/backstage-process:<short-sha>`.
> `<short-sha>` is the **first 12 chars** of the merge commit SHA
> (`git rev-parse HEAD | cut -c1-12`) — NOT the 7-char GitHub display SHA. Using the
> 7-char form in the bump caused an `ImagePullBackOff`/`NotFound` once (see #110); always
> use the full 12-char tag.

---

## 1. Find the new image tag

Any ONE of these gives the exact tag to deploy:

**a) From the merge commit (fastest, deterministic):**
```bash
git -C platform-infra fetch origin main
git -C platform-infra rev-parse origin/main | cut -c1-12      # -> the <short-sha> tag
```

**b) From the CI run (confirms the build pushed):**
```bash
# Latest run of the portal build:
gh run list --repo UA-MIS/platform-infra \
  --workflow=backstage-process-build-push.yaml -L 5
# Open the newest successful run and read the "Build (and push) with Kaniko" step log —
# it prints:  ==> building + pushing harbor.capstone.uamishub.com/backstage/backstage-process:<short-sha>
gh run view --repo UA-MIS/platform-infra <run-id> --log | grep -m1 "building + pushing"
```

**c) From Harbor (confirms the artifact exists in the registry):**
```bash
# Newest-pushed artifact tag in the dedicated `backstage` project:
curl -s -u '<robot>:<secret>' \
  'https://harbor.capstone.uamishub.com/api/v2.0/projects/backstage/repositories/backstage-process/artifacts?page_size=5&sort=-push_time' \
  | jq -r '.[0].tags[].name'
```

Confirm the tag from (a) matches what CI pushed in (b)/(c) before bumping.

---

## 2. Bump the deployed image tag (the go-live flip)

Edit the single `tag:` field of the portal Application:

- **File:** `applicationsets/backstage-process-app.yaml`
- **Field:** `spec.source.helm.values` → `backstage.image.tag`

```yaml
          image:
            registry: harbor.capstone.uamishub.com
            repository: backstage/backstage-process
            tag: <NEW-12-char-short-sha>     # was: <OLD tag>
```

Commit on a branch and open a PR to `main` (main is branch-protected — PRs only):

```bash
git -C platform-infra switch -c deploy/wizard-go-live
# edit applicationsets/backstage-process-app.yaml tag: -> <NEW>
git -C platform-infra commit -am "deploy(backstage): bump image.tag <OLD> -> <NEW> (unified New Project wizard)"
git -C platform-infra push -u origin deploy/wizard-go-live
gh pr create --repo UA-MIS/platform-infra --base main --fill
```

The `platform-backstage-process` Application is **auto-synced** (`syncPolicy.automated`,
prune+selfHeal). On merge, ArgoCD rolls the Deployment to the new image (strategy `Recreate`
— one pod at a time so plugin DB migrations don't run concurrently). No `kubectl` step is
required; do NOT hand-edit the live Deployment (selfHeal would revert it — git is the source
of truth).

---

## 3. Verify the wizard is live

```bash
# a) ArgoCD reconciled to the new tag:
kubectl -n argocd get application platform-backstage-process \
  -o jsonpath='{.status.sync.status} {.status.health.status}{"\n"}'      # want: Synced Healthy

# b) The running pod is on the new image:
kubectl -n backstage get deploy backstage -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl -n backstage rollout status deploy/backstage --timeout=180s
```

Then in the portal UI (`https://<process-host>/create`):
1. The **"New Project"** template card is listed.
2. Launch it, complete the wizard, and confirm the **"Compose project from fragments"**
   step runs green — i.e. `capstone:compose-project` resolves (no "action is not
   registered" error). That is the definitive signal the new image is live.

**Break-glass / rollback:** revert the `tag:` to the previous value (recorded in the old
line's trailing comment / this PR's diff) and merge — auto-sync rolls back.

---

## What this PR also wired (DATABASE_URL consumption)

For a tenant that picks **auto-MySQL** in the wizard (`database: mysql`), the contract now
actually *consumes* the provisioned database:

- Each env overlay ships a platform-owned `database.externalsecret.yaml` (rendered/active
  ONLY when `values.database == 'mysql'`) that reads the four parts
  (`username`/`password`/`host`/`port`) from Vault `tenants/<team>/<env>/database`
  (the ADR-033 / #146 producer contract) and **assembles** the
  `mysql://…/<teamDb>_<env>` DSN via ESO `target.template` into the Secret `<app>-db`.
- The base Deployment envs `DATABASE_URL` from `<app>-db` for a mysql tenant, and from
  `<app>-secret` (the Secrets-tab, bring-your-own path) otherwise.
- `database: none` / bring-your-own / postgres stacks leave the file inert (not listed in
  `kustomization.yaml`), so DB-less apps are unaffected.

No deploy action beyond §2 is needed for this — it is contract/template content the wizard
renders at scaffold time; it takes effect for projects created after the new image is live.
