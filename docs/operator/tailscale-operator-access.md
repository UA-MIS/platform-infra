# Kubernetes access via the Tailscale operator (identity, not kubeconfig)

**Why this exists.** The owner graduates in ~3 months and hands the platform to two
students, who will hand it on again after them. Kubernetes client certificates have
**no CRL** — the API server can only be told to trust a CA, never told to distrust one
cert while still trusting the rest. So every kubeconfig ever copied to a laptop is
**permanent** cluster-admin access; the only way to revoke it is `talosctl rotate-ca`,
which invalidates every other cert too. That is not a workable handoff model for a
platform that changes hands every year or two.

The [Tailscale Kubernetes operator's API-server proxy](https://tailscale.com/docs/kubernetes-operator/api-server-access/setup-api-over-tailscale),
run in **auth mode**, replaces "here is a kubeconfig" with "you're on the tailnet and
in the right group." Access becomes:

```
add to the `labmx` GitHub team + tailnet group  →  cluster-admin from their own laptop
remove from either                              →  access gone immediately
```

No file to hand over, no file to claw back.

> **Tailnet name check.** This repo's other docs (`ansible/inventory/group_vars/mac_workers.yml`,
> `docs/operator/debian-worker-onboarding.md`, `docs/operator/talos-node-onboarding.md`)
> all record the tailnet's MagicDNS domain as `taile5d412.ts.net` (display name
> `ualaims`). If your tailnet is actually `tail85625e.ts.net`, one of these is stale —
> confirm the live value (`tailscale status` on any node, or the admin console's DNS
> tab) before running the verification commands below; the proxy hostname in those
> commands assumes whichever is correct.

**Scope: Kubernetes only.** This does not touch Talos's own API. `talosctl` still
needs `talosconfig` and its own client cert — Talos has a separate control plane with
separate certs from Kubernetes'. Node-level operations (talhelper, `talosctl
apply-config`, `talosctl rotate-ca`) are unaffected by anything in this document. See
[talos-node-onboarding.md](talos-node-onboarding.md).

---

## How it works

```
maintainer's laptop (on the tailnet, in group:labmx)
   │  kubectl, using a kubeconfig with NO cert/token in it
   ▼
ProxyGroup "capstone-apiserver" (in-cluster, Tailscale-operator-managed)
   │  looks up the caller's tailnet identity + ACL grants
   │  sets Impersonate-User / Impersonate-Group headers
   ▼
kube-apiserver
   │  ordinary Kubernetes RBAC evaluates the impersonated identity
   ▼
