/*
 * sealCore — the SHARED implementation of the M3 secrets capability (ADR-029 §4/§6, reworked
 * for the ESO+Vault v1 model, ADR-030 B1).
 *
 * Both entry points call this ONE module, so there is a single write + authz path (never a
 * softer back-door):
 *   - the `capstone:seal-secret` scaffolder action (src/actions/sealSecret.ts), and
 *   - the `capstone-secrets` backend route POST /seal (src/service/router.ts) the frontend
 *     Secrets page posts to.
 *
 * sealAndPublish() does, in order: authorize `capstone.secret.seal` via the permission
 * framework (M2's policy decides) -> a belt-and-suspenders owner re-check (the actor's catalog
 * Groups must intersect the target Component's owner; `labmx` admin override) -> per env,
 * WRITE the value into Vault (KV-v2 at secret/data/tenants/<team>/<env>/app under the KEY, via
 * the VaultClient — the value never touches git) -> stage an `ExternalSecret` declaration (key
 * NAMES + remoteRef pointers ONLY, NO values) onto the team app repo's ONE rolling
 * pending-secrets branch/PR. This is the "no secret material in git" v1 contract.
 *
 * ROLLING PR (D-118): every secret change for a repo — every key, every env, both seals AND
 * deletes — batches into a SINGLE open pull request (`cfg.pendingBranch`, default
 * `secrets/pending`) instead of a new branch+PR per key per env. If that branch already has an
 * OPEN PR, the change is committed onto it and the SAME PR URL is returned (no new PR). Once
 * that PR merges (or is closed), the branch is stale — the next change resets it to the base tip
 * and opens a FRESH PR. See ensurePendingBranch / openOrReusePendingPr.
 *
 * SECURITY INVARIANTS (plan R2 / R1): the plaintext only ever reaches the Vault request body;
 * it never reaches a logger, a thrown error, or git (only the KEY + env); the flow fails
 * CLOSED on an authz miss OR an owner miss (no Vault write, no Octokit) — enforced HERE so the
 * action and the route share it.
 */
