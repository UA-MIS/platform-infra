# Rotating the `ua-mis-backstage` GitHub App private key (SEC-037, #134)

**Status: MAPPED, NOT PERFORMED.** Nothing in this document has been executed.
It exists so the rotation can be run without re-deriving anything.

App **4097147** (`ua-mis-backstage`) is installed org-wide on
`repository_selection: all` with `administration: write`, `contents: write`,
`workflows: write`, and is a branch-protection bypass on `platform-infra` main.
Its private key was reachable from a student-writable repository until
`UA-MIS/ida-llm#27` landed. There is no evidence it was taken; there is also no
log that would show it, which is the reason to rotate.

---

## The consumer map

Enumerated **2026-08-27** against the live cluster. Fingerprints are
`sha256(value)[:16]`; no key material appears here or in the tooling that
produced it.

App 4097147 has **7 consumers**, fed from **4 staging locations**:

| # | consumer | staged from | encoding | auto-restart? |
|---|---|---|---|---|
| 1 | `agile/alhands-agile-shared` | Vault `platform/agile-board` | **base64-of-PEM** | Reloader ✅ |
| 2 | `agile/capstone-demo-agile-shared` | Vault `platform/agile-board` | **base64-of-PEM** | Reloader ✅ |
| 3 | `agile/wizarddress-agile-shared` | Vault `platform/agile-board` | **base64-of-PEM** | Reloader ✅ |
| 4 | `agile/wizardtest-agile-shared` | Vault `platform/agile-board` | **base64-of-PEM** | Reloader ✅ |
| 5 | `agile/agile-env` | SealedSecret `platform-services/agile/sealedsecret-env.yaml` | raw PEM | **NO** ⚠ |
| 6 | `backstage/backstage-process-secrets` | SealedSecret `platform-services/backstage/sealedsecret-oidc.yaml` | raw PEM | **NO** ⚠ |
| 7 | `argocd/argocd-repo-creds-uamis` | SealedSecret `platform-services/argocd-config/sealedsecret-repo-creds.yaml` | raw PEM (`githubAppPrivateKey`) | **NO** ⚠ |

Consumers 1–4 share **one** Vault object, so one write covers all four.
**4 staging operations cover all 7 consumers: 1 Vault write + 3 `kubeseal` commits.**

### NOT in scope — a different App

`arc-runners/arc-github-app` holds app_id **4064793**, key fp `99defc47acd3cb3e`
— a *different* GitHub App. **Rotating 4097147 does not touch the CI runners.**
They will keep starting normally. What does stop is anything using 4097147:
scaffolding, the autobump PR path, ArgoCD's GitHub auth, and board PR-linking.

### Two corrections to the previously recorded list

1. **`ida-llm-prod/ida-llm-agile-secret` is no longer a consumer.** The App
   properties are gone from the Secret and from its ExternalSecret;
   `hack/audit-tenant-credentials.py` reports `0 value match(es)`.
2. **The boards are not on a second key.** They fingerprint differently
   (`49fcf50314d7b8cc`, len 2240) only because the value is stored
   **base64-encoded a second time**. Decoding once yields `8ba1cda456d71104`,
   len 1679 — byte-identical to the ArgoCD/Backstage copy. See the trap below.

---

## ⚠ The encoding trap

**One key, two storage encodings.** Verified by decoding, not inferred:

```
agile/wizarddress-agile-shared : len 2240, starts b'LS0tLS1CRUdJTiBSU0Eg...'  (base64 of PEM)
   base64-decode once          -> len 1679, fp 8ba1cda456d71104
argocd/argocd-repo-creds-uamis : len 1679, starts b'-----BEGIN RSA PRIVATE KEY----'
                                                    fp 8ba1cda456d71104   ← identical
```

The application tolerates both (the boards log
`[startup] GitHub credential: GitHub App (app id 4097147, installation 141394298)`
while holding the base64 form; `agile-env` runs the same image on the raw form).

**Write each consumer in the encoding it already holds.** Putting raw PEM into
`platform/agile-board` breaks all four boards; putting base64-of-PEM into the
ArgoCD or Backstage SealedSecret breaks GitOps and onboarding. Normalising the
encodings is a worthwhile cleanup and **must not be attempted during the
rotation** — one variable at a time.

