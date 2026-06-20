/*
 * sealCore — the SHARED implementation of the M3 secrets capability (ADR-029 §4/§6).
 *
 * Both entry points call this ONE module, so there is a single sealing + authz path (never a
 * softer back-door):
 *   - the `capstone:seal-secret` scaffolder action (src/actions/sealSecret.ts), and
 *   - the `capstone-secrets` backend route POST /seal (src/service/router.ts) the frontend
 *     Secrets page posts to.
 *
 * sealAndPublish() does, in order: authorize `capstone.secret.seal` via the permission
 * framework (M2's policy decides) -> a belt-and-suspenders owner re-check (the actor's catalog
 * Groups must intersect the target Component's owner; `labmx` admin override) -> per env,
 * build a k8s Secret IN MEMORY -> seal OFFLINE with kubeseal (value piped to STDIN, never a
 * tempfile, never an argv, never logged; D-047 A2 no controller egress) -> open a PR to the
 * team app repo committing the SealedSecret (+ append it to the env overlay kustomization).
 *
 * SECURITY INVARIANTS (plan R2 / R1): the plaintext is stdin-only; it never reaches a logger
 * or a thrown error (only the KEY + env); the flow fails CLOSED on an authz miss OR an owner
 * miss (no kubeseal, no Octokit) — enforced HERE so the action and the route share it.
 */
import { execFile } from 'child_process';
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

/** Resolved capstone.secrets.* config (plan §2.2). `kubesealBin` defaults to PATH lookup. */
interface SecretsConfig {
  sealingCertPath: string;
  kubesealBin: string;
  defaultBranchPrefix: string;
  secretsDir: string;
  overlayRelPath: string;
  overlaysDir: string;
}

function readSecretsConfig(config: Config): SecretsConfig {
  const c = config.getOptionalConfig('capstone.secrets');
  return {
    sealingCertPath:
      c?.getOptionalString('sealingCertPath') ??
      '/etc/backstage/sealing-cert/sealing-cert.pem',
    kubesealBin: c?.getOptionalString('kubesealBin') ?? 'kubeseal',
    defaultBranchPrefix:
      c?.getOptionalString('defaultBranchPrefix') ?? 'secrets/',
    secretsDir: c?.getOptionalString('secretsDir') ?? '.devops/secrets',
    overlayRelPath: c?.getOptionalString('overlayRelPath') ?? '../../secrets',
    overlaysDir:
      c?.getOptionalString('overlaysDir') ?? '.devops/chart/overlays',
  };
}

/**
 * Seal a k8s Secret OFFLINE with kubeseal. The plaintext manifest is piped to STDIN and the
 * sealed YAML captured from stdout — the plaintext NEVER touches disk and is NEVER an argv.
 * On failure we surface kubeseal's STDERR only (it never contains the value); we never include
 * stdin in the error. Returns the sealed SealedSecret YAML.
 */
function kubesealStdin(
  bin: string,
  args: string[],
  plaintextManifest: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // NB: never include plaintextManifest / stdin in the error (R2).
          reject(
            new Error(
              `kubeseal failed (exit ${
                (error as NodeJS.ErrnoException).code ?? 'unknown'
              }): ${stderr?.toString().trim() || error.message}`,
            ),
          );
          return;
        }
        resolve(stdout.toString());
      },
    );
    // Pipe the plaintext to stdin then close it; discard the reference immediately after.
    child.stdin?.end(plaintextManifest);
  });
}