import type {
  AuthService,
  LoggerService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type { Config } from '@backstage/config';
import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  ANNOTATION_SOURCE_LOCATION,
  parseEntityRef,
  RELATION_OWNED_BY,
  stringifyEntityRef,
  type Entity,
} from '@backstage/catalog-model';
import { InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import { Octokit } from '@octokit/rest';
import { sealSecretPermission } from './permissions';
import { VaultClient, type VaultClientConfig } from './vaultClient';

/** The platform admin group ref (D-027) — kept in sync with M2's permissionPolicy.ts. */
export const ADMIN_GROUP_REF = 'group:default/labmx';

/** Services the seal core needs, injected by the action module + the backend plugin. */
export interface CapstoneSecretsDeps {
  config: Config;
  logger: LoggerService;
  catalog: CatalogService;
  permissions: PermissionsService;
  auth: AuthService;
}

export interface SealRequest {
  /** The actor's credentials (the action's initiator, or the route's authenticated user). */
  credentials: BackstageCredentials;
  entityRef: string;
  key: string;
  value: string;
  envs: string[];
}

export interface ListRequest {
  credentials: BackstageCredentials;
  entityRef: string;
}

export interface SecretSummary {
  key: string;
  env: string;
  lastUpdated?: string;
}

/** Request to list the projects (Components) the actor may manage secrets for. */
export interface ListProjectsRequest {
  credentials: BackstageCredentials;
}

/** A project the actor can manage secrets for (the access-scoped picker, secrets-UX v1). */
export interface ProjectSummary {
  entityRef: string;
  /** Display title (metadata.title || metadata.name). */
  title: string;
  /** The owning team slug (for display). */
  owner: string;
}

/** Request to delete (un-seal) a secret key from a Component's repo. */
export interface DeleteRequest {
  credentials: BackstageCredentials;
  entityRef: string;
  key: string;
}

/**
 * Resolved capstone.secrets.* config (ADR-030 B1). The Vault block (capstone.secrets.vault.*)
 * tells the VaultClient where + how to write the value; the rest govern the ExternalSecret
 * committed to the tenant repo. `secretStoreName`/`secretStoreKind`/`targetSecretName` MUST
 * match the per-tenant SecretStore the eso-vault/m4 contract renders
 * (external-secrets/secretstore-template.yaml: SecretStore `vault-tenant`, Secret `app-secrets`).
 */
interface SecretsConfig {
  defaultBranchPrefix: string;
  /**
   * The STABLE rolling branch name (per tenant repo) that ALL pending secret changes — every
   * key, every env, both seals and deletes — batch onto until its PR merges (D-118). Defaults to
   * `${defaultBranchPrefix}pending` (e.g. `secrets/pending`); configurable via
   * `capstone.secrets.pendingBranch`.
   */
  pendingBranch: string;
  /** Parent dir holding the per-env overlay dirs (dev/staging/prod). */
  overlaysDir: string;
  /**
   * The ExternalSecret file the M4 scaffolder ships INSIDE each overlay dir — the Secrets tab
   * UPSERTS data[] entries into THIS file (it is already a kustomization resource, so no
   * overlay edit + no kustomize load-restrictor escape). Per overlay:
   * `<overlaysDir>/<env>/<overlayEsFile>`.
   */
  overlayEsFile: string;
  /** Vault connection (the VaultClient writes the value here). */
  vault: VaultClientConfig;
}

function readSecretsConfig(config: Config): SecretsConfig {
  const c = config.getOptionalConfig('capstone.secrets');
  const v = c?.getOptionalConfig('vault');
  const defaultBranchPrefix =
    c?.getOptionalString('defaultBranchPrefix') ?? 'secrets/';
  return {
    defaultBranchPrefix,
    pendingBranch:
      c?.getOptionalString('pendingBranch') ?? `${defaultBranchPrefix}pending`,
    overlaysDir:
      c?.getOptionalString('overlaysDir') ?? '.devops/chart/overlays',
    overlayEsFile:
      c?.getOptionalString('overlayEsFile') ?? 'app-secret.externalsecret.yaml',
    vault: {
      addr:
        v?.getOptionalString('addr') ??
        'https://vault.vault.svc.cluster.local:8200',
      mount: v?.getOptionalString('mount') ?? 'secret',
      authMount: v?.getOptionalString('authMount') ?? 'kubernetes',
      role: v?.getOptionalString('role') ?? 'backstage-writer',
      // A projected SA token with audience=vault (NOT the default API-server-audience token):
      // the Vault role is bound to audience "vault", so a login with the DEFAULT token 403s
      // ("invalid audience"). The deploy mounts a serviceAccountToken projected volume
      // (audience: vault) at this path (eso-vault confirmed). See app-config.production.
      saTokenPath:
        v?.getOptionalString('saTokenPath') ??
        '/var/run/secrets/vault/vault-token',
      caPath:
        v?.getOptionalString('caPath') ??
        '/etc/backstage/vault-ca/ca.crt',
    },
  };
}

/** The Vault KV-v2 path that holds ALL of a tenant env's secret keys (one path per env). */
function vaultPathFor(teamSlug: string, env: string): string {
  return `tenants/${teamSlug}/${env}/app`;
}

/**
 * The path of the per-env overlay ExternalSecret the M4 scaffolder ships — the file the Secrets
 * tab upserts data[] entries into. It is ALREADY a kustomization resource in the overlay, so we
 * never touch kustomization.yaml and never escape the kustomize root (M4 contract / #106).
 */
function overlayEsPath(cfg: SecretsConfig, env: string): string {
  return `${cfg.overlaysDir}/${env}/${cfg.overlayEsFile}`;
}

/**
 * Parse the secret KEY NAMES (the `secretKey:` of each data entry) out of an ExternalSecret
 * manifest. Best-effort line scan (no full YAML parse needed) — drives List + the idempotent
 * upsert/remove. We key off `secretKey` (the k8s Secret data key the user references), not
 * `property`, since that is what the user types and what the workload consumes.
 */
function parseEsDataKeys(yaml: string): string[] {
  const keys: string[] = [];
  for (const line of yaml.split('\n')) {
    const m = line.match(/^\s*-\s*secretKey:\s*["']?([^"'\s]+)["']?\s*$/);
    if (m) {
      keys.push(m[1]);
    }
  }
  return keys;
}

/**
 * Read the Vault `remoteRef.key` already used by the shipped ExternalSecret (the per-env Vault
 * object all the env's keys share). We REUSE the rendered value verbatim rather than
 * reconstructing it, so the Secrets tab always writes to exactly the path the scaffolder
 * declared. Falls back to the conventional tenants/<team>/<env>/app if the file has none yet.
 */
function esVaultKey(yaml: string, teamSlug: string, env: string): string {
  const m = yaml.match(/^\s*key:\s*["']?([^"'\s]+)["']?\s*$/m);
  return m ? m[1] : vaultPathFor(teamSlug, env);
}

/** The indent (in spaces) of the first `- secretKey:` entry, so inserts match the file's style. */
function dataEntryIndent(yaml: string): string {
  const m = yaml.match(/^(\s*)-\s*secretKey:/m);
  return m ? m[1] : '    ';
}

/**
 * Idempotently UPSERT a data[] entry for `key` into the existing overlay ExternalSecret,
 * preserving every other entry, comment, and the document shape. If `key` already has an entry
 * it is left as-is (the remoteRef is stable; only the Vault VALUE changes, which is not in git).
 * The new entry is inserted right after the `data:` line, matching the file's indent + the
 * existing entries' `remoteRef.key`. JSON.stringify the key so it can't break the YAML.
 */
function upsertEsDataEntry(
  yaml: string,
  key: string,
  vaultKey: string,
): string {
  if (parseEsDataKeys(yaml).includes(key)) {
    return yaml; // already declared — nothing to change in git
  }
  const indent = dataEntryIndent(yaml);
  const childIndent = `${indent}  `;
  const entry = [
    `${indent}- secretKey: ${JSON.stringify(key)}`,
    `${childIndent}remoteRef:`,
    `${childIndent}  key: ${JSON.stringify(vaultKey)}`,
    `${childIndent}  property: ${JSON.stringify(key)}`,
  ].join('\n');

  const lines = yaml.split('\n');
  const dataIdx = lines.findIndex(l => /^\s*data:\s*$/.test(l));
  if (dataIdx === -1) {
    // No data: block (unexpected for a shipped ES) — append one at the end.
    return `${yaml.replace(/\n*$/, '')}\n  data:\n${entry}\n`;
  }
  lines.splice(dataIdx + 1, 0, entry);
  return lines.join('\n');
}

/**
 * Remove the data[] entry for `key` from the overlay ExternalSecret (the inverse of the upsert).
 * Drops the `- secretKey: <key>` line and its indented child block (remoteRef + key + property)
 * up to the next sibling entry / dedent. No-op if the key is absent. Never deletes the file.
 */
function removeEsDataEntry(yaml: string, key: string): string {
  const lines = yaml.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s*secretKey:\s*["']?([^"'\s]+)["']?\s*$/);
    if (m && m[2] === key) {
      const entryIndent = m[1].length;
      // Skip this line + all deeper-indented child lines (the entry's body).
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() === '') {
          i++;
          continue;
        }
        const indent = (next.match(/^(\s*)/)?.[1].length) ?? 0;
        if (indent <= entryIndent) {
          break;
        }
        i++;
      }
      i--; // the for-loop will ++ past the sibling/dedent line we stopped on
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** Parse "https://github.com/OWNER/REPO[/tree/...]" (the source-location target) -> {owner,repo}. */
function parseGithubRepo(sourceLocation: string): {
  owner: string;
  repo: string;
} {
  // source-location targets look like "url:https://github.com/UA-MIS/my-app/tree/main/".
  const cleaned = sourceLocation.replace(/^url:/, '').replace(/\/+$/, '');
  const m = cleaned.match(
    /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/.*)?$/,
  );
  if (!m) {
    throw new InputError(
      `Target Component source-location is not a recognizable GitHub repo URL: ${cleaned}`,
    );
  }
  return { owner: m[1], repo: m[2] };
}

