# `agile` — the UA-MIS Platform sprint board

`https://agile.uamishub.com` — the platform maintainers' own backlog. Gated to
the GitHub team **`UA-MIS:labmx`**, the same disjoint maintainers' group the
`db-admin` console uses.

## One image, many boards

The application lives in **`github.com/UA-MIS/agile-board`** and publishes a
single image, `harbor.capstone.uamishub.com/platform/agile-board:<sha>`. Every
board instance runs *that* image:

| Instance | Host | Team gate | Config lives in |
|---|---|---|---|
| UA-MIS Platform | `agile.uamishub.com` | `UA-MIS:labmx` | this directory |
| IDA | `ida-agile.capstone.uamishub.com` | `UA-MIS:ida-llm` | the `ida-llm` tenant |

The code began as `apps/agile/` inside `UA-MIS/ida-llm`. It was extracted with
`git subtree split` (history preserved), and **`ida-llm/apps/agile` is now
frozen** — left in place so the running IDA deployment is undisturbed, but no
longer the source of truth. A second team's board must never mean a second copy
of the code.

## Why the workload is HERE and not in the app repo

`slidedeck` and `ida-slides` are external-repo Applications: `platform-services/<name>/`
holds only glue, and the workload manifests live in the app repo's `deploy/`.
This service deliberately does **not** follow that shape, for two reasons:

1. `agile-board` is a **shared, multi-instance** repo. One instance's Deployment,
   Ingress and Secrets have no business living in it, and a future
   wizard-provisioned team board must be able to exist without touching the code
   repo at all.
2. The external-repo pattern requires adding the repo to `sourceRepos` in
   `bootstrap/platform-appproject.yaml`, which is **INSTALL-OWNED** and reaches
   the cluster only via `make bootstrap-reapply`. That is a known drift footgun;
   this service has no need to step in it.

Consequence to know about: there is **no CI auto-bump** of the image tag into
this repo (`main` is branch-protected). Rolling a new build is a deliberate PR
here that edits `deployment.yaml`'s tag.

## Why SealedSecret, not Vault

Every sibling platform service takes its CNPG role password from Vault via ESO
(`platform-services/db-tier/externalsecrets.yaml` → `secret/platform/db/cnpg/<svc>`).
This one uses SealedSecrets instead — for the DB password
(`platform-services/db-tier/sealedsecret-agile.yaml`) and for the app env
(`sealedsecret-env.yaml`).

**The honest reason:** writing production Vault values is classifier-gated to the
operator, and this service was provisioned by an agent. SealedSecret is the
established alternative on this platform for exactly this class of bootstrap
credential — the Dex client secret for *every* platform SSO client already lives
in one (`platform-services/dex/sealedsecret.yaml`), and this board's OIDC secret
had to go there regardless.

**Follow-up worth doing:** migrate the DB password to
`secret/platform/db/cnpg/agile` + an ESO `ExternalSecret` so it matches its
siblings, and the app env to `secret/platform/agile`. Both are drop-in
replacements — the Secret names (`cnpg-agile-app-credentials`, `agile-env`) and
keys stay identical, so only the producing manifest changes.

## The pieces

| File | What it is |
|---|---|
| `namespace.yaml` | ns `agile`, PSA `restricted` |
| `deployment.yaml` | the workload; **all instance identity is env here** |
| `service.yaml` / `ingress.yaml` | ClusterIP :80 → :8080; public host, no auth middleware (the app authenticates itself) |
| `netpol.yaml` | default-deny + DNS, db-tier:5432, :443 |
| `sealedsecret-env.yaml` | `agile-env`: OIDC client secret, session secret, DSN, webhook secret, GitHub App key |
| `sealedsecret-pull.yaml` | `harbor-pull` — `robot$platform+platform-pull` |

Outside this directory:

- `platform-services/cnpg/cluster/{databases,roles}.yaml` — db + role `agile` on `capstone-pg`
- `platform-services/db-tier/sealedsecret-agile.yaml` — that role's password
- `platform-services/db-tier/netpol.yaml` — ingress allow for ns `agile` → 5432
- `platform-services/dex/{configmap,deployment,sealedsecret}.yaml` — the `agile-board` static client

## Standing up another board

1. Onboard the team's GitHub team (the gate) and pick a host.
2. Add a Dex static client (`platform-services/dex/`): id, `secretEnv`, redirect
   `https://<host>/api/auth/callback`. **Dex has no wildcard redirects** and a
   ConfigMap change does not restart Dex — `kubectl -n dex rollout restart deploy/dex`.
3. Add a `Database` + `DatabaseRole` on `capstone-pg`, its password Secret, and a
   db-tier netpol ingress rule for the new namespace.
4. Copy this directory, changing only: namespace, host, `GITHUB_ORG`/`GITHUB_TEAM`/
   `REQUIRED_GROUP`/`GITHUB_REPOS`, `BOARD_TITLE`/`BOARD_ACCENT`, `APP_URL`,
   `OIDC_CLIENT_ID`, and the sealed values. **The image tag does not change.**

`APP_URL` and the Dex `redirectURI` must agree exactly; a mismatch fails sign-in
at the redirect with an opaque OIDC error rather than at startup.
