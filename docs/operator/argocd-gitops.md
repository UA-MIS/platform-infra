# ArgoCD & GitOps

ArgoCD is the only writer of desired state for the platform. You change the
platform by **merging a PR to `UA-MIS/platform-infra`**, not by running `kubectl`
against the cluster. ArgoCD continuously reconciles the live cluster to match git.

> **Golden rule.** Direct `kubectl apply` to the shared cluster creates drift that
> ArgoCD will either fight (selfHeal) or that `make bootstrap-reapply` has to
> repair. The only sanctioned imperative writes are the **install-owned** objects
> below and the one-time operator ceremonies documented in the other operator
> pages (Vault unseal, Crossplane Phase-0, robot minting).

---

## The app-of-apps / ApplicationSet model

The whole platform fans out from one root Application.

```
bootstrap/root-app.yaml            (the "root" Application — applied ONCE by make bootstrap)
  └─ points at applicationsets/  (directory recurse)
       ├─ platform-services-appset.yaml   → one Application per platform-services/*/ dir
       ├─ tenants-appset.yaml              → one "tenant-<team>" Application per tenants/team-*/ dir
       └─ *-app.yaml (one file each)       → the Helm-source platform apps
            (harbor, vault, external-secrets, kube-prometheus-stack, loki, alloy,
             arc-*, rook-ceph-*, traefik, metrics-server, crossplane-{core,runtime,apis,claims}, …)
```

- **`bootstrap/root-app.yaml`** (`Application/root`, `argocd` ns, `platform`
  project) points at `applicationsets/` with `directory.recurse: true`. It has
  `automated: {prune, selfHeal}` — once applied it pulls in everything else.
- **`applicationsets/platform-services-appset.yaml`** is a git **directory
  generator** over `platform-services/*` → emits `platform-svc-<dir>` Applications.
  Adding a directory under `platform-services/` adds a platform service.
  - Excludes (documented in the file): `platform-services/harbor-onboarding`
    (a per-team Job template with a literal `__TEAM__` placeholder — applied
    imperatively, never reconciled) and `platform-services/traefik` (now a
    standalone Helm-source app).
- **`applicationsets/tenants-appset.yaml`** is a git directory generator over
  `tenants/*` → emits `tenant-<team>` bootstrap Applications (each renders the
  team's AppProject, namespaces, quota/limitrange/netpol/RBAC, and env/preview
  ApplicationSets). `tenants/_template` is excluded (it is the blueprint).
- The individual `applicationsets/*-app.yaml` files are the Helm-source platform
  Applications (each pins its chart version in `targetRevision`).

**Two AppProjects enforce the tenancy fence:**

- **`platform`** (`bootstrap/platform-appproject.yaml`) — the privileged project.
  It alone may create cluster-scoped resources (CRDs, ClusterRoles, controllers).
  Only `platform-infra` and the pinned external Helm chart repos are in its
  `sourceRepos`. The root app, every `platform-svc-*`, and every `tenant-*`
  bootstrap app live here.
- **per-team projects** (rendered from `tenants/_template/appproject.yaml`) —
  whitelist only that team's namespaces and the team's own app repo, and forbid
  cluster-scoped resources. Team **workloads** run here; the `tenant-*` bootstrap
  app that *creates* the project runs in `platform`.

---

## `make bootstrap` and `make bootstrap-reapply`

Two objects are **install-owned and deliberately NOT GitOps-reconciled**:

1. `bootstrap/argocd-install/` — the ArgoCD install + the `argocd-server` patches.
2. `bootstrap/platform-appproject.yaml` — the `platform` AppProject `sourceRepos`
   allowlist.

When you merge a PR that touches `bootstrap/`, **git is updated but the live
cluster stays stale** until you re-apply. This is intentional (ArgoCD cannot
safely reconcile its own install/project), and it is the #1 "looks merged but
nothing happened" trap on the platform.

### Fresh-cluster install (one command, idempotent)

```bash
cd platform-infra
make bootstrap TARGET=real-talos KUBE_CONTEXT=admin@capstone
```

