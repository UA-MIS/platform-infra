# cf-vm-access — automatic Cloudflare SSH access for VM tenants (ADR-038)

A stdlib-only CronJob in the `cloudflared` namespace that reconciles, for every VM
tenant, the two Cloudflare objects that make `<team>-ssh.uamishub.com` a working SSH
endpoint: a **Tunnel public-hostname route** and a **Cloudflare Access application**.

**Desired state is discovered, never configured.** It is the set of in-cluster
Services carrying `platform.capstone/access=ssh`. Add one and the hostname appears;
delete one and it is removed on the next pass. No tenant name exists anywhere in
this directory.

**Ships `DRY_RUN=1`.** It logs its plan and writes nothing. Merging it changes no
Cloudflare state.

---

## Hostname shape

`<team>-ssh.uamishub.com` — a **single label under the apex**.

This is a TLS constraint. The live certificate is:

```
$ openssl s_client -connect paper-papas-ssh.uamishub.com:443 \
    -servername paper-papas-ssh.uamishub.com | openssl x509 -noout -ext subjectAltName
    DNS:uamishub.com, DNS:*.uamishub.com
```

A one-level wildcard. So `<team>-ssh.uamishub.com` is covered; a dotted
`ssh.<team>.uamishub.com` is two levels, is **not** covered, and fails the
HTTPS/Access handshake outright. This is the same reasoning that made PR #406 choose
the hyphenated `ssh-<app>` form under `*.capstone`; only the zone changed.

The host already reaches Cloudflare today:

```
$ curl -o /dev/null -w '%{http_code} ssl_verify=%{ssl_verify_result}\n' \
    https://paper-papas-ssh.uamishub.com/
404 ssl_verify=0
```

404 from the tunnel's catch-all, with TLS verifying. **DNS and TLS are done.** Only
the route and the Access app are missing.

---

## Safety — why this is more careful than it looks

The Cloudflare tunnel-config API is a **whole-list PUT**. That one list carries every
public platform hostname: the portal, Harbor, ArgoCD, the boards, the slides. A bad
write does not degrade one tenant — it takes all of them down at once. The live
config has at least 9 ingress rules (observed as `ingressRule=8` in cloudflared's
own logs).

Five layers, in order:

1. **`DRY_RUN=1`** (default) — logs the plan, writes nothing.
2. **GET-merge-PUT** — only rules matching our own discriminator are inserted or
   removed. The discriminator requires **both** a single-label `*-ssh.<domain>`
   hostname **and** an `ssh://` origin, so an HTTP rule can never be captured.
3. **Catch-all guard** — if the fetched config does not end in a hostname-less
   catch-all rule, the PUT is refused outright.
4. **Preservation assert** — the non-managed rules are re-derived from the list
   about to be written and must be byte-identical, in order, to the ones read. This
   makes "we only touch our own rules" a checked invariant, not a comment.
5. **Empty-desired guard** — if discovery returns zero tenants while Cloudflare still
   holds managed routes, the mass-delete is refused. A broken label selector is far
   likelier than every VM tenant being torn down at once. `ALLOW_EMPTY_DESIRED=1`
   overrides, for a deliberate supervised teardown.

Guards 3 and 5 are covered by unit tests that assert they **refuse**, not merely that
the happy path works.

---

## Reviewing the plan without a Cloudflare token

The merge is a pure function, so the whole plan can be rendered offline:

```bash
kubectl get svc -A -l platform.capstone/access=ssh -o json > /tmp/services.json
# and a JSON file holding the tunnel's `config` object, e.g. exported from the
# dashboard, or hand-written to mirror it
PLATFORM_DOMAIN=uamishub.com python3 reconcile.py --plan \
  --services /tmp/services.json --tunnel-config /tmp/tunnel.json
```

It prints the discovered tenants, the ADD/DEL/keep decisions, and **the exact
ingress list that would be PUT**. No API is contacted.

## Tests