/**
 * Derive the actor's ownership refs (their User ref + each team Group ref). Uses the catalog
 * to resolve the user's group memberships — mirrors how M2's policy obtains
 * ownershipEntityRefs, so the belt-and-suspenders check matches the policy decision.
 *
 * `spec.members` matching (belt to `relations.hasMember`'s suspenders, robust to relation-
 * stitching lag — see authOidcProcess.ts's F1): the GitHub-org provider writes this RAW field
 * as `<namespace>/<login>` (e.g. "default/ccsmith33"), NOT a bare login and NOT a full
 * "user:<namespace>/<login>" ref (confirmed against the live catalog — a prior version of this
 * check only matched the bare-login form and so never actually matched anything; it was
 * silently riding on `relations.hasMember` alone). Match all three shapes so a future change to
 * the provider's raw format can't silently turn this fallback back into dead code.
 */
async function resolveActorOwnership(
  deps: CapstoneSecretsDeps,
  serviceCreds: Awaited<ReturnType<AuthService['getOwnServiceCredentials']>>,
  userEntityRef: string,
): Promise<string[]> {
  const refs = new Set<string>([userEntityRef]);
  const { namespace, name } = parseEntityRef(userEntityRef);
  const { items } = await deps.catalog.getEntities(
    {
      filter: [
        { kind: 'Group', 'relations.hasMember': userEntityRef },
        { kind: 'Group', 'spec.members': `${namespace}/${name}` },
        { kind: 'Group', 'spec.members': name },
        { kind: 'Group', 'spec.members': userEntityRef },
      ],
      fields: ['kind', 'metadata.name', 'metadata.namespace'],
    },
    { credentials: serviceCreds },
  );
  for (const g of items) {
    refs.add(stringifyEntityRef(g));
  }
  return Array.from(refs);
}

/** The owner refs of a Component: spec.owner + ownedBy relations, normalized to entity refs. */
function entityOwnerRefs(entity: Entity): string[] {
  const refs = new Set<string>();
  const owner = (entity.spec as { owner?: unknown } | undefined)?.owner;
  if (typeof owner === 'string') {
    refs.add(
      owner.includes(':')
        ? stringifyEntityRef(parseEntityRef(owner))
        : stringifyEntityRef({
            kind: 'Group',
            namespace: 'default',
            name: owner,
          }),
    );
  }
  for (const rel of entity.relations ?? []) {
    if (rel.type === RELATION_OWNED_BY) {
      refs.add(rel.targetRef);
    }
  }
  return Array.from(refs);
}

/** Extract the actor's user entity ref from credentials; throws if not an authenticated user. */
function requireUserRef(credentials: BackstageCredentials): string {
  const userRef = (
    credentials.principal as { userEntityRef?: string } | undefined
  )?.userEntityRef;
  if (!userRef) {
    throw new NotAllowedError(
      'Sealing requires an authenticated user identity (no service-to-service sealing).',
    );
  }
  return userRef;
}

/**
 * Authorize + resolve the target: runs the permission-framework check AND the belt-and-
 * suspenders owner re-check (admin override). Shared by seal + list so BOTH fail closed
 * identically. Returns the resolved target entity, its owner refs, and the team slug.
 */