## ⚠ Reloader is absent on the three that matter most

The four chart boards carry `secret.reloader.stakater.com/reload` and restart
themselves. **`agile/agile`, `backstage/backstage` and every `argocd/*`
deployment do not.** Env is resolved only at container start, so those three keep
serving on the **old** key while reporting `Ready`.

**Consequence for verification: a green check taken before the restart is not
evidence.** It is the same shape as the documented
`optional secretKeyRef + no Reloader` incident class. Restart first, then verify.

---

## The overlap window is available

GitHub Apps support **two active private keys simultaneously**. The question is
whether the second slot is free — if both were already occupied you would have to
delete one first, which destroys the overlap and turns this into a hard cutover.

**It is free.** App 4097147 has exactly **one** live private key
(`8ba1cda456d71104`); the apparent second is the same key double-encoded.

> Confirm in the App settings before starting — the cluster can only show which
> keys are *in use*, not how many *exist*. If GitHub already lists two, delete the
> unused one first and re-verify, or the overlap is unavailable.

---

## Sequence

Order is chosen so the key is **proven on a low-consequence consumer before the
one that cannot repair itself**. ArgoCD is last because a broken ArgoCD cannot
deploy its own fix — GitOps is the delivery mechanism for stages 2–4.

Throughout stages 1–5 the **old key remains valid**, so a mis-staged consumer is
an isolated breakage, never a platform outage.

### Stage 0 — generate, do not distribute

Generate a second private key in the App settings. Both are now valid. Record its
fingerprint so every later check is against a known value:

```bash
openssl rsa -in <new>.pem -pubout -outform DER 2>/dev/null | sha256sum   # identity
sha256sum <new>.pem | cut -c1-16                                          # matches the table
```

**Do not delete the old key. Not at any point before stage 6.**

### Stage 1 — the four boards (Vault, base64-of-PEM)

```bash
# NOTE the encoding: base64 the PEM before writing.
base64 -w0 <new>.pem > /tmp/newkey.b64
vault kv patch -mount=secret platform/agile-board \
  GITHUB_APP_PRIVATE_KEY="$(cat /tmp/newkey.b64)"
```

**Verify** (Reloader restarts these; wait for new pods):

```bash
kubectl -n agile rollout status deploy/wizarddress-agile --timeout=120s
kubectl -n agile logs deploy/wizarddress-agile --tail=50 | grep 'GitHub credential'
# expect: GitHub App (app id 4097147, installation 141394298)
```

Then exercise the credential, not just startup: open a board and confirm
**PR-linking still resolves** on a work item. Startup logging the app id proves
configuration was read; it does not prove GitHub accepted the JWT.

**Rollback:** `vault kv patch` the previous value back, `kubectl -n agile rollout
restart deploy -l app.kubernetes.io/name=agile-board`.

### Stage 2 — Backstage scaffolder (SealedSecret, raw PEM)

```bash
kubeseal --format yaml --namespace backstage --name backstage-process-secrets \
  < <(kubectl create secret generic backstage-process-secrets \
        --namespace backstage --dry-run=client -o yaml \
        --from-file=GITHUB_APP_PRIVATE_KEY=<new>.pem ...)   # keep all other keys
# commit platform-services/backstage/sealedsecret-oidc.yaml, let ArgoCD sync
kubectl -n backstage rollout restart deploy/backstage      # NO Reloader here
kubectl -n backstage rollout status deploy/backstage --timeout=180s
```

**Verify:** run a scaffolder template end-to-end (repo created, Harbor project
made). A Backstage that starts is not a Backstage that can create repos.

**Rollback:** revert the commit, sync, `rollout restart`.

### Stage 3 — maintainers' board (SealedSecret, raw PEM)

`platform-services/agile/sealedsecret-env.yaml`, same shape as stage 2, then
`kubectl -n agile rollout restart deploy/agile` — **no Reloader**.

**Verify:** the maintainers' board loads and PR-linking resolves.

### Stage 4 — autobump / tenant CI

No separate staging: the autobump path uses the App installation token minted
from a key staged above. **Verify** by merging a trivial tenant change and
confirming the bump PR opens and its checks run. If autobump is found to read
the key from somewhere not in the table above, stop — the denominator is wrong.

