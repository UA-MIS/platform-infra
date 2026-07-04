# Operator Runbook — Backstage portal autobump via GitHub App token

**Scope:** one-time GitHub-side setup that makes the `bump-portal` job in
`.github/workflows/backstage-process-build-push.yaml` able to push the deploy-tag
commit directly to the **protected** `main` branch of `UA-MIS/platform-infra`.

**Why this exists:** `main` has classic branch protection with *"require a pull
request before merging."* A protected branch only accepts a direct push from an
identity on its **bypass-pull-request-allowances** list. The ephemeral
`github-actions[bot]` (the identity behind the job's `GITHUB_TOKEN`) **cannot** be
added to that list — GitHub's classic-protection bypass picker offers only
"Organization and repository administrators" and **GitHub Apps**. So `bump-portal`
now mints a short-lived **GitHub App installation token** and pushes as the App,
which **is** selectable in the bypass list. (Tenant repos' `bump-dev` works with a
plain `GITHUB_TOKEN` only because those repos have *no* branch protection at all.)

The workflow code is already merged as part of this PR. It will **fail loud** on
every push to `main` until steps 1–4 below are complete — never a silent
no-deploy.

---

## Decision: which App? (RECOMMENDED — dedicated least-privilege CI App)

**Recommendation: create a NEW dedicated App `ua-mis-platform-ci` with
`contents: write` on `platform-infra` ONLY.** Do **not** reuse the existing
`ua-mis-backstage` SSO App (App ID 4097147).

Reasoning:

- `ua-mis-backstage` is **auth-critical**: it backs Dex GitHub sign-in and
  Backstage catalog ingestion (org/members/teams read). Granting it
  `contents: write` and installing it on `platform-infra` would over-scope an
  identity that sits on the live login path — a leak of its key would then also
  grant repo-write.
- **Blast-radius isolation:** portal-login auth and CI push-to-main should not
  share one credential. A dedicated CI App can be rotated, suspended, or deleted
  without touching SSO, and vice-versa.
- **Least privilege:** the dedicated App needs exactly one permission
  (`contents: write`) on exactly one repo (`platform-infra`). The Backstage App
  needs org-read across many repos. Keeping them separate keeps each minimal.

> If you nonetheless decide to reuse `ua-mis-backstage`: confirm it is installed on
> `platform-infra`, add **Repository permissions → Contents: Read and write** to
> it, accept the new permission on the installation, and use its App ID +
> a private key in step 3. The workflow code is identical either way (it just
> reads `APP_ID` / `APP_PRIVATE_KEY`). This is **not** recommended for the reasons
> above.

---

## Step 1 — Create the App and install it on platform-infra

1. GitHub → the **UA-MIS org** → **Settings → Developer settings → GitHub Apps →
   New GitHub App**.
2. **Name:** `ua-mis-platform-ci` (any name; you will search for this exact name
   in step 4). **Homepage URL:** the repo URL is fine.
3. **Webhook:** uncheck **Active** (this App takes no events).
4. **Repository permissions:** set **Contents → Read and write**. Leave everything
   else **No access**. (No account/org permissions.)
5. **Where can this App be installed:** *Only on this account*.
6. **Create GitHub App.** Note the **App ID** shown on the App's settings page —
   this is `APP_ID`.
7. On the App page → **Install App** → install into the **UA-MIS** org → choose
   **Only select repositories → `platform-infra`** → **Install**.

## Step 2 — Generate a private key

1. On the App's settings page → **Private keys → Generate a private key**.
2. A `*.pem` file downloads. This full PEM (including the
   `-----BEGIN/END RSA PRIVATE KEY-----` lines) is `APP_PRIVATE_KEY`.
3. Store the PEM in your password manager; treat it as a secret. You can revoke and
   regenerate at any time from this page.

## Step 3 — Add the repo secrets

`platform-infra` → **Settings → Secrets and variables → Actions → New repository
secret** (create both):

| Secret name       | Value                                              |
|-------------------|----------------------------------------------------|
| `APP_ID`          | the numeric App ID from step 1.6                   |
| `APP_PRIVATE_KEY` | the **entire** contents of the `.pem` from step 2  |

CLI equivalent:

```bash
gh secret set APP_ID          --repo UA-MIS/platform-infra --body '<APP_ID>'
gh secret set APP_PRIVATE_KEY --repo UA-MIS/platform-infra < path/to/ua-mis-platform-ci.private-key.pem
```

## Step 4 — Add the App to main's branch-protection bypass list

1. `platform-infra` → **Settings → Branches → Branch protection rules → `main` →
   Edit**.
2. Under **Require a pull request before merging**, enable **Allow specified
   actors to bypass required pull requests**.
3. In the actor search box, type **`ua-mis-platform-ci`** — the **App** appears as
   a selectable option (unlike `github-actions[bot]`, which never appears). Select
   it.
4. **Save changes.**

> This is the step that actually lets the direct push land. Without it, the push in
> `bump-portal` is rejected by branch protection and the job fails loud.

---

## Verify the autobump works

1. Trigger a real portal build: push any source change under
   `platform-services/backstage/app/**` to `main` (or re-run the latest
   `backstage-process-build-push` run on `main`).
2. Watch **Actions → backstage-process-build-push**. Confirm:
   - `build-and-push` builds + pushes `…/backstage/backstage-process:<12-char-sha>`
     (grab the exact tag from the Kaniko log line `building + pushing …:<sha>`).
   - `bump-portal` runs (only on push-to-main), the **Generate GitHub App
     installation token** step succeeds, and the final step logs
     `committed. ArgoCD … will sync the portal.` followed by a successful
     `git push origin HEAD:main`.
3. Confirm the commit landed:
   ```bash
   git -C platform-infra fetch origin main
   git -C platform-infra log origin/main -1 --oneline   # -> "chore(backstage): bump portal image to <sha> [skip ci]"
   git -C platform-infra show origin/main:applicationsets/backstage-process-app.yaml \
     | grep -n 'tag:'                                    # -> tag equals the 12-char sha from step 2
   ```
   The commit author is `ua-mis-ci`; the **push** is authenticated by the App.
4. Confirm the `[skip ci]` commit did **not** retrigger a build (no new run for the
   bump commit) — the autobump is not a loop.
5. Confirm ArgoCD `platform-backstage-process` (syncPolicy automated) syncs the new
   `image.tag` into the live portal — hands-free, no manual go-live flip.

### If it fails

- **app-token step fails** (`APP_ID`/`APP_PRIVATE_KEY` missing or App not installed
  on the repo): re-check steps 1.7, 2, 3.
- **`git push` rejected / "protected branch"**: the App is not on main's bypass
  list — re-check step 4 (search by the App's exact name).
- Both failure modes are **loud** (`set -e`) — the job goes red, so a broken setup
  never silently skips the deploy.

---

## Rejected alternative

**`bump-portal` opens an auto-merge PR instead of pushing to main.** Rejected: even
with auto-merge enabled, the branch-protection rule still requires a PR **approval**
before the merge can complete, so it is not hands-free — every portal build would
block on a human review click. The App-token direct-push is the only fully
hands-free option that respects the existing protection rule.