ClusterRoleBinding "labmx-cluster-admins" → ClusterRole "cluster-admin"
```

Manifests: `platform-services/tailscale-operator/` (ExternalSecret, ProxyGroup CR,
ClusterRoleBinding) + `applicationsets/tailscale-operator-app.yaml` (the operator
itself, Helm-source) + `applicationsets/tailscale-operator-resources-app.yaml` (the
above, git-source, synced one wave after the operator). Both are ArgoCD-managed like
every other platform service — **nothing here is `helm install`ed by hand.**

The Kubernetes-side ClusterRoleBinding binds a plain, git-visible group name
(`labmx-cluster-admins`) to the built-in `cluster-admin` ClusterRole, rather than
impersonating literally into the magic `system:masters` group Tailscale's own docs
example uses. Functionally identical (full cluster-admin); the difference is that
"who is cluster-admin here" is an ordinary, `git rm`-able RBAC object instead of a
string that has to match an API-server built-in with nothing in this repo to point at.
See the header comment in `platform-services/tailscale-operator/clusterrolebindings.yaml`
for the full reasoning.

---

## Owner steps: create the OAuth client (one-time, cannot be done by an agent)

The operator authenticates to Tailscale with an **OAuth client**, not a person's
login. This cannot be created by an agent — it lives in the Tailscale admin console
and only an owner/admin of the tailnet can mint it. Nothing in this PR can complete
the install until this step is done.

1. Tailscale admin console → **Settings → OAuth clients → Generate OAuth client**.
2. Scopes — select exactly:
   - **Devices → Core**: Read + Write
   - **Devices → Auth Keys**: Read + Write (the operator provisions devices for
     Connectors/proxies)
   - Leave everything else unchecked.
3. **Tags**: select `tag:k8s-operator` (created by the ACL change below — do the ACL
   paste first if the console won't let you pick a tag that doesn't exist yet).
4. Generate it. Copy the **Client ID** and **Client Secret** — the secret is shown
   once.
5. Seed Vault (do **not** paste the secret into a PR, an issue, or this repo):
   ```
   vault kv put secret/platform/tailscale-operator \
     client_id=<the Client ID> \
     client_secret=<the Client Secret>
   ```
   This is the exact pattern already used for slidedeck/LabMx's app secrets
   (`platform-services/slidedeck/externalsecret-env.yaml`,
   `platform-services/labmx/externalsecret-env.yaml`) — value in Vault, name in git,
   ESO materializes the k8s Secret. No Vault policy change is needed: the ESO
   controller's `external-secrets-ro` policy already grants read on
   `secret/data/platform/*`
   (`platform-services/external-secrets/vault-policies/eso-role.sh`).
6. Within a few minutes (`refreshInterval: 1h`, but ESO reconciles sooner on a fresh
   path) the `operator-oauth` Secret appears in the `tailscale` namespace and the
   operator pod goes `Running`.

## Owner steps: paste the ACL grant

Paste this into the tailnet's ACL policy file (Tailscale admin console → **Access
controls**). It does three things: owns the operator's tag, lets the operator tag
itself, and maps the `labmx` tailnet group to a Kubernetes RBAC group name via the
Kubernetes capability grant.

```json
{
  "tagOwners": {
    "tag:k8s-operator": ["autogroup:admin"],
    "tag:k8s":          ["tag:k8s-operator"]
  },

  "groups": {
    "group:labmx": ["<owner's tailnet login>", "<add each labmx maintainer's tailnet login here>"]
  },

  "grants": [
    {
      "src": ["group:labmx"],
      "dst": ["tag:k8s-operator"],
      "app": {
        "tailscale.com/cap/kubernetes": [{
          "impersonate": {
            "groups": ["labmx-cluster-admins"]
          }
        }]
      }
    }
  ]
}
```

Merge these stanzas into the existing policy file rather than replacing it —
`tagOwners`/`groups`/`grants` are top-level keys that likely already exist with other
entries.

**Keeping `group:labmx` and the `labmx` GitHub team in sync is a manual step** unless
the tailnet is already wired to sync groups from an external identity provider. Until
then: whoever edits GitHub team membership must also edit `group:labmx` in this ACL.
That is the one seam in "add to the team → get access" — flagged here so it doesn't
get missed at handoff.

`labmx-cluster-admins` is an arbitrary group **name** chosen to match
`platform-services/tailscale-operator/clusterrolebindings.yaml` — it does not need to
exist anywhere in Tailscale itself; the operator manufactures it purely from this
grant.

---

## Verification

Once the OAuth client exists and the ACL is pasted, run (from a laptop on the
tailnet, in `group:labmx`):

```bash
# 1. Find the ProxyGroup's hostname.
kubectl get proxygroup capstone-apiserver -n tailscale
# (or: tailscale status, look for the capstone-apiserver-0/1 nodes)

# 2. Generate a kubeconfig via the Tailscale CLI, not by copying one.
tailscale configure kubeconfig capstone-apiserver

# 3. Prove it carries no cert/token — only a server URL and an exec plugin
#    that authenticates via the LOCAL tailscaled socket at request time.
kubectl config view --minify --raw
```

Expected shape of step 3's output — no `client-certificate-data`, no
`client-key-data`, no static token, just an `exec` credential plugin:

```yaml
apiVersion: v1
clusters:
- cluster:
    server: https://capstone-apiserver.<tailnet>.ts.net:443
  name: capstone-apiserver
contexts:
- context:
    cluster: capstone-apiserver
    user: capstone-apiserver
  name: capstone-apiserver
current-context: capstone-apiserver
users:
- name: capstone-apiserver
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: tailscale
      args: ["configure", "kubeconfig", "--client=true"]
```

```bash
# 4. THE point of this whole change: prove the identity is the PERSON, not `admin`.
kubectl auth whoami
# Expect the caller's tailnet login (e.g. alice@github), NOT `system:admin` /
# `admin` / any service-account-shaped name.

# 5. Prove the RBAC actually landed.
kubectl get nodes
kubectl auth can-i '*' '*' --all-namespaces
# Expect "yes" — via ClusterRoleBinding labmx-cluster-admins → cluster-admin, not
# via system:masters.
```

**Confirm nothing regressed:** the existing cert-based kubeconfig
(`clusters/real-talos/clusterconfig/talos-kubeconfig`) is untouched by any of this —
it is a second, independent credential, not replaced. Verify it still works:

```bash
KUBECONFIG=clusters/real-talos/clusterconfig/talos-kubeconfig kubectl --context admin@capstone get nodes
```

**Confirm the operator didn't touch anything it shouldn't have:**

```bash
kubectl -n tailscale get pods            # operator + capstone-apiserver-* proxy pods, all Running
kubectl get pods -A --field-selector=status.phase!=Running   # no unrelated pod got restarted
```

None of the above steps could be executed from this sandboxed environment — agents
in this project are classifier-gated out of live cluster writes/reads, and the OAuth
client + ACL grant are owner-only steps in the first place. This section is the exact
script to run once the PR is merged and the two owner-only steps above are done.

---

## The break-glass gap

**This proxy runs *inside* the cluster it grants access to.** If the cluster is down,
if Talos's control plane is unreachable, or if the operator's own pods are unhealthy,
this entire access path is down with it — there is no bootstrapping your way into a
dead cluster through a proxy that lives in that cluster.

The fallback is the existing admin client certificate, held in
`capstone-ops-secrets` (kubeconfig at `clusters/real-talos/clusterconfig/talos-kubeconfig`).
It is unaffected by anything in this change and remains the break-glass path for:

- diagnosing why the cluster/operator is unhealthy in the first place;
- any operation needed before the operator can even start (e.g. the cluster just
  came up from cold).

**This is also why the cert's un-revocability is tolerated rather than eliminated.**
The plan is not "stop using certs" — it's "stop using certs for *day-to-day* access,
so the day-to-day path is instantly revocable, and reserve the cert for the one
scenario (cluster is broken) where instant revocability doesn't matter because nobody
should have day-to-day access to a broken cluster anyway."

At handoff, rotate it: `talosctl rotate-ca` invalidates every existing client cert
(including any the outgoing maintainer kept) and issues fresh ones for the incoming
maintainers. Do this **after** confirming the Tailscale-operator path works for the
incoming maintainers, so there's a tested way back in if the rotation itself goes
sideways. See [talos-node-onboarding.md](talos-node-onboarding.md) for cert/CA
mechanics on this cluster.

---

## Adding or removing a maintainer

**Add:**
1. Add them to the `labmx` GitHub team (existing process, D-027).
2. Add their tailnet login to `group:labmx` in the tailnet ACL (see above — this is
   the manual seam; there is no automatic GitHub↔tailnet group sync configured today).
3. They run `tailscale configure kubeconfig capstone-apiserver` on their own laptop.
   Cluster-admin, immediately, no file handed to them.

**Remove:** do **both** of the following — either alone leaves a stale credential:
1. Remove them from the `labmx` GitHub team.
2. Remove their tailnet login from `group:labmx` in the tailnet ACL.

Removing from the tailnet ACL group takes effect on their **next** request through the
proxy (the operator re-evaluates grants per-request, not per-session) — there is no
token to expire and no session to wait out.

---

## What is still manual (not GitOps, not this PR)

- Creating the Tailscale OAuth client (owner-only, admin-console action).
- Seeding `secret/platform/tailscale-operator` in Vault with that client's
  id/secret.
- Editing the tailnet ACL policy (`groups`, `tagOwners`, `grants`) — Tailscale's ACL
  is not sourced from this repo today; there is no GitOps path for it.
- Keeping `group:labmx` in sync with the `labmx` GitHub team membership by hand.
- `talosctl rotate-ca` at actual handoff time (separate action, Talos's own CA, not
  triggered by anything here).