Installs ArgoCD (pinned `v3.4.3`, single-replica), applies the `platform`
AppProject, applies `bootstrap/root-app.yaml`. ArgoCD then pulls everything else.

### After any `bootstrap/` change (the one you will run most)

```bash
make bootstrap-reapply KUBE_CONTEXT=admin@capstone
```

`bootstrap-reapply` does five hardened steps (read the target in the `Makefile`):

0. Strips the stale `last-applied-configuration` annotation on `argocd-cm`
   (removes the CSA→SSA prune trigger — see the wipe gotcha below).
1. Re-applies `bootstrap/argocd-install` (`--server-side --force-conflicts`).
2. Re-applies `bootstrap/platform-appproject.yaml`.
3. **Force-syncs** `platform-svc-argocd-config` to re-assert the `argocd-cm`
   theme (`ui.cssurl`) + SSO (`oidc.config`) keys.
4. Rolls `argocd-server` so it re-reads the restored config.
5. **Asserts** both keys survived — fails loudly if SSO/theme would be down.

It then prints verification commands:

```bash
kubectl -n argocd get appproject platform -o jsonpath='{.spec.sourceRepos}'
curl -sk https://argocd.capstone.uamishub.com/custom/ua-mis.css | head
```

> Symptom you forgot to run it: a new platform app sits
> `InvalidSpecError "repo not permitted"` (its chart repo isn't in the live
> AppProject `sourceRepos` yet). Every external chart repo is install-owned —
> Harbor, ARC, Rook, metrics-server, Traefik, Backstage, ESO, Vault, Crossplane,
> kube-prometheus-stack, Grafana/Loki. Re-apply, then **verify it took**.

### ⚠ The stale-local-checkout gotcha → always run from a fresh `main`

`bootstrap-reapply` applies **the files on your disk**, not what's in git. If you
run it from a stale worktree (an old branch, an un-pulled checkout, or a render
worktree), you re-apply **old** bootstrap objects over the live cluster — silently
reverting a merged `sourceRepos` add or argocd-server patch. **Always check out a
clean `origin/main` and `git pull` before running it.** Verify ground truth with
`gh`/`git show origin/main:…`, never a stale local worktree.

### ⚠ The `argocd-cm` SSA wipe gotcha

`argocd-cm` is co-managed: the install ships only `resource.customizations.*`; the
GitOps app `platform-svc-argocd-config` owns `ui.*` (theme) + `oidc.*` (SSO). A
**bare** `kubectl apply -k bootstrap/argocd-install --server-side
--force-conflicts` **wipes the entire `argocd-cm.data`** (SSO + theme break),
because a stale `last-applied-configuration` annotation triggers a CSA→SSA
migration that prunes the GitOps keys. **Never** run that bare apply against
argocd-cm — use `make bootstrap-reapply`, which is hardened against it (step 0 +
step 3 + step 5) and is live-proven safe.

---

## Sync & health

```bash
export KUBECONFIG=clusters/real-talos/clusterconfig/talos-kubeconfig   # fish: set -x KUBECONFIG ...
kubectl -n argocd get applications                       # the fleet at a glance
argocd app sync <app>                                    # manual sync (CLI)
argocd app get <app>                                     # detailed health/sync state
```

- Most apps `automated: {prune, selfHeal}` and converge on merge.
- **Manual-sync by design** (do not expect auto-sync): the SEC-011 network
  policies — `platform-netpol-controlplane` and `platform-netpol-runners`. They
  show `OutOfSync` until you `argocd app sync` them. The
  `ArgoCDAppStuckOutOfSync` alert explicitly **excludes** the netpol app.

> **"Synced/Healthy" is not proof it works** (ADV-002). An app can be green with
> every pod in `ImagePullBackOff`, and a hook-only app shows green while the hook
> never ran. Always assert the actual pods reach `Running` / the behavior
> happened. `make verify-image-pull` checks the registry-mirror class of failure.

---

## The theme / SSO re-assert