```bash
cd platform-services/cf-vm-access && python3 -m unittest test_reconcile -v
```

26 tests over the merge: catch-all preserved, insert-before-catch-all, idempotent,
teardown removes only the departed tenant, unrelated rules preserved byte-identical,
platform hostnames never classified as ours, and each guard asserted to refuse.

---

## Operator go-live

### Step 1 — create the API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Create Custom
Token**. Three permissions:

| Type | Resource | Level | Why |
|---|---|---|---|
| **Account** | Cloudflare Tunnel | **Edit** | GET + PUT the tunnel configuration (the route) |
| **Account** | Access: Apps and Policies | **Edit** | create/update/delete the Access app, its policy, and its short-lived-cert CA |
| **Zone** | DNS | **Edit** | not used today — the `*.uamishub.com` wildcard already resolves every `<team>-ssh` host. Include it only if you later want per-host CNAMEs; **omit it for least privilege.** |

Scope **Account Resources** to this account only and **Zone Resources** to
`uamishub.com` only. Set an expiry and calendar the rotation.

Minimum viable token = the two **Account** permissions. It is not an admin token, but
it can rewrite the routing for every public platform hostname — treat it accordingly.

### Step 2 — seal it

```bash
kubectl create secret generic cloudflare-api-token \
  --from-literal=token='<THE TOKEN>' \
  --namespace cloudflared --dry-run=client -o yaml \
| kubeseal --format yaml --controller-namespace sealed-secrets \
> platform-services/cf-vm-access/sealedsecret-cf-api-token.yaml
```

Add `sealedsecret-cf-api-token.yaml` to `kustomization.yaml`'s `resources:`. It is
deliberately not shipped as a placeholder — an illegal-base64 placeholder puts the
app Degraded.

### Step 3 — fill in the IDs

Both are already in the existing tunnel token:

```bash
kubectl -n cloudflared get secret cloudflared-tunnel-token \
  -o jsonpath='{.data.token}' | base64 -d | base64 -d
# -> {"a":"<CF_ACCOUNT_ID>","t":"<CF_TUNNEL_ID>","s":"..."}
```

Put them in `configmap-ids.yaml`. Commit steps 2 and 3 together.

### Step 4 — run one dry-run and READ IT

```bash
kubectl -n cloudflared create job --from=cronjob/cf-vm-access-reconciler cf-vm-access-dryrun
kubectl -n cloudflared logs job/cf-vm-access-dryrun
```

Check, against the live tunnel config:

- the printed "exact ingress list that WOULD be PUT" contains **every** rule the
  tunnel has today, unchanged and in the same relative order;
- the last entry is the hostname-less catch-all;
- the only additions are `<team>-ssh.uamishub.com → ssh://…:22`, one per team;
- there are no unexpected `DEL` lines.

If the log says `REFUSE`, **stop** — a guard tripped and the reason is printed.

### Step 5 — flip the switch

Set `DRY_RUN` to `"0"` in `cronjob.yaml`, commit, let ArgoCD sync, re-run the job.

### Step 6 — bake the CA into each guest

The reconciler logs one CA public key per Access app:

```bash
kubectl -n cloudflared logs job/cf-vm-access-dryrun | grep -A1 "CA public key"
```

Paste each into that team's cloud-init at `/etc/ssh/cf_access_ca.pub`, re-seal,
commit, then **delete the VirtualMachine** so cloud-init re-runs. Ordering is
unavoidable: the CA does not exist until the Access app does, and cloud-init runs
only on first boot. Do it before students have state on the box.

Verify:

```bash
cloudflared access ssh --hostname <team>-ssh.uamishub.com
```

---

## Rollback

Set `DRY_RUN` back to `"1"` and the reconciler stops writing immediately. To remove
the routes it created, delete the ssh Services (or their namespaces) and let one
enforcing pass reconcile them away. To revert by hand, the tunnel config is editable
in the dashboard — the reconciler will re-add its own rules on the next pass unless
`DRY_RUN=1`.