async function authorizeAndResolveTarget(
  deps: CapstoneSecretsDeps,
  credentials: BackstageCredentials,
  entityRef: string,
): Promise<{ target: Entity; ownerRefs: string[]; teamSlug: string }> {
  // 1. Permission framework (M2's policy decides capstone.secret.seal).
  const decision = (
    await deps.permissions.authorize([{ permission: sealSecretPermission }], {
      credentials,
    })
  )[0];
  if (decision.result !== AuthorizeResult.ALLOW) {
    throw new NotAllowedError(
      'You are not permitted to seal secrets for this team (capstone.secret.seal).',
    );
  }

  // 2. Resolve the target Component + its owner.
  const serviceCreds = await deps.auth.getOwnServiceCredentials();
  const target = await deps.catalog.getEntityByRef(entityRef, {
    credentials: serviceCreds,
  });
  if (!target) {
    throw new NotFoundError(
      `Target Component not found in the catalog: ${entityRef}`,
    );
  }
  const ownerRefs = entityOwnerRefs(target);

  // 3. Belt-and-suspenders owner re-check (fails CLOSED, plan §2.3 / R1).
  const actorUserRef = requireUserRef(credentials);
  const actorOwnership = await resolveActorOwnership(
    deps,
    serviceCreds,
    actorUserRef,
  );
  const isAdmin = actorOwnership.includes(ADMIN_GROUP_REF);
  const intersects = ownerRefs.some(o => actorOwnership.includes(o));
  if (!isAdmin && !intersects) {
    throw new NotAllowedError(
      `You do not own ${entityRef}; sealing is restricted to the owning team.`,
    );
  }

  const teamSlug = parseEntityRef(
    ownerRefs.find(r => r.startsWith('group:')) ?? ownerRefs[0] ?? entityRef,
  ).name;
  return { target, ownerRefs, teamSlug };
}

/** Build an Octokit for a repo from the GitHub APP credentials via integrations (no PAT). */
async function octokitForRepo(
  config: Config,
  owner: string,
  repo: string,
): Promise<Octokit> {
  const integrations = ScmIntegrations.fromConfig(config);
  const ghCredentials =
    DefaultGithubCredentialsProvider.fromIntegrations(integrations);
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const { token } = await ghCredentials.getCredentials({ url: repoUrl });
  if (!token) {
    throw new Error(
      `No GitHub credentials resolved for ${repoUrl}; check integrations.github.`,
    );
  }
  return new Octokit({ auth: token });
}

/** The team app repo {owner,repo} from the Component's source-location annotation. */
function repoForTarget(target: Entity): { owner: string; repo: string } {
  const sourceLocation =
    target.metadata.annotations?.[ANNOTATION_SOURCE_LOCATION];
  if (!sourceLocation) {
    throw new InputError(
      `Target Component ${stringifyEntityRef(target)} has no ${ANNOTATION_SOURCE_LOCATION} ` +
        `annotation; cannot determine which repo to use.`,
    );
  }
  return parseGithubRepo(sourceLocation);
}

/**
 * Rolling pending-secrets PR title/body (D-118) — the ONE PR per tenant repo that ALL secret
 * changes (every key, every env, both seals and deletes) batch onto until it merges.
 */
const PENDING_PR_TITLE = 'chore(secrets): pending secret changes';
const PENDING_PR_BODY = [
  'Batches ALL pending secret changes for this repo into a single rolling PR — every key,',
  'every environment, both sets and deletes land here until this PR merges. See the commit',
  'history on this branch for the individual key/env changes that make up this PR.',
  '',
  '**Write-only:** secret values are written straight to Vault and never appear in this PR —',
  'only key-name + Vault-pointer entries in the overlay `ExternalSecret`(s).',
  '',
  'On merge: ArgoCD applies the ExternalSecret(s) -> the External Secrets Operator reads the',
  "value(s) from Vault -> materializes/updates the target namespace's Kubernetes Secret(s) ->",
  'your workload(s) can consume them. The next secret change opens a FRESH pending PR.',
].join('\n');

/**
 * Find the OPEN pull request (if any) for the rolling pending-secrets branch. undefined means
 * either the branch doesn't exist yet, or it exists but its previous PR already merged/closed
 * (the "stale branch" case — see ensurePendingBranch).
 */
