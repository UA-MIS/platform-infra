# MIS 521 lab VM tenants — the known-good original, and what changes per copy

This is the file set for **one** MIS 521 lab VM tenant, plus a per-copy diff list.
It is deliberately **not** a template: the three tenants are hand-built, and
hand-copying is only safe when the thing being copied is known-good and the
per-copy edits are enumerated. Both halves are below.

The reference tenant used throughout is `tenants/crimson-copies-stripped-vm/`.
**Do not edit that directory** — it is the owner's live lab template. Copy from it.

---

## 0. What a student gets, and what has to be true for that

A student opens `https://<team>-ssh.uamishub.com` in a browser (or runs
`cloudflared access ssh --hostname <team>-ssh.uamishub.com`), authenticates against
Cloudflare Access with their university email, and lands in a shell on their team's
VM. They then install and deploy their app by hand. That manual deployment **is** the
coursework; the pipeline that replaces it is what they build later.

Five things must all be true. They fail independently and, from a laptop, **three of
them fail identically** — see the failure-mode table in §6 before debugging.

| # | Requirement | Where it comes from |
|---|---|---|
| 1 | `<team>-ssh.uamishub.com` resolves and serves valid TLS | Already true — apex wildcard DNS + the `*.uamishub.com` certificate. Nothing to do. |
| 2 | A tunnel ingress rule routes that host to `ssh://<app>-ssh.<ns>.svc:22` | `cf-vm-access` reconciler, once the token exists |
| 3 | A Cloudflare Access app on that host admits the team | `cf-vm-access` reconciler, from the Service annotation |
| 4 | The guest has a **listening sshd** that trusts the Access CA | this tenant's cloud-init |
| 5 | The netpol lets `cloudflared` reach the VM on :22 | the namespace bundle |

---

## 1. The file set for one tenant

Six files. Paths are for team slug `__TEAM__` and app/repo name `__APP__`.

```
tenants/__TEAM__-vm/
  README.md                              # what this tenant is
  vm/appproject-vm.yaml                  # tenant-owned project (team repo)
  vm/appproject-vm-platform.yaml         # platform-owned project (this repo)
  vm/application-vm.yaml                 # Application syncing the workload dir
  vm/namespaces/vm-prod.yaml             # namespace + quota + limits + netpols + RBAC
tenants/_vm-workloads/__TEAM__/
  virtualmachine.yaml                    # the guest
  cloudinit-sealedsecret.yaml            # first-boot provisioning, SEALED
  service-ingress.yaml                   # HTTP Service + Ingress + the ssh Service
```

Copy each from the corresponding `crimson-copies-stripped` file.

---

## 2. What MUST change per copy

Everything in this table. A missed row is a defect, not a cosmetic difference.

| What | In which files | Note |
|---|---|---|
| Team slug `crimson-copies-stripped` → `<team>` | all six | must equal the **GitHub team slug** exactly, or the AppProject role binds to a group Dex never emits and the role is silently inert (SEC-021) |
| Namespace `<team>-vm-prod` | namespaces, both AppProjects, Application, workload | |
| `sourceRepos` in `appproject-vm.yaml` | tenant AppProject | the **team's** repo, both with and without `.git` |
| `path:` in `application-vm.yaml` | Application | `tenants/_vm-workloads/<team>` |
| `platform.capstone/semester` | all | |
| VM name + `kubevirt.io/domain` | workload, Services | the Service selector matches on this — get it wrong and the Service has no endpoints and SSH fails with no error anywhere |
| DataVolume name | workload | |
| Ingress hosts | `service-ingress.yaml` | |
| `platform.capstone/ssh-access-emails` | ssh Service | the team's emails. **Empty = an Access app that admits nobody.** |
| **The sealed cloud-init** | `cloudinit-sealedsecret.yaml` | **cannot be copied.** See §3. |
| `namespaceResourceWhitelist` | both AppProjects | **must be re-derived.** See §4. |

### What must NOT change

- The `platform.capstone/access: ssh` label on the ssh Service. It is the
  reconciler's entire discovery mechanism.
- The netpol names and shapes in `vm-prod.yaml`.
- `dnsPolicy: None` + `dnsConfig` on the VM. See §5.
- `rng: {}` on the VM. See §5.
- PSA `baseline` on the namespace. `restricted` breaks virt-launcher; `privileged`
  is a re-review event.

---

## 3. TRAP 1 — the sealed cloud-init cannot be copied between teams

`cloudinit-sealedsecret.yaml` carries a **per-repo read-only deploy key**. Copying
one team's sealed cloud-init to another team hands team B a working credential to
team A's repository. It is a cross-tenant credential leak, and because the guest
boots fine either way, nothing surfaces it.

Sealed secrets are also namespace- and name-scoped by default, so a copied
SealedSecret will not even decrypt in the new namespace — it will sit unsealed and
the VM will boot with no cloud-init at all, which presents as "SSH doesn't work".

