# MIS 521 lab VM tenants — the known-good original, and what changes per copy

This is the file set for **one** MIS 521 lab VM tenant, plus a per-copy diff list.
It is deliberately **not** a template: the three tenants are hand-built, and
hand-copying is only safe when the thing being copied is known-good and the
per-copy edits are enumerated. Both halves are below.

The reference tenant used throughout is `tenants/crimson-copies-stripped-vm/`.
**Do not edit that directory** — it is the owner's live lab template. Copy from it.

---

> ## ⛔ READ THIS FIRST — `cloudflared access ssh` CANNOT tell you what is wrong
>
> When SSH does not work you will reach for this, because it is the obvious thing:
>
> ```
> cloudflared access ssh --hostname <team>-ssh.uamishub.com
> websocket: bad handshake
> ```
>
> **That output tells you nothing.** It is byte-identical for a hostname with a
> correct tunnel route and for a hostname that has never existed. So is `curl`:
>
> | Probe | route added by hand | invented hostname, no route |
> |---|---|---|
> | `curl https://…/` | HTTP/2 404, `content-length: 19` | **byte-identical** |
> | `cloudflared access ssh …` | `websocket: bad handshake` | **identical** |
>
> Both measured, 2026-08-27, against a route the owner had just added.
>
> **Why:** `cloudflared access ssh` does not open a raw socket. It fetches an Access
> token and upgrades to a websocket on an **Access-provided** endpoint. With no Access
> application on the hostname there is nothing to upgrade against, so the edge answers
> as ordinary HTTP — regardless of what is behind it. `bad handshake` also has several
> unrelated documented causes.
>
> **Two consequences:**
>
> 1. **A tunnel route alone is necessary but NOT sufficient.** The Access application
>    is required for the transport to exist at all. Adding one half by hand produces a
>    state that cannot be tested and does not work. `cf-vm-access` provisions both
>    together for exactly this reason.
> 2. **Do not debug Cloudflare from these two commands.** Use the probe below first —
>    it splits guest-side from Cloudflare-side in one shot:
>
> ```bash
> # from a pod in the `cloudflared` namespace (the tenant netpol admits it on :22)
> ssh -i <break-glass-key> ubuntu@<app>-ssh.<team>-vm-prod.svc.cluster.local
> ```
>
> - **succeeds**, external still fails → guest and netpol are proven; the fault is
>   Cloudflare-side (route and/or Access app). Stop looking at the VM.
> - **fails** → the fault is in the guest. Stop looking at Cloudflare.

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
| **The sealed cloud-init** | `cloudinit-sealedsecret.yaml` | **cannot be copied.** See §3. (Mechanism retired — see §3a.) |
| **The Cloudflare Access SSH CA** | tenant repo `.devops/chart/base/cloud-init.yaml` | **cannot be copied — cross-tenant authorization leak.** The CA is per-Access-*application*. See §3a. |
| The team's GitHub roster | tenant repo `.devops/chart/base/cloud-init.yaml` | `ssh_import_id` **and** `/etc/capstone/ssh-roster`, which must not drift apart |
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

> ⚠ **This section describes a RETIRED mechanism.** cloud-init is no longer sealed
> and carries no deploy key; it lives in the tenant repo. Kept for history and
> because its lesson transferred intact to a *different* credential — **read §3a,
> which is the live version of this trap.** The `tenants/_vm-workloads/` paths below
> were torn down in #604.

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

## 3a. TRAP 1, IN THE CURRENT MODEL — the per-app Access SSH CA cannot be copied

**§3's mechanism is retired; its lesson is not.** cloud-init is no longer a
SealedSecret in this repo. It lives in the **tenant repo** at
`.devops/chart/base/cloud-init.yaml`, and kustomize's `secretGenerator` packages it
into the `<app>-cloudinit` Secret. There is no deploy key in it any more, because
the guest no longer clones the repo — students authenticate with `gh auth login`.

So the *specific* credential §3 warns about is gone. **A different one took its
place, and it is not in §2's original table** — which is how it was nearly copied
into two new tenants on 2026-08-31.

`cloud-init.yaml` writes `/etc/ssh/cf_access_ca.pub`, and the sshd drop-in beside it
does:

```
TrustedUserCAKeys /etc/ssh/cf_access_ca.pub
AuthorizedPrincipalsCommand /bin/sh -c "echo '%t %k' | ssh-keygen -L -f - | grep -A1 Principals"
```

That is a deliberate design — Cloudflare Access is the gate — but read what it
means: **any certificate signed by the CA in that file authenticates as the login
user.** And the CA is issued **per Access application**
(`/accounts/{id}/access/apps/{app_id}/ca`), not per account.

