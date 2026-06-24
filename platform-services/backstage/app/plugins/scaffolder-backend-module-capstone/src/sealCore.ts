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
 * the VaultClient — the value never touches git) -> open a PR to the team app repo committing
 * an `ExternalSecret` declaration (key NAMES + remoteRef pointers ONLY, NO values; + append it
 * to the env overlay kustomization). This is the "no secret material in git" v1 contract.
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
  return {
    defaultBranchPrefix:
      c?.getOptionalString('defaultBranchPrefix') ?? 'secrets/',
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
      role: v?.getOptionalString('role') ?? 'backstage-secrets',
      // A projected SA token with audience=vault (NOT the default API-server-audience token):
      // the Vault role is bound to audience "vault", so a login with the DEFAULT token 403s
      // ("invalid audience"). The deploy mounts a serviceAccountToken projected volume
      // (audience: vault) at this path (eso-vault confirmed). See app-config.production.
      saTokenPath:
        v?.getOptionalString('saTokenPath') ??
        '/var/run/secrets/vault/token',
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

/** k8s/RFC-1123 name from a secret key (lowercase, non-alnum -> '-', trimmed). */
function toResourceName(key: string): string {
  const name = key
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!name) {
    throw new InputError(
      `Secret key ${JSON.stringify(key)} has no usable characters for a Kubernetes name.`,
    );
  }
  return name;
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
 */
async function resolveActorOwnership(
  deps: CapstoneSecretsDeps,
  serviceCreds: Awaited<ReturnType<AuthService['getOwnServiceCredentials']>>,
  userEntityRef: string,
): Promise<string[]> {
  const refs = new Set<string>([userEntityRef]);
  const { items } = await deps.catalog.getEntities(
    {
      filter: [
        { kind: 'Group', 'relations.hasMember': userEntityRef },
        { kind: 'Group', 'spec.members': parseEntityRef(userEntityRef).name },
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
 * Set a secret for each env: WRITE the value into Vault (KV-v2, per-env path) and open a PR per
 * env that UPSERTS a data[] entry (key NAME + Vault pointer, NO value) into the overlay
 * ExternalSecret the M4 scaffolder ships (already a kustomization resource — no overlay edit,
 * no kustomize load-restrictor escape; M4 contract / #106). Returns the PR URLs. ENFORCES the
 * same authz + owner re-check + fail-closed as everywhere (via authorizeAndResolveTarget). The
 * value reaches ONLY the Vault request body — never git, never a log, never a thrown error.
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

  const pullRequestUrls: string[] = [];

  for (const env of envs) {
    const namespace = `${teamSlug}-${env}`;
    const esPath = overlayEsPath(cfg, env);

    // The overlay ExternalSecret MUST already exist (the scaffolder ships it). Read it first so
    // we (a) reuse its exact Vault remoteRef.key and (b) fail closed if the repo isn't an M4
    // tenant repo, rather than writing a value to Vault we can't declare in git.
    const existing = await getFileContent(octokit, owner, repo, baseBranch, esPath);
    if (existing === undefined) {
      throw new NotFoundError(
        `Expected the scaffolded ExternalSecret at ${esPath} in ${entityRef}; not found. ` +
          `Only apps scaffolded with the capstone template (M4) support the Secrets tab.`,
      );
    }
    const vaultKey = esVaultKey(existing, teamSlug, env);

    // 1) WRITE the value into Vault (the only place the plaintext lands). Idempotent set/rotate
    //    of one key at the per-env path; the other keys at that path are preserved.
    await vault.setKey(vaultKey, key, value);

    // 2) Upsert the data[] entry (names only) into the overlay ES via a PR.
    const branch = `${cfg.defaultBranchPrefix}${toResourceName(key)}-${env}-${Date.now()}`;
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });

    const updated = upsertEsDataEntry(existing, key, vaultKey);
    if (updated !== existing) {
      await putFile(
        octokit,
        owner,
        repo,
        branch,
        esPath,
        updated,
        `chore(secrets): declare ${key} for ${env}`,
      );
    }

    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      base: baseBranch,
      head: branch,
      title: `chore(secrets): set ${key} for ${env}`,
      body: [
        `Declares the secret \`${key}\` for environment \`${env}\` (namespace \`${namespace}\`).`,
        '',
        '**Write-only:** the value was written to Vault and cannot be read back here. To change',
        'this secret, set it again. This PR adds **no secret material** — only a key-name +',
        'Vault-pointer entry in the overlay `ExternalSecret`.',
        '',
        'On merge: ArgoCD applies the ExternalSecret -> the External Secrets Operator reads the',
        'value from Vault -> materializes a Kubernetes Secret in the target namespace -> your',
        'workload can consume it.',
      ].join('\n'),
    });
    pullRequestUrls.push(pr.html_url);
    deps.logger.info(
      `capstone set-secret opened PR for key="${key}" env=${env}: ${pr.html_url}`,
    );
  }

  return { pullRequestUrls };
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
 * Read a file's UTF-8 content from a branch (or the default branch when `branch` is undefined).
 * Returns undefined for a 404 (file absent). Used to merge into an existing ExternalSecret and
 * to read its declared key names for List.
 */
async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string | undefined,
  path: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ...(branch ? { ref: branch } : {}),
    });
    if (!Array.isArray(data) && 'content' in data && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf8');
    }
    return undefined;
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      return undefined;
    }
    throw e;
  }
}