**Do this per team, once:**

```bash
TEAM=<team>; APP=<app>

# 1. a fresh deploy key for THIS team's repo
ssh-keygen -t ed25519 -f ./id_${TEAM}_deploy -N '' -C "${TEAM}-vm-deploy"

# 2. add the PUBLIC half to THAT repo as a read-only deploy key
gh repo deploy-key add ./id_${TEAM}_deploy.pub \
  --repo UA-MIS/${APP} --title "${TEAM}-vm read-only"

# 3. build the cloud-init with the PRIVATE half + the team's SSH pubkey,
#    starting from the crimson-copies-stripped userdata as the shape
#    (edit paths/repo/app name; keep the sshd block from §5 verbatim)
$EDITOR ./user-data-${TEAM}.yaml

# 4. seal it INTO THIS TEAM'S NAMESPACE (the scope is part of the ciphertext)
kubectl create secret generic ${TEAM}-cloudinit \
  --from-file=userdata=./user-data-${TEAM}.yaml \
  --namespace ${TEAM}-vm-prod --dry-run=client -o yaml \
| kubeseal --format yaml --controller-namespace sealed-secrets \
> tenants/_vm-workloads/${TEAM}/cloudinit-sealedsecret.yaml

# 5. destroy the plaintext + the private key from disk
shred -u ./user-data-${TEAM}.yaml ./id_${TEAM}_deploy
```

Verify before committing — the sealed file must name the right namespace:

```bash
grep -E 'namespace|name:' tenants/_vm-workloads/${TEAM}/cloudinit-sealedsecret.yaml
```

---

## 4. TRAP 2 — `namespaceResourceWhitelist` must be derived, not copied

This is the defect that bit on 2026-08-26. An AppProject whose whitelist omits a
kind the workload actually contains does **not** fail loudly: ArgoCD reports
`InvalidSpecError` and stops reconciling, and if the app synced once before the
restriction landed it stays **Healthy** with a successful last operation while every
subsequent change silently fails to deploy.

Derive the list from the workload directory rather than trusting the copy:

```bash
TEAM=<team>
grep -h '^kind:' tenants/_vm-workloads/${TEAM}/*.yaml | sort -u
```

Every kind that prints must appear in `namespaceResourceWhitelist` in
**`appproject-vm-platform.yaml`** (the project the Application actually names).
`SealedSecret` (group `bitnami.com`) and the `Secret` it produces are both required —
the derived `Secret` is what the omission missed last time.

Then prove it against the live API server, which is the only check that sees CRD
schemas and field limits:

```bash
make validate                                   # offline guards, incl. [8/8]
kubectl apply --dry-run=server -f tenants/${TEAM}-vm/vm/appproject-vm-platform.yaml
kubectl apply --dry-run=server -f tenants/${TEAM}-vm/vm/application-vm.yaml
kubectl apply --dry-run=server -R -f tenants/_vm-workloads/${TEAM}/
make verify-argocd-apply                        # every Application/AppProject
```

### The 255-character description limit, quantified

`spec.description` on an AppProject is capped at 255 characters by the CRD.
`kubeconform` cannot see this — it has no schema for `AppProject` at all — so
`make validate` will pass a description that the API server rejects. Only
`--dry-run=server` catches it.

Measured on the current reference files:

| File | description length | headroom | team slug appears | **max team-slug length before it breaks** |
|---|---|---|---|---|
| `appproject-vm.yaml` | 140 | 115 | ×1 | 138 |
| `appproject-vm-platform.yaml` | **231** | **24** | **×2** | **35** |

So `appproject-vm-platform.yaml` is the one with almost no room, and because the
slug appears twice, every extra character of team name costs two. Any team slug over
**35 characters** breaks it. Shorten the description rather than the slug.

---

## 5. TRAP 3 — the three guest-spec lines that are load-bearing

These are in the reference VM because they were learned the hard way. All three
present as "SSH doesn't work".

**`dnsPolicy: None` + `dnsConfig`.** A VM's traffic leaves through the masquerade
interface and never passes a host socket, so Cilium's socket load-balancer never
runs and the kube-dns ClusterIP is never translated. The guest resolves nothing
while every pod in the same namespace resolves fine. No NetworkPolicy fixes this —
a policy can allow an address, it cannot translate one.

```yaml
      dnsPolicy: None
      dnsConfig:
        nameservers: [ "1.1.1.1", "1.0.0.1" ]
```

**`rng: {}`.** The cluster runs KubeVirt with `useEmulation: true` (QEMU TCG, no
hardware virt). sshd generates host keys on first boot; starved of entropy that can
stall for minutes, and a VM that is merely *not up yet* looks exactly like one that
is broken.

```yaml
        devices:
          rng: {}
```

**The sshd block in cloud-init.** Verbatim, in `write_files` + `runcmd`:

```yaml
  - path: /etc/ssh/cf_access_ca.pub
    permissions: '0644'
    content: |
      # Cloudflare Access SSH CA. Blank = cert auth off, key-only.
      <PASTE THE CA PUBLIC KEY HERE AT STEP 6>
  - path: /etc/ssh/sshd_config.d/10-cf-access-ca.conf
    permissions: '0644'
    content: |
      PubkeyAuthentication yes
      PasswordAuthentication no
      PermitRootLogin no
      TrustedUserCAKeys /etc/ssh/cf_access_ca.pub
      AuthorizedPrincipalsCommand /bin/sh -c "echo '%t %k' | ssh-keygen -L -f - | grep -A1 Principals"
      AuthorizedPrincipalsCommandUser nobody
```

```yaml
runcmd:
  - [ sh, -c, "systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || true" ]
  - [ sh, -c, "systemctl try-restart ssh 2>/dev/null || systemctl try-restart sshd 2>/dev/null || true" ]
```

Also `ssh_pwauth: false` and `disable_root: true` at the top level, and the team's
public key in `ssh_authorized_keys` as the break-glass path.

**Why `AuthorizedPrincipalsCommand` is not optional.** A Cloudflare Access
short-lived cert carries the user's **email prefix** as its principal (`ccsmith33`),
which is not the guest's cloud user (`ubuntu`). With plain `TrustedUserCAKeys` and no
principals mapping, sshd rejects it:

```
Certificate invalid: name is not a listed principal
```

That was reproduced against a real OpenSSH 9.6 sshd, and the command above was
verified to fix it. It was also verified that a CA file containing only comments —
the state every VM boots in before step 6 — lets sshd start normally and leaves the
team's plain key working.

**Security consequence, stated plainly:** this delegates all user-level
authorization to Cloudflare Access. Any cert signed by the trusted CA authenticates
as the login user. That is the intended design and it is contained, because the CA
is **per-Access-app** — a cert minted for another team's app does not authenticate
here. But it means an over-broad Access policy is an over-broad shell. Review the
policy, not the sshd.

**cloud-init runs once.** Editing it on a running VM does nothing — RWO ceph, pet
not cattle. To re-run, delete the VirtualMachine and let ArgoCD recreate it. Budget
for the re-import: the namespace transiently holds four PVCs (~85Gi), which is why
the quota is 120Gi and not 80Gi.

---

## 6. The failure-mode table — read this before debugging

Three distinct failures are **indistinguishable** from a student's laptop. All three
are a connection that does not complete. Check them in this order, because that is
cheapest-first:

| Symptom | Actually wrong | How to tell them apart |
|---|---|---|
| Browser shows Access login, then the terminal never opens | guest sshd does not trust the CA (step 6 not done, or VM not recreated after) | `virtctl console` in, `grep -c ssh /etc/ssh/cf_access_ca.pub` |
| Access login rejects the student | Access policy is empty or has the wrong emails | check the `ssh-access-emails` annotation on the ssh Service |
| No Access login at all — plain 404 | **no tunnel route** for the host; the request fell through to the catch-all | this is what `<team>-ssh.uamishub.com` returns *today*, before the reconciler runs |
| Route exists, connection hangs | netpol, or the Service has no endpoints | `kubectl get endpoints <app>-ssh -n <ns>` — empty means the `kubevirt.io/domain` selector is wrong |

A 404 is the *good* failure: it proves DNS, TLS and the tunnel are all working and
only the route is missing.

---

## 7. Go-live sequence

Steps 1–5 are per-tenant and can be done now. Step 6 needs the Cloudflare token.

```bash
TEAM=<team>

# 1. copy the file set, apply every edit in §2
# 2. per-team deploy key + sealed cloud-init (§3)
# 3. re-derive the whitelist (§4)
# 4. prove it BEFORE committing
make validate
kubectl apply --dry-run=server -R -f tenants/${TEAM}-vm/
kubectl apply --dry-run=server -R -f tenants/_vm-workloads/${TEAM}/
make verify-argocd-apply

# 5. commit, PR, merge; ArgoCD syncs; watch the guest actually come up
kubectl -n ${TEAM}-vm-prod get dv,vmi -w
kubectl -n ${TEAM}-vm-prod get endpoints ${APP}-ssh   # must be non-empty

# 6. AFTER the CF token is sealed and DRY_RUN=0 (see vm-ssh-cloudflare-access.md):
#    read the CA public key the reconciler logs, paste it into this team's
#    cloud-init, re-seal, commit — then DELETE the VM so cloud-init re-runs.
kubectl -n cloudflared logs job/cf-vm-access-manual | grep -A1 "CA public key"
```

Step 6's VM delete is unavoidable and should be scheduled: the CA does not exist
until the Access app does, the Access app does not exist until the ssh Service does,
and cloud-init only runs on first boot. One lossless recreate during onboarding,
before students have any state on the box.