/** Build the in-memory k8s Secret manifest for a single key/value in a target namespace. */
function buildSecretManifest(
  name: string,
  namespace: string,
  key: string,
  value: string,
): string {
  // stringData lets kubeseal base64 the value itself; the manifest exists only in memory and
  // in kubeseal's stdin buffer. JSON.stringify both key and value so any YAML-special chars
  // (colons, quotes, newlines) are safely quoted — no value can break the document shape.
  return [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${JSON.stringify(name)}`,
    `  namespace: ${JSON.stringify(namespace)}`,
    'type: Opaque',
    'stringData:',
    `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
    '',
  ].join('\n');
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
 * Seal a secret for each env and open a PR per env. Returns the PR URLs. ENFORCES the same
 * authz + owner re-check + fail-closed as everywhere (via authorizeAndResolveTarget).
 */
export async function sealAndPublish(
  deps: CapstoneSecretsDeps,
  request: SealRequest,
): Promise<{ pullRequestUrls: string[] }> {
  const { credentials, entityRef, key, value, envs } = request;
  const cfg = readSecretsConfig(deps.config);

  // NEVER log the value — only the key + envs + target.
  deps.logger.info(
    `capstone seal-secret requested for key="${key}" envs=[${envs.join(
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

  const resourceName = toResourceName(key);
  const secretFilePath = `${cfg.secretsDir}/${resourceName}.sealedsecret.yaml`;

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
    const manifest = buildSecretManifest(resourceName, namespace, key, value);

    // Seal OFFLINE (R2: stdin only; the exact `make seal` invocation, strict scope).
    const sealedYaml = await kubesealStdin(
      cfg.kubesealBin,
      [
        '--cert',
        cfg.sealingCertPath,
        '--format',
        'yaml',
        '--scope',
        'strict',
        '--namespace',
        namespace,
        '--name',
        resourceName,
      ],
      manifest,
    );

    const branch = `${cfg.defaultBranchPrefix}${resourceName}-${env}-${Date.now()}`;
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });

    await putFile(
      octokit,
      owner,
      repo,
      branch,
      secretFilePath,
      sealedYaml,
      `chore(secrets): seal ${key} for ${env}`,
    );

    await appendToOverlayKustomization(
      octokit,
      owner,
      repo,
      branch,
      `${cfg.overlaysDir}/${env}/kustomization.yaml`,
      `${cfg.overlayRelPath}/${resourceName}.sealedsecret.yaml`,
    );

    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      base: baseBranch,
      head: branch,
      title: `chore(secrets): seal ${key} for ${env}`,
      body: [
        `Seals the secret \`${key}\` for environment \`${env}\` (namespace \`${namespace}\`).`,
        '',
        '**Write-only:** sealed values cannot be read back. To change this secret, set it again.',
        '',
        'On merge: ArgoCD applies the SealedSecret -> the sealed-secrets controller decrypts',
        'it into a Kubernetes Secret in the target namespace -> your workload can consume it.',
      ].join('\n'),
    });
    pullRequestUrls.push(pr.html_url);
    deps.logger.info(
      `capstone seal-secret opened PR for key="${key}" env=${env}: ${pr.html_url}`,
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

  // List the per-key SealedSecret files. The strict-scope namespace is inside each file, not
  // the path, so we report the KEY (filename) for every env the repo declares overlays for.
  let files: Array<{ name: string; path: string }> = [];
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: cfg.secretsDir,
    });
    if (Array.isArray(data)) {
      files = data
        .filter(f => f.type === 'file' && f.name.endsWith('.sealedsecret.yaml'))
        .map(f => ({ name: f.name, path: f.path }));
    }
  } catch (e) {
    // No secrets dir yet -> nothing sealed.
    if ((e as { status?: number }).status === 404) {
      return [];
    }
    throw e;
  }

  // For each file, read the strict-scope namespace (-> env) + the last commit date. We open
  // the file ONLY to read its metadata.namespace (NOT the encrypted data — never decrypted).
  const summaries: SecretSummary[] = [];
  for (const file of files) {
    const key = file.name.replace(/\.sealedsecret\.yaml$/, '');
    let env = 'unknown';
    let lastUpdated: string | undefined;
    try {
      const { data: content } = await octokit.repos.getContent({
        owner,
        repo,
        path: file.path,
      });
      if (!Array.isArray(content) && 'content' in content && content.content) {
        const text = Buffer.from(content.content, 'base64').toString('utf8');
        const nsMatch = text.match(
          /namespace:\s*["']?[a-z0-9-]+-(dev|staging|prod)["']?/i,
        );
        if (nsMatch) {
          env = nsMatch[1];
        }
      }
    } catch {
      // best-effort; leave env=unknown
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
    summaries.push({ key, env, lastUpdated });
  }
  return summaries;
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
 * kustomization.yaml so the team's overlay actually applies the new SealedSecret (Option A).
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