The platform's ArgoCD UI theme and OIDC SSO live in `argocd-cm`, owned by the
GitOps app `platform-svc-argocd-config` (`platform-services/argocd-config/`:
`argocd-cm.yaml`, `argocd-rbac-cm.yaml`, `ua-mis.css`, `ingress.yaml`,
`sealedsecret.yaml`). Two ways they can disappear:

- A bare install apply wiped them (gotcha above) → run `make bootstrap-reapply`.
- They drifted → force-sync the config app directly:

```bash
kubectl -n argocd patch app platform-svc-argocd-config --type merge \
  -p '{"operation":{"sync":{"syncStrategy":{"apply":{"force":true}}}}}'
```

Verify both keys are present (this is what `bootstrap-reapply` step 5 checks):

```bash
kubectl -n argocd get cm argocd-cm -o jsonpath='{.data.ui\.cssurl}{"\n"}{.data.oidc\.config}'
```

ArgoCD RBAC (`argocd-rbac-cm.yaml`) maps the Dex `UA-MIS:<team>` group to a scoped
`role:<team>` (matches `<project>/<app>`). The **one-slug-everywhere** convention
(D-026) means any divergence between the team slug, AppProject, namespace prefix,
and OIDC group makes the role silently inert — `make validate` guards it.

---

## The repoURL seam

Every `repoURL`/`sourceRepos` entry hardcodes `https://github.com/UA-MIS/<repo>`
(the real home). For a local mirror you can repoint them all in one shot:

```bash
make show-repo-base                    # what's wired in now
make set-repo-base GIT_BASE_URL=https://github.com/UA-MIS    # rewrite (idempotent, reversible)
```

See `bootstrap/REPO-SEAM.md`. In normal operation you never touch this.

---

## Git webhook — instant sync (skip the ~3-min poll)

By default ArgoCD polls `UA-MIS/platform-infra` every ~3 min
(`timeout.reconciliation`), so a merged PR can sit un-synced for minutes and you
end up hammering **Refresh** in the UI. A **Git webhook** makes GitHub POST to
ArgoCD the instant you push, and ArgoCD refreshes the affected Applications
immediately. Polling stays on as a backstop — the webhook only *accelerates* it.

**How it's wired:** ArgoCD's webhook receiver lives at `POST /api/webhook` on
`argocd-server` (unauthenticated by design — it verifies the GitHub HMAC instead
of a login session, so it is **independent of the Dex/OIDC UI SSO**). The shared
HMAC secret is the key `webhook.github.secret` inside the install-managed
`argocd-secret`. We inject it with a **patch** SealedSecret
(`platform-services/argocd-config/sealedsecret-webhook.yaml`) so only that one key
is added and ArgoCD's own `tls.crt` / `server.secretkey` / `admin.password` in
`argocd-secret` are left untouched.

> **Scope — one org webhook, every repo.** We use a **single org-level webhook on
> `UA-MIS`** pointed at this endpoint, so **every** repo (platform-infra + all
> tenant repos + any future repo) fires an instant sync on push with **zero
> per-repo setup**. Tenant repos otherwise sit on the ~3-min poll. This supersedes
> the old per-repo `platform-infra` webhook (see cleanup in Step 3).
>
> **Signing is all-or-nothing at this endpoint.** ArgoCD requires a valid HMAC on
> **every** delivery to `/api/webhook` *only once* `webhook.github.secret` is set.
> Until then it accepts unsigned deliveries; after then, any hook whose secret
> doesn't match gets `401`. So the secret and the org hook must carry the **same**
> value, and you must seal the secret **before** creating (or re-pointing) the
> hook — see the ordering warning in Step 2.

> **⚠ FIX (this PR) — the CR name is load-bearing.** The original
> `sealedsecret-webhook.yaml` named the SealedSecret CR `argocd-webhook-github` and
> relied on `spec.template.metadata.name: argocd-secret` to retarget the patch.
> That does **not** work: SealedSecrets binds the output Secret's name to the **CR
> `metadata.name`**, so the controller happily unsealed into a *standalone* Secret
> called `argocd-webhook-github` and **never touched `argocd-secret`**. ArgoCD only
> reads `webhook.github.secret` from `argocd-secret`, so the platform-infra webhook
> was silently **unsigned/inert** (verified live: `argocd-secret` had only
> `admin.password` / `admin.passwordMtime` / `server.secretkey`). The CR is now
> named **`argocd-secret`** so the `patch: "true"` merge lands on the real secret.
> The stale `argocd-webhook-github` Secret is pruned automatically (the config app
> is `automated: {prune,selfHeal}`; the old SealedSecret's ownerReference
> cascade-deletes it).

