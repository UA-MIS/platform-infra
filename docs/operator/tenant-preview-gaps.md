# PR preview environments: not enabled, and what is missing

**Status: DEFERRED (owner decision, 2026-08-25). No tenant has ever run a preview.**

Every tenant claim carries `previewEnabled: false`. This page exists so the next
person does not have to re-derive why, and does not repeat the outage described at
the bottom.

The four gaps below are the same ones
[`tenants/_template/applicationset-preview.yaml`](../../tenants/_template/applicationset-preview.yaml)
has listed as B1–B4 since it was written, under its own header:
`⚠⚠⚠ DRAFT — DO NOT MERGE WITHOUT SECURITY REVIEW` and
*"UNTIL B1 LANDS, PREVIEWS ARE UNFENCED — do not enable."* They are restated here
with what each one actually costs, verified against the live cluster rather than
assumed.

## The four gaps

| # | Gap | Where the fix lives | Effort |
|---|---|---|---|
| **1** | **No fence.** A `<team>-pr-<n>` namespace is created by ArgoCD (`CreateNamespace=true`), not by the Composition — whose per-env bundle ranges over `dev\|staging\|prod` only. So it gets no ResourceQuota, no LimitRange and **no NetworkPolicy**: a preview has *more network reach than prod* while being the one environment running untrusted pull-request code. | **Platform.** A platform-project ApplicationSet on the same pullRequest generator. It cannot be the tenant's own app: the tenant AppProject excludes Quota/LimitRange/NetworkPolicy/RBAC, and that exclusion is correct. | **~1 day incl. review.** The YAML is a few hours; the sharp edge is deployment safety — see the incident below. |
| **2** | **Vault auth cannot resolve.** The k8s-auth role's `bound_service_account_namespaces` is an **exact list** (the three env namespaces + the literal `<team>-preview`), so `<team>-pr-7`'s `eso-tenant` SA gets a 403. Not a glob, and **provider-vault v0.1.0 exposes no `bound_service_account_namespace_selector` field** — confirmed against the live CRD. Binding `["*"]` would let *any* namespace assume the tenant role: strictly worse. | **Platform.** Either (a) bypass it — have the platform-project app supply preview secrets from the cluster-scoped `vault-backend` store, or (b) upgrade provider-vault to a version exposing the namespace selector. | **(a) ~2 hours**, and it composes with gap 1. **(b) days** — a provider upgrade touches every tenant. |
| **3** | **Image pulls fail.** The Harbor project is `public: false` and `harbor-pull` is explicitly *not* rendered for preview (the Composition says so in a comment), so every preview pod `ImagePullBackOff`s. | **Platform.** Same app as gaps 1–2 materialises it from the existing team-scoped pull robot. | **~30 min** once gap 1 exists. |
| **4** | **Static `pr-1` collision.** A real PR #1 would fight the static stand-in namespace. | **None for claim-created tenants.** Only affects the old blueprint path (`tenants/_template/namespaces/preview.yaml`); the Composition renders no static pr-1. Verified. | **Zero.** Not applicable. |

There is also an **app-repo** side, but it is *not* a blocker: the tenant repo needs
a `pull_request` build producing a `pull-<sha>` image and a job that pins the
preview overlay to it and adds the `preview` label. `UA-MIS/ida-llm` already has
all of this on `main` and it is inert while the claim flag is off.

## Cheap partials, if a reduced preview is ever acceptable

Gaps 1 and 3 are **not** optional — without 1 a preview is unfenced, and without 3
nothing starts at all. The genuinely optional pieces are:

- **No per-preview database.** Pointing a preview at the shared tenant Postgres is
  *cheaper but wrong*: a preview runs untrusted PR code, so one bad migration drops
  the team's dev tables. If previews are ever revived, give them a throwaway
  in-namespace Postgres and grant the preview namespace **no egress to the db-tier
  at all** — the absence of that rule is what makes the guarantee real.
- **No per-preview MinIO.** Genuinely droppable. A reviewer looking at a UI change
  does not need durable artifact storage; the app can run with object storage
  disabled.
- **No autoscaling.** The HPA's `minReplicas: 2` would run two runners in *every*
  open PR's namespace. Remove it in preview rather than scaling it.

## ⚠ The incident, so it is not repeated

Enabling previews was attempted on 2026-08-25 and **reverted**.

The platform-project guardrails directory was added under `platform-services/`,
with an exclude in `applicationsets/platform-services-appset.yaml` so the
directory generator would skip it. **The exclude did not take effect in time.** The
generator saw the new directory on `HEAD` and created
`platform-svc-ida-llm-preview-guardrails`, which applied a `default-deny-all`
NetworkPolicy, a ResourceQuota and a LimitRange **into `kube-system`** — the
appset's default destination namespace. That killed CoreDNS and took **DNS down
cluster-wide**; all 103 ArgoCD Applications went `Unknown`.

It then **came back after the first cleanup**, because with DNS down ArgoCD could
no longer render the commit containing the fix — the ApplicationSet kept
regenerating the Application from git. The deadlock had to be broken by patching
the **live** ApplicationSet with `kubectl` to add the exclude, independent of
ArgoCD, before deleting the objects and the Application again.

**Lessons for whoever revives this:**

1. **Never put a per-PR template directory under a path a directory generator
   globs.** The exclude is a race, not a guarantee. Put it somewhere the generator
   cannot see it at all.
2. **A default-deny NetworkPolicy applied to the wrong namespace is not a sync
   error, it is an outage** — and if that namespace is `kube-system`, it is an
   outage that prevents its own repair.
3. **Land the exclude in a separate, earlier commit than the directory it
   excludes,** and confirm it is live on the ApplicationSet before pushing the
   directory.