async function findOpenPendingPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | undefined> {
  const { data: prs } = await octokit.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${branch}`,
  });
  return prs[0]?.html_url;
}

/**
 * The most recently updated CLOSED pull request (if any) for the rolling pending-secrets branch,
 * with enough to tell merged from closed-without-merging. Used only when we're about to reset a
 * stale branch, to warn if that reset is discarding work that was never shipped (D-118 review
 * follow-up, PR #500 point 2/3).
 */
async function findLastClosedPendingPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ number: number; merged: boolean } | undefined> {
  const { data: prs } = await octokit.pulls.list({
    owner,
    repo,
    state: 'closed',
    head: `${owner}:${branch}`,
    sort: 'updated',
    direction: 'desc',
    per_page: 1,
  });
  const pr = prs[0];
  // The list endpoint returns `merged_at` (nullable), not a `merged` boolean (that's only on the
  // single-PR get response) — a non-null merge timestamp is exactly "was merged".
  return pr ? { number: pr.number, merged: pr.merged_at !== null } : undefined;
}

/**
 * Ensure the repo's ONE rolling pending-secrets branch is ready to receive commits (D-118):
 *  - an OPEN PR already references it -> reuse as-is (new commits stack on top of it),
 *  - the branch exists and is already AT the base tip -> nothing to reset, no-op (there is
 *    nothing on it that a reset could discard),
 *  - the branch exists with commits ahead of base and has NO open PR -> re-check for an open PR
 *    ONE more time (shrinks the window where a concurrent writer just committed + is about to
 *    open its PR) before concluding it's genuinely stale; if it's stale, WARN when the branch's
 *    most recent PR was closed WITHOUT merging (that reset silently drops whatever secret keys
 *    rode on it — see the review) before force-resetting to the base tip,
 *  - the branch doesn't exist yet -> create it fresh from the current base tip.
 * A 422 on the create call is treated as a concurrent request having just done the same thing
 * (race-safe): re-check for the PR it's likely about to open rather than failing.
 *
 * NOTE: the GitHub refs API has no true compare-and-swap for `updateRef` (no "only if current sha
 * is still X"), so the re-check above narrows the race window but cannot fully close it — a
 * writer whose commit lands in the instant between our re-check and the `updateRef` call can
 * still be discarded. See PR #500 review point 2/3 sub-question; a full fix needs either GitHub
 * adding ref CAS or this moving to a lock (out of scope here).
 */
async function ensurePendingBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  branch: string,
  logger: LoggerService,
): Promise<{ existingPrUrl?: string }> {
  const existingPrUrl = await findOpenPendingPr(octokit, owner, repo, branch);
  if (existingPrUrl) {
    return { existingPrUrl };
  }

  let currentSha: string | undefined;
  try {
    const { data } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    currentSha = data.object.sha;
  } catch (e) {
    if ((e as { status?: number }).status !== 404) {
      throw e;
    }
  }

  if (currentSha === undefined) {
    // Branch doesn't exist yet -> create fresh from the base tip.
    try {
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: baseSha,
      });
    } catch (e) {
      // Race: a concurrent request created it between our getRef 404 and this createRef. It's
      // most likely about to (or already did) open a PR on it too — reuse that if so.
      if ((e as { status?: number }).status !== 422) {
        throw e;
      }
      const raced = await findOpenPendingPr(octokit, owner, repo, branch);
      if (raced) {
        return { existingPrUrl: raced };
      }
    }
  } else if (currentSha === baseSha) {
    // Already at the base tip — nothing on it, nothing to reset, nothing anyone could lose.
  } else {
    // Has commits ahead of base but no open PR. Re-check once more (shrinks — doesn't eliminate —
    // the race where a concurrent writer just committed and hasn't opened its PR yet).
    const raced = await findOpenPendingPr(octokit, owner, repo, branch);
    if (raced) {
      return { existingPrUrl: raced };
    }
    const lastClosed = await findLastClosedPendingPr(octokit, owner, repo, branch);
    if (lastClosed && !lastClosed.merged) {
      logger.warn(
        `capstone secrets: resetting the rolling branch "${branch}" for ${owner}/${repo}, but ` +
          `its most recent PR (#${lastClosed.number}) was CLOSED WITHOUT MERGING. Any secret ` +
          `key(s) sealed as part of that PR remain live in Vault but now have NO ExternalSecret ` +
          `declaring them in git — they will not be applied to the cluster unless re-sealed. ` +
          `(D-118 known tradeoff — see PR #500 review point 2/3.)`,
      );
    }
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: baseSha,
      force: true,
    });
  }
  return {};
}

/**
 * Open the rolling pending-secrets PR if none is open yet, else return the URL of the one
 * already open (reused — no new PR). Race-safe: a 422 on create (a concurrent request opened it
 * first) falls back to re-reading the now-open PR.
 */
async function openOrReusePendingPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseBranch: string,
  branch: string,
  existingPrUrl: string | undefined,
): Promise<string> {
  if (existingPrUrl) {
    return existingPrUrl;
  }
  try {
    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      base: baseBranch,
      head: branch,
      title: PENDING_PR_TITLE,
      body: PENDING_PR_BODY,
    });
    return pr.html_url;
  } catch (e) {
    if ((e as { status?: number }).status === 422) {
      const raced = await findOpenPendingPr(octokit, owner, repo, branch);
      if (raced) {
        return raced;
      }
    }
    throw e;
  }
}

/**
 * Set a secret for each env: WRITE the value into Vault (KV-v2, per-env path) and stage a data[]
 * UPSERT (key NAME + Vault pointer, NO value) into the overlay ExternalSecret the M4 scaffolder
 * ships (already a kustomization resource — no overlay edit, no kustomize load-restrictor
 * escape; M4 contract / #106) onto the repo's ONE rolling pending-secrets branch/PR (D-118).
 * Returns the (re)used PR URL as a single-element array (kept as an array for API-shape
 * compatibility with existing callers). ENFORCES the same authz + owner re-check + fail-closed
 * as everywhere (via authorizeAndResolveTarget). The value reaches ONLY the Vault request body —
 * never git, never a log, never a thrown error.
 */