**Reachability (verified read-only, 2026-07-02):** the endpoint is publicly
POST-able through the Cloudflare Tunnel and is **not** gated by edge auth. The
tunnel is a single wildcard route `*.capstone.uamishub.com → Traefik:80`, the
`argocd-server` Ingress serves all paths (`/` Prefix, no path filter), and a live
probe returned `GET /api/webhook → 400` and `POST` ping `→ 200` **from
argocd-server itself** (an ArgoCD response, not a Cloudflare Access login page).
No ingress exception is required.
> The only thing not visible from git is a possible **Cloudflare Access (Zero
> Trust)** application on the dashboard in front of the argocd host. The live
> probe above returning an ArgoCD response (not an Access challenge) confirms none
> is active today. If one is ever added, add a **bypass/service-token policy for
> the path `/api/webhook`** or GitHub deliveries will 302 to the Access login.

### Step 1 — reseal the shared secret (operator, fish shell)

The committed `sealedsecret-webhook.yaml` ships a **placeholder** ciphertext; it
must be resealed to a real random value before merge. This adds one key to
`argocd-secret` and is non-destructive if it ever fails to decrypt (no key is
written, ArgoCD just keeps polling).

```fish
# 1. Generate the shared secret and KEEP it — you paste the same value into GitHub in Step 2.
set WEBHOOK_SECRET (openssl rand -hex 24)
echo "GitHub webhook secret (save this): $WEBHOOK_SECRET"

# 2. Seal it. Strict scope binds the ciphertext to name+namespace, so the input
#    secret name MUST be `argocd-secret` (the SealedSecret CR name = the patched
#    target). Sealing under any other name (e.g. the old `argocd-webhook-github`)
#    will fail to decrypt after the rename fix.
kubectl create secret generic argocd-secret \
    --namespace argocd \
    --from-literal=webhook.github.secret=$WEBHOOK_SECRET \
    --dry-run=client -o yaml \
  | kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
      --format yaml

set -e WEBHOOK_SECRET      # clear the plaintext from the session AFTER Step 2
```

Copy the emitted `encryptedData."webhook.github.secret"` value and paste it over
the `PLACEHOLDER_RESEAL_PER_RUNBOOK...` string in
`platform-services/argocd-config/sealedsecret-webhook.yaml` (replace **only** that
one value; leave the `sealedsecrets.bitnami.com/patch: "true"` annotation and the
`argocd-secret` template target as-is). Commit on the branch + PR — never to main.

> Do **not** run `kubeseal --merge-into` on the committed file: it reparses and
> reformats the YAML, stripping the header comments that explain why `patch` is
> load-bearing. Replace the single value by hand instead.

### Step 2 — create the ORG-level webhook (needs org admin)

> **⚠ ORDER MATTERS — do this AFTER the reseal PR has merged AND synced (verify in
> Step 3 that `argocd-secret` now has `webhook.github.secret`).** The moment that
> key exists, ArgoCD rejects any delivery to `/api/webhook` whose HMAC doesn't
> match it (`401`). So:
> 1. Seal + merge + sync the secret **first** (Steps 1 & 3-verify).
> 2. **Then** create the org hook with `config.secret` = the **same**
>    `$WEBHOOK_SECRET`.
> If you create the hook first (or with a different value), every push 401s and the
> instant sync silently stops working. **The same trap breaks the OLD per-repo
> `platform-infra` hook**: it was created unsigned, so once the secret lands it
> will start 401-ing until you delete it (Step 3 cleanup) or re-point it with the
> secret. Retire it — the org hook already covers platform-infra.