Therefore **copying one team's `cf_access_ca.pub` line into another team's
cloud-init lets anyone authorised on the FIRST team's `vm-ssh` Access app log into
the SECOND team's VM as the cloud user.** It is the same class of cross-tenant leak
as §3, it is silent — the guest boots fine and SSH appears to work — and the
cloud-init's own comment already states the containment property that copying
destroys: *"it is contained because the CA is PER-APP, so a cert minted for another
VM's app does not authenticate here."*

**What to ship in a new tenant.** Leave the CA out. A comments-only file is an
explicitly supported state — *"Blank = cert auth off, key-only"* — and sshd starts
cleanly with it (verified against OpenSSH 9.6, both for a comments-only file and a
missing one). The guest is then reachable by the browser console and by the
`ssh_import_id` / roster key path; only Access-**SSH** is inactive.

**Then, once per team:** create that team's `vm-ssh` Access app, read the CA public
key the `cf-vm-access` reconciler logs (see §7 step 6 and
`vm-ssh-cloudflare-access.md`), paste **that team's own** key into **that team's**
cloud-init, and rebuild the VM so cloud-init re-runs. It is a PUBLIC key — safe to
commit.

**Check before committing a new tenant:**

```bash
# must print NOTHING but this team's own CA (or nothing at all)
grep -rn 'cloudflareaccess.org' <tenant-repo>/.devops/chart/base/cloud-init.yaml \
  | grep -E '^\s*(ecdsa|ssh)-'
```

> The same "derive it, do not copy it" rule now also covers the team's GitHub
> roster, which appears **twice** in cloud-init (`ssh_import_id` and
> `/etc/capstone/ssh-roster`) and must not drift between the two.

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

### The fourth load-bearing line: declare BOTH requests and limits

A chart that declares `requests.memory` and nothing else produces a VM that **never
starts**, and inflates its own ask while doing it. With no memory limit in the spec,
KubeVirt derives the pod limit itself — `WithAutoMemoryLimits` multiplies
(guest + overhead) by a ratio that defaults to **2**:

| chart declares | pod asks the namespace for |
|---|---|
| `requests.memory: 8Gi` only | **17064Mi** — (8Gi + ~340Mi) × 2 |
| requests **and** limits | **8532Mi** — 8Gi + ~340Mi |

Declaring the limit **halves** the ask. The ratio is overridable per namespace via the
label `alpha.kubevirt.io/auto-memory-limits-ratio` (must be ≥ 1.0), but the right fix
is the manifest, not the label.

The skeleton now emits all four values. If you hand-build a chart, do the same:

```yaml
        resources:
          requests: { memory: <N>Gi, cpu: "<C>" }
          limits:   { memory: <N>Gi, cpu: "<C>" }
```

**How much does the guest actually need?** Measured, not estimated — the lab app
(Node 22 + MariaDB + nginx + two Next.js 15 apps) under a cgroup v2 cap:

| Phase | `memory.peak` |
|---|---|
| after `pnpm install` | **2203 MiB** |
| after both Next builds (serial) | **2203 MiB** — not exceeded |

The peak is **install**, not build. So 8Gi is comfortable and even 4Gi would build.
Note the measurement is native x86-64: TCG emulation changes build **time**
dramatically, not heap.

**And the ceiling has to agree with the form.** `hack/lint-vm-tier-bounds.py`
(`make validate` gate [9/9]) fails if the wizard's maxima exceed what the tier's quota
and LimitRange will admit. It exists because those two documents disagreed silently
and the disagreement only surfaced as a rejected pod ten minutes into a provision.

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

### A 404 does NOT prove the route is missing, and `cloudflared` does not either

Measured on 2026-08-27 against a hostname the owner had **just added a tunnel route
for by hand**, alongside a control hostname invented on the spot that certainly had
no route:

| Probe | `<team>-ssh.uamishub.com` (route added) | `zz-definitely-no-route-ssh.uamishub.com` |
|---|---|---|
| `curl https://…/` | HTTP/2 404, `content-length: 19`, `404 page not found` | **byte-identical** |
| `cloudflared access ssh --hostname …` | `websocket: bad handshake` | **identical** |

**Neither probe discriminates.** Do not conclude "the route is missing" from a 404,
and do not conclude anything from `bad handshake` — that error has several
documented causes and route-absence is not reliably one of them.