export async function sealAndPublish(
  deps: CapstoneSecretsDeps,
  request: SealRequest,
): Promise<{ pullRequestUrls: string[] }> {
  const { credentials, entityRef, key, value, envs } = request;
  const cfg = readSecretsConfig(deps.config);

  // NEVER log the value — only the key + envs + target.
  deps.logger.info(
    `capstone set-secret requested for key="${key}" envs=[${envs.join(
      ',',
    )}] target=${entityRef}`,
  );

  const { target, teamSlug } = await authorizeAndResolveTarget(
    deps,
    credentials,
    entityRef,
  );

  const { owner, repo } = repoForTarget(target);
  const octokit = await octokitForRepo(deps.config, owner, repo);
  const vault = new VaultClient(cfg.vault);

  const { data: repoInfo } = await octokit.repos.get({ owner, repo });
  const baseBranch = repoInfo.default_branch;
  const { data: baseRef } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });
  const baseSha = baseRef.object.sha;

  // 1) Validate + resolve each env's Vault pointer from the BASE branch FIRST (fail closed
  //    before any Vault write or git side effect if some env isn't an M4 tenant overlay).
  const vaultKeyByEnv: Record<string, string> = {};
  const baseContentByEnv: Record<string, string> = {};
  for (const env of envs) {
    const esPath = overlayEsPath(cfg, env);
    const existing = await getFileContent(octokit, owner, repo, baseBranch, esPath);
    if (existing === undefined) {
      throw new NotFoundError(
        `Expected the scaffolded ExternalSecret at ${esPath} in ${entityRef}; not found. ` +
          `Only apps scaffolded with the capstone template (M4) support the Secrets tab.`,
      );
    }
    vaultKeyByEnv[env] = esVaultKey(existing, teamSlug, env);
    baseContentByEnv[env] = existing;
  }

  // 2) WRITE the value into Vault for every env (the only place the plaintext lands).
  //    Idempotent set/rotate of one key at each per-env path; sibling keys are preserved.
  for (const env of envs) {
    await vault.setKey(vaultKeyByEnv[env], key, value);
  }

  // 3) Ensure the repo's ONE rolling pending-secrets branch (reuse if an open PR already covers
  //    it, reset-to-base if stale, or create fresh) — batches with any other pending change.
  const branch = cfg.pendingBranch;
  const { existingPrUrl } = await ensurePendingBranch(
    octokit,
    owner,
    repo,
    baseSha,
    branch,
    deps.logger,
  );

  // 4) Upsert the data[] entry per env directly on the rolling branch via a compare-and-swap
  //    write (casUpdateFile, D-118 review follow-up): each write re-reads the file's CURRENT
  //    content + sha and re-applies the upsert fresh, retrying on a 409 conflict — never
  //    overwrites a concurrent writer's change with a payload computed from a stale read.
  let anyWrite = false;
  for (const env of envs) {
    const esPath = overlayEsPath(cfg, env);
    const wrote = await casUpdateFile(
      octokit,
      owner,
      repo,
      branch,
      esPath,
      baseContentByEnv[env],
      content => upsertEsDataEntry(content, key, vaultKeyByEnv[env]),
      `chore(secrets): declare ${key} for ${env}`,
    );
    anyWrite = anyWrite || wrote;
  }

  // 5) Only open/reuse a PR if there's something to publish. A pure Vault rotation (the
  //    declaration is already correct — nothing changed on the branch) must NOT attempt to open
  //    a PR when none is open yet: GitHub rejects a PR with zero commits between head and base
  //    ("No commits between X and Y" — reproduced against a real repo, see PR #500 review Finding
  //    A). The Vault write above already landed either way.
  if (!existingPrUrl && !anyWrite) {
    deps.logger.info(
      `capstone set-secret rotated key="${key}" envs=[${envs.join(',')}] target=${entityRef} ` +
        `(Vault only — no pending git change, no PR opened)`,
    );
    return { pullRequestUrls: [] };
  }

  const prUrl = await openOrReusePendingPr(
    octokit,
    owner,
    repo,
    baseBranch,
    branch,
    existingPrUrl,
  );
  deps.logger.info(
    `capstone set-secret staged key="${key}" envs=[${envs.join(',')}] on ${branch}: ${prUrl}`,
  );

  return { pullRequestUrls: [prUrl] };
}

/**
 * List existing sealed secrets for a Component's repo — key NAMES + env + last-updated ONLY,
 * read from filenames + commit dates. NEVER decrypts, NEVER returns values (write-only). Same
 * authz + owner re-check as sealing (you can only list what you could seal). Returns [] for a
 * repo with no secrets dir yet.
 */