One org webhook covers every current and future UA-MIS repo. Create it with the
`gh` CLI (as an org owner), or via the UI (**org → Settings → Webhooks → Add
webhook**) with the same field values:

```bash
gh api -X POST /orgs/UA-MIS/hooks \
  -f name=web \
  -F active=true \
  -f 'events[]=push' \
  -f config.url=https://argocd.capstone.uamishub.com/api/webhook \
  -f config.content_type=json \
  -f config.insecure_ssl=0 \
  -f config.secret="$WEBHOOK_SECRET"
```

| Field | Value |
|---|---|
| Payload URL | `https://argocd.capstone.uamishub.com/api/webhook` |
| Content type | `application/json` (`config.content_type=json`) |
| Secret | the `$WEBHOOK_SECRET` value from Step 1 |
| SSL verification | **Enabled** (`insecure_ssl=0`; Cloudflare Universal SSL is publicly trusted) |
| Events | **Just `push`** |
| Active | ✔ |

> **Can the `ua-mis-backstage` GitHub App create it instead?** Only with the
> **`organization_hooks: write`** permission, which is **not currently granted** to
> the App (it holds contents/metadata/administration/variables for tenant repos,
> not org-hook admin). Granting it is possible but broad; the one-time manual
> `gh api`/UI step above is simpler and safer. Leave org-hook creation as an
> operator ceremony, not an App capability.
>
> **Check for an existing org hook first** so you don't create a duplicate:
> `gh api /orgs/UA-MIS/hooks --jq '.[] | {id, url: .config.url, events}'`. If one
> already points at `/api/webhook`, **update** it instead:
> `gh api -X PATCH /orgs/UA-MIS/hooks/<id> -f config.secret="$WEBHOOK_SECRET" -f config.url=... -f config.content_type=json`.

### Step 3 — verify + clean up (after the reseal PR merges and syncs)

```fish
# a) The key landed in argocd-secret WITHOUT wiping the install-owned keys:
kubectl -n argocd get secret argocd-secret \
  -o jsonpath='{.data.webhook\.github\.secret}{"\n"}{.data.server\.secretkey}{"\n"}{.data.tls\.crt}{"\n"}' \
  | string collect   # all three must be non-empty

# b) The stale standalone secret from the old (broken) CR name is gone
#    (auto-pruned via ownerReference when the renamed SealedSecret replaced it):
kubectl -n argocd get secret argocd-webhook-github   # expect: NotFound
```

If `argocd-webhook-github` still lingers (e.g. prune was disabled at the time),
delete it once by hand — it is inert and owned by nothing after the rename:
`kubectl -n argocd delete secret argocd-webhook-github`.

Then push a trivial commit to **any** UA-MIS repo and confirm the org webhook's
**Recent Deliveries** (org → Settings → Webhooks) shows a `200`, and the affected
Application refreshes in ArgoCD within seconds (no manual Refresh). A `401`/`403`
delivery means the cluster's `webhook.github.secret` ≠ the org hook's
`config.secret` — reseal and re-enter the **same** value.

**Retire the redundant per-repo hook.** Once the org hook is live, the old
`UA-MIS/platform-infra` repo webhook is redundant (and, being unsigned, will 401).
Remove it: `gh api /repos/UA-MIS/platform-infra/hooks --jq '.[].id'` then
`gh api -X DELETE /repos/UA-MIS/platform-infra/hooks/<id>`. Harmless to leave *if*
you first re-point it with the same secret, but deleting keeps a single signed
source of truth.

### Self-service durability (design note)

The org-level hook is the **recommended, future-proof** design: one hook, every
repo, no per-tenant setup, nothing for the scaffolder to maintain, no drift. The
alternative — having the tenant scaffolder add a **per-repo** webhook at onboarding
(belt-and-suspenders) — is **not implemented and not recommended**: it needs the
GitHub App's `organization_hooks`/repo-hook admin scope, duplicates coverage the
org hook already gives, and creates per-repo drift to reconcile. Keep the org hook
as the single mechanism; only revisit per-repo hooks if org-hook access is ever
lost.
