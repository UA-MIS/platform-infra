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
  secretsDir: string;
  overlayRelPath: string;
  overlaysDir: string;
  /** The k8s Secret the ExternalSecret materializes (target.name + the ES name). */
  targetSecretName: string;
  /** The per-tenant SecretStore the ExternalSecret references (kind defaults to SecretStore). */
  secretStoreName: string;
  secretStoreKind: string;
  /** Vault connection (the VaultClient writes the value here). */
  vault: VaultClientConfig;
}

function readSecretsConfig(config: Config): SecretsConfig {
  const c = config.getOptionalConfig('capstone.secrets');
  const v = c?.getOptionalConfig('vault');
  return {
    defaultBranchPrefix:
      c?.getOptionalString('defaultBranchPrefix') ?? 'secrets/',
    secretsDir: c?.getOptionalString('secretsDir') ?? '.devops/secrets',
    overlayRelPath: c?.getOptionalString('overlayRelPath') ?? '../../secrets',
    overlaysDir:
      c?.getOptionalString('overlaysDir') ?? '.devops/chart/overlays',
    targetSecretName:
      c?.getOptionalString('targetSecretName') ?? 'app-secrets',
    secretStoreName: c?.getOptionalString('secretStoreName') ?? 'vault-tenant',
    secretStoreKind: c?.getOptionalString('secretStoreKind') ?? 'SecretStore',
    vault: {
      addr:
        v?.getOptionalString('addr') ??
        'https://vault.vault.svc.cluster.local:8200',
      mount: v?.getOptionalString('mount') ?? 'secret',
      authMount: v?.getOptionalString('authMount') ?? 'kubernetes',
      role: v?.getOptionalString('role') ?? 'backstage-secrets',
      // A projected SA token with audience=vault (NOT the default API-server-audience token):
      // Vault's backstage-secrets role is bound to audience "vault", so the deploy mounts a
      // serviceAccountToken projected volume (audience: vault) here. See app-config.production.
      saTokenPath:
        v?.getOptionalString('saTokenPath') ?? '/var/run/secrets/vault/token',
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
 * Build an ExternalSecret manifest for a tenant env — key NAMES + remoteRef pointers ONLY, NO
 * values (the "nothing in git" win). One ExternalSecret per `<team>-<env>` namespace, named +
 * targeting `targetSecretName`, referencing the per-tenant SecretStore. Each `keys[]` entry
 * maps a secret KEY to the Vault property at the single per-env path (tenants/<team>/<env>/app).
 * JSON.stringify every interpolated value so no key can break the YAML document shape.
 */
function buildExternalSecret(
  cfg: SecretsConfig,
  teamSlug: string,
  env: string,
  keys: string[],
): string {
  const namespace = `${teamSlug}-${env}`;
  const vaultKey = vaultPathFor(teamSlug, env);
  const lines = [
    'apiVersion: external-secrets.io/v1',
    'kind: ExternalSecret',
    'metadata:',
    `  name: ${JSON.stringify(cfg.targetSecretName)}`,
    `  namespace: ${JSON.stringify(namespace)}`,
    'spec:',
    '  refreshInterval: "1h"',
    '  secretStoreRef:',
    `    name: ${JSON.stringify(cfg.secretStoreName)}`,
    `    kind: ${JSON.stringify(cfg.secretStoreKind)}`,
    '  target:',
    `    name: ${JSON.stringify(cfg.targetSecretName)}`,
    '    creationPolicy: Owner',
    '  data:',
  ];
  for (const key of [...keys].sort()) {
    lines.push(
      `    - secretKey: ${JSON.stringify(key)}`,
      '      remoteRef:',
      `        key: ${JSON.stringify(vaultKey)}`,
      `        property: ${JSON.stringify(key)}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Parse the secret KEY NAMES out of an existing ExternalSecret manifest (the `property:` of each
 * data entry). Best-effort line scan (we never need full YAML parsing) — used to merge a new
 * key into an existing ExternalSecret idempotently without disturbing the others.
 */
function parseExternalSecretKeys(yaml: string): string[] {
  const keys = new Set<string>();
  for (const line of yaml.split('\n')) {
    const m = line.match(/^\s*property:\s*["']?([^"'\s]+)["']?\s*$/);
    if (m) {
      keys.add(m[1]);
    }
  }
  return Array.from(keys);
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

/** The ExternalSecret file path for an env in the tenant repo. */
function externalSecretPath(cfg: SecretsConfig, env: string): string {
  return `${cfg.secretsDir}/externalsecret-${env}.yaml`;
}

/**
 * Set a secret for each env: WRITE the value into Vault (KV-v2, per-env path) and open a PR per
 * env committing/merging the ExternalSecret declaration (NAMES only) + its overlay reference.
 * Returns the PR URLs. ENFORCES the same authz + owner re-check + fail-closed as everywhere
 * (via authorizeAndResolveTarget). The value reaches ONLY the Vault request body — never git,
 * never a log, never a thrown error.
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

    // 1) WRITE the value into Vault (the only place the plaintext lands). Idempotent set/rotate
    //    of one key at the per-env path; the other keys at that path are preserved.
    await vault.setKey(vaultPathFor(teamSlug, env), key, value);

    // 2) Commit/merge the ExternalSecret declaration (names only) + overlay ref via a PR.
    const branch = `${cfg.defaultBranchPrefix}${toResourceName(key)}-${env}-${Date.now()}`;
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });

    const esPath = externalSecretPath(cfg, env);
    // Merge the new key into any existing ExternalSecret for this env (idempotent), so adding a
    // second key never drops the first. Read the current file on the branch (if any).
    const existing = await getFileContent(octokit, owner, repo, branch, esPath);
    const existingKeys = existing ? parseExternalSecretKeys(existing) : [];
    const mergedKeys = Array.from(new Set([...existingKeys, key]));
    const esYaml = buildExternalSecret(cfg, teamSlug, env, mergedKeys);

    await putFile(
      octokit,
      owner,
      repo,
      branch,
      esPath,
      esYaml,
      `chore(secrets): declare ${key} for ${env}`,
    );

    await appendToOverlayKustomization(
      octokit,
      owner,
      repo,
      branch,
      `${cfg.overlaysDir}/${env}/kustomization.yaml`,
      `${cfg.overlayRelPath}/externalsecret-${env}.yaml`,
    );

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
        'this secret, set it again. This PR adds **no secret material** — only an',
        '`ExternalSecret` declaration (key names + Vault pointers).',
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

  // List the per-env ExternalSecret files (externalsecret-<env>.yaml). Each declares its KEY
  // NAMES as the `property:` of its data entries — we report those (NAMES only, never values;
  // we never read Vault here). Each key's last-updated is the file's last commit date.
  let files: Array<{ name: string; path: string; env: string }> = [];
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: cfg.secretsDir,
    });
    if (Array.isArray(data)) {
      files = data
        .filter(f => f.type === 'file')
        .map(f => {
          const m = f.name.match(/^externalsecret-(dev|staging|prod)\.yaml$/);
          return m ? { name: f.name, path: f.path, env: m[1] } : undefined;
        })
        .filter((f): f is { name: string; path: string; env: string } => !!f);
    }
  } catch (e) {
    // No secrets dir yet -> nothing declared.
    if ((e as { status?: number }).status === 404) {
      return [];
    }
    throw e;
  }

  const summaries: SecretSummary[] = [];
  for (const file of files) {
    let lastUpdated: string | undefined;
    let keys: string[] = [];
    const text = await getFileContent(octokit, owner, repo, undefined, file.path);
    if (text) {
      keys = parseExternalSecretKeys(text);
    }
    try {
      const { data: commits } = await octokit.repos.listCommits({
        owner,
        repo,
        path: file.path,
        per_page: 1,
      });
      lastUpdated = commits[0]?.commit?.committer?.date ?? undefined;
    } catch {
      // best-effort; leave lastUpdated undefined
    }
    for (const key of keys) {
      summaries.push({ key, env: file.env, lastUpdated });
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
 * Idempotently add `resourceRelPath` to the `resources:` list of an env overlay's
 * kustomization.yaml so the team's overlay actually applies the new ExternalSecret (Option A).
 * Tolerant: creates/extends the file + the resources block; never duplicates an existing entry.
 */
async function appendToOverlayKustomization(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  resourceRelPath: string,
): Promise<void> {
  let existing = '';
  let sha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });
    if (!Array.isArray(data) && 'content' in data && data.content) {
      existing = Buffer.from(data.content, 'base64').toString('utf8');
      sha = data.sha;
    }
  } catch (e) {
    if ((e as { status?: number }).status !== 404) {
      throw e;
    }
  }

  if (existing.includes(resourceRelPath)) {
    return;
  }

  let updated: string;
  if (/^resources:\s*$/m.test(existing) || /^resources:\s*\n/m.test(existing)) {
    updated = existing.replace(
      /^resources:\s*$/m,
      `resources:\n  - ${resourceRelPath}`,
    );
    if (updated === existing) {
      updated = `${existing.replace(/\n*$/, '')}\n  - ${resourceRelPath}\n`;
    }
  } else if (existing.trim().length === 0) {
    updated = [
      'apiVersion: kustomize.config.k8s.io/v1beta1',
      'kind: Kustomization',
      'resources:',
      `  - ${resourceRelPath}`,
      '',
    ].join('\n');
  } else {
    updated = `${existing.replace(/\n*$/, '')}\nresources:\n  - ${resourceRelPath}\n`;
  }

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    branch,
    path,
    message: `chore(secrets): reference ${resourceRelPath} in ${branch}`,
    content: Buffer.from(updated, 'utf8').toString('base64'),
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
 * Vault key (KV-v2 merge-patch null at each env path where it was declared) AND drops it from
 * the per-env ExternalSecret: if the key was the env's last, the `externalsecret-<env>.yaml`
 * file + its overlay reference are removed; otherwise the ExternalSecret is rewritten with the
 * remaining keys. ENFORCES the same capstone.secret.seal authz + owner re-check + fail-closed
 * as seal (you can only delete what you could seal). PR-by-default for the git side — the
 * Vault value, however, is removed IMMEDIATELY (it is not gated on the merge).
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
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.object.sha,
  });

  // Find every env whose ExternalSecret declares this key, on the base branch.
  const envsWithKey: string[] = [];
  for (const env of ['dev', 'staging', 'prod']) {
    const esPath = externalSecretPath(cfg, env);
    const existing = await getFileContent(octokit, owner, repo, undefined, esPath);
    if (existing && parseExternalSecretKeys(existing).includes(key)) {
      envsWithKey.push(env);
    }
  }
  if (envsWithKey.length === 0) {
    throw new NotFoundError(
      `No secret "${key}" found for ${entityRef} (nothing to delete).`,
    );
  }

  for (const env of envsWithKey) {
    // 1) Remove the value from Vault immediately (merge-patch null; other keys preserved).
    await vault.deleteKey(vaultPathFor(teamSlug, env), key);

    // 2) Update the ExternalSecret on the branch: drop this key. If it was the last key, remove
    //    the file + its overlay reference; otherwise rewrite with the remaining keys.
    const esPath = externalSecretPath(cfg, env);
    const existing = await getFileContent(octokit, owner, repo, branch, esPath);
    const remaining = (existing ? parseExternalSecretKeys(existing) : []).filter(
      k => k !== key,
    );
    if (remaining.length === 0) {
      // Delete the file (read its sha on the branch first).
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: esPath,
        ref: branch,
      });
      if (!Array.isArray(data) && 'sha' in data) {
        await octokit.repos.deleteFile({
          owner,
          repo,
          branch,
          path: esPath,
          message: `chore(secrets): remove ${key} for ${env}`,
          sha: data.sha,
        });
      }
      await removeFromOverlayKustomization(
        octokit,
        owner,
        repo,
        branch,
        `${cfg.overlaysDir}/${env}/kustomization.yaml`,
        `${cfg.overlayRelPath}/externalsecret-${env}.yaml`,
      );
    } else {
      await putFile(
        octokit,
        owner,
        repo,
        branch,
        esPath,
        buildExternalSecret(cfg, teamSlug, env, remaining),
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
      'The value has been removed from Vault. This PR drops the key from the',
      '`ExternalSecret` declaration(s) + overlay references. On merge: ArgoCD applies the',
      'change -> the External Secrets Operator drops the key (or the whole Secret) on sync.',
      '',
      '**The Vault value is gone now; the GitOps declaration updates on merge.**',
    ].join('\n'),
  });
  deps.logger.info(
    `capstone delete-secret opened PR for key="${key}": ${pr.html_url}`,
  );
  return { pullRequestUrl: pr.html_url };
}

/**
 * Idempotently REMOVE a `- <resourceRelPath>` line from an env overlay's kustomization
 * resources list (the inverse of appendToOverlayKustomization). No-op if the overlay or the
 * line is absent — so deleting a secret an env never referenced is safe.
 */
async function removeFromOverlayKustomization(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  resourceRelPath: string,
): Promise<void> {
  let existing = '';
  let sha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });
    if (!Array.isArray(data) && 'content' in data && data.content) {
      existing = Buffer.from(data.content, 'base64').toString('utf8');
      sha = data.sha;
    }
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      return; // no overlay -> nothing to remove
    }
    throw e;
  }

  if (!existing.includes(resourceRelPath) || !sha) {
    return; // not referenced here
  }

  // Drop the resources entry line(s) for this path (handles `- path` and `  - path`).
  const updated = existing
    .split('\n')
    .filter(line => line.trim() !== `- ${resourceRelPath}`)
    .join('\n');

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    branch,
    path,
    message: `chore(secrets): unreference ${resourceRelPath} in ${branch}`,
    content: Buffer.from(updated, 'utf8').toString('base64'),
    sha,
  });
}