/** Create or update a file on a branch (idempotent overwrite/rotate). */
async function putFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  let sha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });
    if (!Array.isArray(data) && 'sha' in data) {
      sha = data.sha;
    }
  } catch (e) {
    if ((e as { status?: number }).status !== 404) {
      throw e;
    }
  }
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    branch,
    path,
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha,
  });
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
 * Delete a secret key from a Component via a PR — the inverse of sealAndPublish. Removes the
 * Vault key (KV-v2 merge-patch null at each env path where it was declared) AND drops its data[]
 * entry from each overlay ExternalSecret. The ES FILE is never deleted (it ships with the demo
 * `app-secret` entry + drives zero-config), only the one entry is removed. ENFORCES the same
 * capstone.secret.seal authz + owner re-check + fail-closed as seal (you can only delete what
 * you could seal). PR-by-default for the git side — the Vault value is removed IMMEDIATELY.
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
  const branch = `${cfg.defaultBranchPrefix}delete-${toResourceName(key)}-${Date.now()}`;

  // Find every env whose overlay ExternalSecret declares this key (on the base branch).
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

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.object.sha,
  });

  for (const { env, esPath, existing } of envEntries) {
    // 1) Remove the value from Vault immediately (merge-patch null; sibling keys preserved).
    const vaultKey = esVaultKey(existing, teamSlug, env);
    await vault.deleteKey(vaultKey, key);

    // 2) Drop just this data[] entry from the overlay ES (never delete the file).
    const updated = removeEsDataEntry(existing, key);
    if (updated !== existing) {
      await putFile(
        octokit,
        owner,
        repo,
        branch,
        esPath,
        updated,
        `chore(secrets): remove ${key} for ${env}`,
      );
    }
  }

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    base: baseBranch,
    head: branch,
    title: `chore(secrets): delete ${key}`,
    body: [
      `Removes the secret \`${key}\` from \`${entityRef}\`.`,
      '',
      'The value has been removed from Vault. This PR drops the key entry from the overlay',
      '`ExternalSecret`(s). On merge: ArgoCD applies the change -> the External Secrets Operator',
      'drops the key from the materialized Secret on sync.',
      '',
      '**The Vault value is gone now; the GitOps declaration updates on merge.**',
    ].join('\n'),
  });
  deps.logger.info(
    `capstone delete-secret opened PR for key="${key}": ${pr.html_url}`,
  );
  return { pullRequestUrl: pr.html_url };
}