export async function listSecrets(
  deps: CapstoneSecretsDeps,
  request: ListRequest,
): Promise<SecretSummary[]> {
  const { credentials, entityRef } = request;
  const cfg = readSecretsConfig(deps.config);

  const { target } = await authorizeAndResolveTarget(
    deps,
    credentials,
    entityRef,
  );
  const { owner, repo } = repoForTarget(target);
  const octokit = await octokitForRepo(deps.config, owner, repo);

  // Read the per-env overlay ExternalSecret the scaffolder ships. Each declares its KEY NAMES as
  // the `secretKey:` of its data entries — we report those (NAMES only, never values; we never
  // read Vault here). Each key's last-updated is that file's last commit date.
  const summaries: SecretSummary[] = [];
  for (const env of ['dev', 'staging', 'prod']) {
    const esPath = overlayEsPath(cfg, env);
    const text = await getFileContent(octokit, owner, repo, undefined, esPath);
    if (!text) {
      continue; // no overlay for this env -> nothing declared
    }
    const keys = parseEsDataKeys(text);
    if (keys.length === 0) {
      continue;
    }
    let lastUpdated: string | undefined;
    try {
      const { data: commits } = await octokit.repos.listCommits({
        owner,
        repo,
        path: esPath,
        per_page: 1,
      });
      lastUpdated = commits[0]?.commit?.committer?.date ?? undefined;
    } catch {
      // best-effort; leave lastUpdated undefined
    }
    for (const key of keys) {
      summaries.push({ key, env, lastUpdated });
    }
  }
  return summaries;
}

/**
 * Read a file's UTF-8 content + git blob sha from a branch (or the default branch when `branch`
 * is undefined). Returns undefined for a 404 (file absent). The sha is what callers must supply
 * back to createOrUpdateFileContents to avoid clobbering a concurrent write (see casUpdateFile).
 */
async function readFileWithSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string | undefined,
  path: string,
): Promise<{ content: string; sha: string } | undefined> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ...(branch ? { ref: branch } : {}),
    });
    if (!Array.isArray(data) && 'content' in data && data.content) {
      return {
        content: Buffer.from(data.content, 'base64').toString('utf8'),
        sha: 'sha' in data ? (data.sha as string) : '',
      };
    }
    return undefined;
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      return undefined;
    }
    throw e;
  }
}

/**
 * Read a file's UTF-8 content from a branch (content only — see readFileWithSha for +sha). Used
 * to merge into an existing ExternalSecret and to read its declared key names for List.
 */
async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string | undefined,
  path: string,
): Promise<string | undefined> {
  const f = await readFileWithSha(octokit, owner, repo, branch, path);
  return f?.content;
}

/**
 * Compare-and-swap write onto a branch (D-118 review follow-up, PR #500): read the file's
 * CURRENT content + sha, apply `mutate` to THAT content, and write using that sha. Passing a
 * payload precomputed from an earlier read (the old approach) can silently clobber a concurrent
 * writer's change — the sha refetch alone only prevents a 409 *error*, it does not protect the
 * *content* being written. This always derives the write from what is actually on the branch
 * right now. On a 409 (someone else wrote first since our read), re-read + re-apply `mutate` +
 * retry, bounded by `maxAttempts` — a genuine race storm fails loud (throws) rather than silently
 * dropping a write. Returns whether a write actually happened (false = `mutate` was a no-op,
 * nothing to commit — callers use this to avoid opening a PR with zero diff).
 */
async function casUpdateFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  fallbackContent: string,
  mutate: (content: string) => string,
  message: string,
  maxAttempts = 5,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await readFileWithSha(octokit, owner, repo, branch, path);
    const content = current?.content ?? fallbackContent;
    const updated = mutate(content);
    if (updated === content) {
      return false; // nothing to write
    }
    try {
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        branch,
        path,
        message,
        content: Buffer.from(updated, 'utf8').toString('base64'),
        sha: current?.sha,
      });
      return true;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409 && attempt < maxAttempts) {
        continue; // someone else wrote first — re-read, re-merge, retry with fresh content+sha
      }
      throw e;
    }
  }
  /* istanbul ignore next -- the loop above always returns or throws; keeps TS's control-flow
   * analysis happy without a non-null assertion. */
  throw new Error(
    `capstone secrets: giving up on ${path} after ${maxAttempts} conflicting writes`,
  );
}

/**
 * List the projects (Components) the signed-in actor may manage secrets for (secrets-UX v1,
 * the access-scoped picker). Access scoping is IDENTICAL to the per-Component seal gate: a
 * Component is included iff the actor's catalog Groups intersect its owner — or the actor is
 * the `labmx` admin, who sees ALL Components. So the picker shows exactly the projects the
 * actor could seal into (no more, no less), reusing resolveActorOwnership + entityOwnerRefs.
 */
export async function listMyProjects(
  deps: CapstoneSecretsDeps,
  request: ListProjectsRequest,
): Promise<ProjectSummary[]> {
  const { credentials } = request;

  // Authenticated user only (no service principal) — same as seal.
  const actorUserRef = requireUserRef(credentials);
  const serviceCreds = await deps.auth.getOwnServiceCredentials();
  const actorOwnership = await resolveActorOwnership(
    deps,
    serviceCreds,
    actorUserRef,
  );
  const isAdmin = actorOwnership.includes(ADMIN_GROUP_REF);

  const { items } = await deps.catalog.getEntities(
    {
      filter: [{ kind: 'Component' }],
      fields: [
        'kind',
        'metadata.name',
        'metadata.namespace',
        'metadata.title',
        'spec.owner',
        'relations',
      ],
    },
    { credentials: serviceCreds },
  );

  const projects: ProjectSummary[] = [];
  for (const entity of items) {
    const ownerRefs = entityOwnerRefs(entity);
    const owned = ownerRefs.some(o => actorOwnership.includes(o));
    if (!isAdmin && !owned) {
      continue;
    }
    const ownerSlug = parseEntityRef(
      ownerRefs.find(r => r.startsWith('group:')) ?? ownerRefs[0] ?? '',
    ).name;
    projects.push({
      entityRef: stringifyEntityRef(entity),
      title: (entity.metadata.title as string | undefined) ?? entity.metadata.name,
      owner: ownerSlug,
    });
  }
  // Stable, human-friendly ordering.
  projects.sort((a, b) => a.title.localeCompare(b.title));
  return projects;
}