### Stage 5 — ArgoCD (SealedSecret, raw PEM, `githubAppPrivateKey`) — LAST

**Highest consequence. Have a non-GitOps recovery path open before starting**: a
terminal with cluster-admin able to `kubectl apply -f` the *previous*
`sealedsecret-repo-creds.yaml`, because a broken ArgoCD cannot sync its own fix.

```bash
# key name is githubAppPrivateKey (camelCase), NOT GITHUB_APP_PRIVATE_KEY
kubeseal --format yaml --namespace argocd --name argocd-repo-creds-uamis < ...
```

**Verify immediately:**

```bash
kubectl -n argocd get secret argocd-repo-creds-uamis \
  -o jsonpath='{.data.githubAppPrivateKey}' | base64 -d | sha256sum | cut -c1-16
argocd repo list                       # expect Connection Status: Successful
kubectl -n argocd rollout restart deploy/argocd-repo-server
kubectl -n argocd rollout status deploy/argocd-repo-server --timeout=180s
argocd app get platform-services --refresh   # must reach the repo
```

**Rollback:** `kubectl apply -f` the previous SealedSecret directly (not via git),
then `rollout restart deploy/argocd-repo-server`.

### Stage 6 — only now, remove the old key

Re-verify all four staging locations hold the **new** fingerprint and every
consumer has been **restarted** since:

```bash
python3 hack/audit-tenant-credentials.py    # expect 0 value matches
# and re-run the enumeration that produced the table above
```

Then delete the old key in the App settings. Watch ArgoCD, Backstage and one
board for 30 minutes; the failure mode of a missed consumer is a 401 at the next
token mint, not at deletion.

**Rollback after stage 6 is generation of a fresh key and a repeat of stages 1–5** —
the deleted key cannot be recovered. This is the one irreversible step, and it is
why it is last.

---

## The denominator — how I know 7 is all of them

Four independent enumerations, because "I grepped and found four" and "there are
exactly four" are different claims:

| method | what it catches | blind to |
|---|---|---|
| **M1** repo grep, all spellings | what manifests declare | hand-provisioned secrets absent from git |
| **M2** live scan for App-key-shaped key *names* | any Secret with a matching key name | a key stored under an unrelated name |
| **M3** live **value fingerprint**, all 273 secrets in all 64 namespaces | this exact key **whatever it is named** — the strong signal | see residual below |
| **M4** ExternalSecret `remoteRef` walk | maps each live Secret back to its Vault path | Vault paths with no current consumer |

Coverage of M3 verified rather than assumed: `kubectl auth can-i list secrets
--all-namespaces` → **yes**; 64 namespaces, 273 secrets enumerated, **zero read
errors**. M3 is therefore cluster-complete, and it is the method that found the
double-encoded board copies M1 and M2 would each have mis-classified.

**Residual blind spots — the claim is "7 in this cluster", not "7 in the world":**

1. **Vault paths with no live consumer.** M4 derives Vault paths *backwards from
   consumers*, so a copy parked at an unused path is invisible. Requires Vault
   credentials this analysis did not have:
   ```bash
   vault kv list -mount=secret platform/ && vault kv list -mount=secret tenants/
   # then grep each object's keys for GITHUB_APP_PRIVATE_KEY
   ```
   **Run this before stage 6.** A stale copy is both a rotation miss and a
   second SEC-037.
2. **Consumers outside this cluster** — GitHub Actions org/repo secrets, a
   developer laptop, anything in another cluster. Nothing here can see those.
3. **Holders of a derived installation token** rather than the key. Self-healing
   (tokens expire ~1h) but explains any brief post-rotation 401.
4. **`agile/agile-env` and `backstage/backstage-process-secrets` carry no
   `GITHUB_APP_ID`** alongside the key — their app_id comes from config
   elsewhere. Attribution for those two rests on the value fingerprint matching
   4097147's key, which is sound, but note it is inferred rather than labelled.

---

## Interaction with the board migration

Migrating `ida-llm` onto the chart (`tenants/_boards/ida-llm.yaml`) **reduces**
rotation surface: that board stops holding its own copy under
`tenants/ida-llm/prod/agile` and becomes a fifth consumer of the single
`platform/agile-board` object — covered by stage 1's one write, with Reloader.

The two changes are independent and can be done in either order.