The reason `cloudflared access ssh` cannot work on a route alone: it does not open a
raw TCP socket to the edge. It fetches an Access token and upgrades to a websocket on
an **Access-provided** endpoint. With no Access application on the hostname there is
no endpoint to upgrade against, so the edge answers as ordinary HTTP and the client
reports `bad handshake` whether or not an `ssh://` route exists behind it.

**Practical consequence: a hand-added tunnel route is necessary but not sufficient.
The Access application is required for the transport to exist at all.** This is why
`cf-vm-access` provisions both together and why hand-adding one half does not
produce a testable state.

**The probe that does discriminate** is from inside the cluster, and it splits
guest-side from Cloudflare-side in one shot:

```bash
# from a pod in the `cloudflared` namespace (the netpol admits it on :22)
ssh -i <break-glass-key> ubuntu@<app>-ssh.<team>-vm-prod.svc.cluster.local
```

- succeeds, external still fails → guest and netpol are proven; the fault is
  Cloudflare-side (route and/or Access app)
- fails → the fault is in the guest; stop looking at Cloudflare

---

## 6a. Boot-time traps — all three seen on the first wizard-scaffolded VM

### The stale VMI: fixing git is not enough

A `VirtualMachineInstance` spec is **immutable**. Correcting the chart and letting
ArgoCD sync updates the `VirtualMachine` template but leaves any in-flight VMI on the
old spec forever. KubeVirt says so and then waits:

```
RestartRequired=True   "a non-live-updatable field was changed in the template spec"
Synchronized=False     FailedCreate ... limit is 17064Mi
```

The cluster cannot converge on its own. Delete the VMI and the VM controller recreates
it from the corrected template:

```bash
kubectl -n <team>-vm-prod delete vmi <app>
```

Safe when the guest has never booted: it touches neither the DataVolume nor the PVC
(check `DataVolumesReady=True` first), so it does **not** re-run the disk import. On a
guest that HAS booted this is a cold restart — student state on the disk survives,
anything in RAM does not.

### `ClaimMisbound` during import is benign

```
ClaimMisbound: Two claims are bound to the same volume, this one is bound incorrectly
  <app>-rootdisk  and  prime-<uuid>
```

This is CDI's **volume-populator handover**, not corruption. The importer writes into a
`prime-` PVC and CDI then hands the underlying PV to the real PVC — the annotation is
literally `cdi.kubevirt.io/allowClaimAdoption: true`, next to `storage.usePopulator:
true` and `storage.populator.pvcPrime`. Both claims transiently reference one PV and
the PV controller complains about whichever does not match `pv.spec.claimRef`.

Confirm it cleared rather than assuming:

```bash
kubectl -n <team>-vm-prod get pvc            # zero prime- PVCs should remain
kubectl get pv <pv> -o jsonpath='{.spec.claimRef.namespace}/{.spec.claimRef.name}'
```

### ⚠ Deleting the PVC destroys the semester's work

These PVs are `persistentVolumeReclaimPolicy: Delete`, and that is a **deliberate,
accepted choice** — not an oversight to be fixed. It is written down here so nobody
discovers it during a teardown.

The VM is a pet on RWO ceph. Everything a team does lives on that one disk: the repo
they cloned, the database they seeded, the config they hand-edited. There is no
backup of it and no snapshot class for `ceph-block` (`volumeSnapshotStatuses` reports
`No VolumeSnapshotClass`). **When the PVC goes, the PV goes with it, immediately and
irreversibly.**

What that means in practice:

- Deleting the **VMI** is safe — it does not touch the PVC. That is the
  `RestartRequired` remedy above.
- Deleting the **VirtualMachine** takes the `dataVolumeTemplates`-owned PVC with it.
  This is the "rebuild the VM to re-run cloud-init" path, and it is destructive to
  everything the team has done. Fine during onboarding, before students have state;
  never casually afterwards.
- Deleting the **namespace**, or tearing the tenant down, is the same thing with a
  wider blast radius.

If a team's work needs to survive a rebuild, copy it off the guest first — there is no
platform mechanism that will do it for you.

### ArgoCD `Suspended` is not terminal

ArgoCD's built-in KubeVirt health check reads the VM's `printableStatus`:

| VM status | ArgoCD health |
|---|---|
| Stopped / Halted / Paused | **Suspended** |
| Provisioning / Starting | **Progressing** |
| Running + Ready | **Healthy** |

A running VM tenant genuinely reaches `Synced / Healthy` — the reference tenant does.
So `Suspended` means "the VM is not running", which for a `runStrategy: Always` VM is
transient. Persistent `Suspended` is worth investigating; seeing it during a provision
is not.

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
