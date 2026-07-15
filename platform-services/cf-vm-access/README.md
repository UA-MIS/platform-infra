# cf-vm-access — automatic per-VM-tenant Cloudflare SSH provisioning (ADR-038)

Replaces the **3 manual Cloudflare-dashboard steps per VM tenant** that ADR-032a's
D2 left to the operator (Tunnel public hostname → Access application → DNS CNAME)
with an in-cluster reconciler. Every future VM tenant is **zero-touch**: on onboard
its `<app>-ssh` Service appears and the reconciler provisions the Cloudflare side;
on teardown the Service disappears and the reconciler removes it.

## How it works

- **Desired state = in-cluster Services.** `reconcile.py` (a CronJob, every 5 min)
  lists every `<app>-ssh` Service (label `platform.capstone/access=ssh`) across the
  `<team>-vm-prod` namespaces. For each it derives the hostname
  `ssh-<app>.capstone.uamishub.com`, the in-cluster target
  `ssh://<app>-ssh.<team>-vm-prod.svc.cluster.local:22`, and the team's allowed
  emails (Service annotation `platform.capstone/ssh-access-emails`).
- **Tunnel route** — a GET-merge-PUT on the platform tunnel's config that INSERTS the
  per-tenant `ssh-<app> → ssh://…:22` rule **before** the `*.capstone → traefik`
  wildcard (SSH carries no Host header, so it needs its own more-specific rule). The
  merge preserves every other rule verbatim and **aborts if the catch-all is missing**
  — it can never drop the platform's HTTP route. See ADR-038 §"Why not Crossplane".
- **Access application** — one self-hosted Access app per hostname with an Allow
  policy including the team's emails (SSH has no OIDC of its own; sshd is key-only as
  the backstop).
- **DNS** — nothing to do: the existing wildcard
  `*.capstone.uamishub.com CNAME <tunnel>.cfargotunnel.com` already resolves every
  `ssh-<app>` to the tunnel.

## One-time operator setup (go-live)

Agents cannot do these — they are cluster/Cloudflare writes (the platform's
"agents can't do cluster writes" gate). Do them once; every VM tenant thereafter is
automatic.

### 1. Create the Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token** with:

| Permission | Scope |
| --- | --- |
| Account · **Cloudflare Tunnel** · Edit | your account |
| Account · **Access: Apps and Policies** · Edit | your account |
| Zone · **DNS** · Edit | zone `capstone.uamishub.com` (optional — DNS is covered by the wildcard today; include it only if you later add per-tenant CNAMEs) |

### 2. Seal it into the cluster

Mirrors `platform-services/cloudflared/sealedsecret-tunnel-token.yaml` — same
controller, same `cloudflared` namespace, bound to name+namespace:

```bash
export KUBECONFIG=clusters/real-talos/talos-kubeconfig
kubectl create secret generic cloudflare-api-token \
  --namespace cloudflared \
  --from-literal=token='<the-CF-API-token>' \
  --dry-run=client -o yaml \
| kubeseal --controller-namespace kube-system --controller-name sealed-secrets-controller \
    --format yaml > platform-services/cf-vm-access/sealedsecret-cloudflare-api-token.yaml
# add the new file to kustomization.yaml `resources:` and commit
```

Then add `sealedsecret-cloudflare-api-token.yaml` to `kustomization.yaml`'s
`resources:` list. (It is intentionally NOT shipped as a placeholder stub — an
illegal-base64 placeholder would leave the app Degraded; the CronJob mounts the token
`optional:true`, so the reconciler simply no-ops until this real SealedSecret lands.)

### 3. Set the non-secret IDs

Fill `CF_ACCOUNT_ID` + `CF_TUNNEL_ID` in `configmap-ids.yaml` and commit. Both are
encoded in the existing tunnel token — `token` in the `cloudflared-tunnel-token`
Secret is `base64(JSON)` = `{"a":"<accountTag>","t":"<tunnelID>","s":...}`, so `a` =
account id, `t` = tunnel id (or read them in the dashboard — see the ConfigMap header).

### 4. Dry-run, review, then enforce

The CronJob ships `DRY_RUN=1` (report-only). After steps 1–3 sync, run one pass and
read its log — confirm the plan lists your SSH routes **and preserves the
`*.capstone → traefik` wildcard**:

```bash
kubectl -n cloudflared create job --from=cronjob/cf-vm-access-reconciler cf-vm-access-dryrun
kubectl -n cloudflared logs job/cf-vm-access-dryrun
```

Then flip `DRY_RUN` to `"0"` in `cronjob.yaml`, commit — the reconciler now applies.
To go back to report-only, flip it back to `"1"`.