/**
 * Delete a secret key from a Component via the repo's ONE rolling pending-secrets PR (D-118) —
 * the inverse of sealAndPublish, batched the SAME way (every key, every env, both seals and
 * deletes share one branch/PR until it merges). Removes the Vault key (KV-v2 merge-patch null at
 * each env path where it was declared) AND drops its data[] entry from each overlay
 * ExternalSecret. The ES FILE is never deleted (it ships with the demo `app-secret` entry +
 * drives zero-config), only the one entry is removed. ENFORCES the same capstone.secret.seal
 * authz + owner re-check + fail-closed as seal (you can only delete what you could seal).
 * PR-by-default for the git side — the Vault value is removed IMMEDIATELY.
 */
export async function deleteSecret(
  deps: CapstoneSecretsDeps,
  request: DeleteRequest,
): Promise<{ pullRequestUrl: string }> {
  const { credentials, entityRef, key } = request;
  const cfg = readSecretsConfig(deps.config);

  deps.logger.info(
    `capstone delete-secret requested for key="${key}" target=${entityRef}`,
  );

  const { target, teamSlug } = await authorizeAndResolveTarget(
    deps,
    credentials,
    entityRef,
  );
  const { owner, repo } = repoForTarget(target);
  const octokit = await octokitForRepo(deps.config, owner, repo);
  const vault = new VaultClient(cfg.vault);

  const { data: repoInfo } = await octokit.repos.get({ owner, repo });
  const baseBranch = repoInfo.default_branch;
  const { data: baseRef } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });
  const baseSha = baseRef.object.sha;

  // 1) Find every env whose overlay ExternalSecret (on the BASE branch) declares this key — a
  //    read-only check first, so a not-found delete never touches git (no branch created/reset).
  const envEntries: Array<{ env: string; esPath: string; existing: string }> = [];
  for (const env of ['dev', 'staging', 'prod']) {
    const esPath = overlayEsPath(cfg, env);
    const existing = await getFileContent(octokit, owner, repo, baseBranch, esPath);
    if (existing && parseEsDataKeys(existing).includes(key)) {
      envEntries.push({ env, esPath, existing });
    }
  }
  if (envEntries.length === 0) {
    throw new NotFoundError(
      `No secret "${key}" found for ${entityRef} (nothing to delete).`,
    );
  }

  // 2) Ensure the repo's ONE rolling pending-secrets branch (same batching as sealAndPublish).
  const branch = cfg.pendingBranch;
  const { existingPrUrl } = await ensurePendingBranch(
    octokit,
    owner,
    repo,
    baseSha,
    branch,
    deps.logger,
  );

  // 3) Remove the value from Vault immediately (the per-env Vault pointer is the same one the
  //    shipped app-secret entry uses, so the BASE read from step 1 is sufficient — it doesn't
  //    depend on what else is pending on the rolling branch) + drop the data[] entry via a
  //    compare-and-swap write (casUpdateFile, D-118 review follow-up): each write re-reads the
  //    file's CURRENT content + sha and re-applies the removal fresh, retrying on a 409 conflict
  //    — never overwrites a concurrent writer's change with a payload computed from a stale read.
  let anyWrite = false;
  for (const { env, esPath, existing } of envEntries) {
    const vaultKey = esVaultKey(existing, teamSlug, env);
    await vault.deleteKey(vaultKey, key);

    const wrote = await casUpdateFile(
      octokit,
      owner,
      repo,
      branch,
      esPath,
      existing,
      content => removeEsDataEntry(content, key),
      `chore(secrets): remove ${key} for ${env}`,
    );
    anyWrite = anyWrite || wrote;
  }

  // 4) Only open/reuse a PR if there's something to publish (mirrors sealAndPublish — see PR #500
  //    review Finding A). This is normally unreachable for delete (envEntries is non-empty, so a
  //    fresh/reset branch mirroring base always has a real diff to remove) except when a
  //    concurrent pending change already removed the same key first.
  if (!existingPrUrl && !anyWrite) {
    deps.logger.info(
      `capstone delete-secret removed key="${key}" target=${entityRef} ` +
        `(Vault only — no pending git change, no PR opened)`,
    );
    return { pullRequestUrl: '' };
  }

  const prUrl = await openOrReusePendingPr(
    octokit,
    owner,
    repo,
    baseBranch,
    branch,
    existingPrUrl,
  );
  deps.logger.info(
    `capstone delete-secret staged key="${key}" on ${branch}: ${prUrl}`,
  );
  return { pullRequestUrl: prUrl };
}
