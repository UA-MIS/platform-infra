/*
 * `capstone:seal-secret` — the M3 secrets sealing scaffolder action (plan §2, §3).
 *
 * Flow (handler): authorize the actor for `capstone.secret.seal` (+ a belt-and-suspenders
 * owner re-check) -> resolve the target Component's source repo -> for each target env,
 * build a k8s Secret manifest IN MEMORY -> seal it by shelling out to the bundled `kubeseal`
 * binary against the EXPORTED OFFLINE public cert (D-047 A2: no controller egress), with the
 * plaintext piped to kubeseal STDIN (never a tempfile, never logged) -> open a PR to the
 * team's app repo committing the SealedSecret at `<secretsDir>/<key>.sealedsecret.yaml`
 * (+ append it to each env overlay's kustomization).
 *
 * SECURITY INVARIANTS (plan R2 — security review focus):
 *   - the plaintext VALUE is piped to kubeseal stdin; it is NEVER written to a tempfile and
 *     NEVER passed as an argv (execFile, not a shell) so it can't leak via process listings.
 *   - the VALUE never reaches ctx.logger or any thrown error string (only the KEY + env).
 *   - the action fails CLOSED on an authz miss OR an owner-intersection miss: no kubeseal
 *     invocation, no Octokit call (the owner re-check runs BEFORE any seal/publish).
 */
import { execFile } from 'child_process';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type {
  AuthService,
  LoggerService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type { Config } from '@backstage/config';
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
import { sealSecretPermission } from '../permissions';

/** The platform admin group ref (D-027) — kept in sync with M2's permissionPolicy.ts. */
export const ADMIN_GROUP_REF = 'group:default/labmx';

/** Services the action handler needs, injected from the module's registerInit (plan §3). */
export interface SealSecretActionDeps {
  config: Config;
  logger: LoggerService;
  catalog: CatalogService;
  permissions: PermissionsService;
  auth: AuthService;
}

/** Resolved capstone.secrets.* config (plan §2.2). `kubesealBin` defaults to PATH lookup. */
interface SecretsConfig {
  sealingCertPath: string;
  kubesealBin: string;
  defaultBranchPrefix: string;
  secretsDir: string;
  /** Relative path from an env overlay's kustomization.yaml to the secrets dir. */
  overlayRelPath: string;
  /** Parent dir holding per-env overlay kustomizations (e.g. ".devops/chart/overlays"). */
  overlaysDir: string;
}

function readSecretsConfig(config: Config): SecretsConfig {
  const c = config.getOptionalConfig('capstone.secrets');
  return {
    sealingCertPath:
      c?.getOptionalString('sealingCertPath') ??
      '/etc/backstage/sealing-cert/sealing-cert.pem',
    kubesealBin: c?.getOptionalString('kubesealBin') ?? 'kubeseal',
    defaultBranchPrefix: c?.getOptionalString('defaultBranchPrefix') ?? 'secrets/',
    secretsDir: c?.getOptionalString('secretsDir') ?? '.devops/secrets',
    overlayRelPath: c?.getOptionalString('overlayRelPath') ?? '../../secrets',
    overlaysDir:
      c?.getOptionalString('overlaysDir') ?? '.devops/chart/overlays',
  };
}

/**
 * Seal a k8s Secret OFFLINE with kubeseal. The plaintext manifest is piped to STDIN and the
 * sealed YAML captured from stdout — the plaintext NEVER touches disk and is NEVER an argv.
 * On failure we surface kubeseal's STDERR only; stderr does not contain the value (kubeseal
 * reads the value from stdin and echoes only diagnostics), and we never include stdin in the
 * error. Returns the sealed SealedSecret YAML.
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
function parseGithubRepo(sourceLocation: string): { owner: string; repo: string } {
  // source-location targets look like "url:https://github.com/UA-MIS/my-app/tree/main/".
  const cleaned = sourceLocation.replace(/^url:/, '').replace(/\/+$/, '');
  const m = cleaned.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/.*)?$/);
  if (!m) {
    throw new InputError(
      `Target Component source-location is not a recognizable GitHub repo URL: ${cleaned}`,
    );
  }
  return { owner: m[1], repo: m[2] };
}

/**
 * Derive the actor's ownership refs (their User ref + each team Group ref). Uses the catalog
 * to resolve the user's group memberships from credentials — mirrors how M2's policy obtains
 * ownershipEntityRefs, so the handler's belt-and-suspenders check matches the policy decision.
 */
async function resolveActorOwnership(
  deps: SealSecretActionDeps,
  credentials: Awaited<ReturnType<AuthService['getOwnServiceCredentials']>>,
  userEntityRef: string,
): Promise<string[]> {
  const refs = new Set<string>([userEntityRef]);
  // Groups whose raw spec.members or computed relations.hasMember include this user.
  const { items } = await deps.catalog.getEntities(
    {
      filter: [
        { kind: 'Group', 'relations.hasMember': userEntityRef },
        { kind: 'Group', 'spec.members': parseEntityRef(userEntityRef).name },
      ],
      fields: ['kind', 'metadata.name', 'metadata.namespace'],
    },
    { credentials },
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
    // spec.owner may be a bare group name or a full ref; normalize to a Group ref by default.
    refs.add(
      owner.includes(':')
        ? stringifyEntityRef(parseEntityRef(owner))
        : stringifyEntityRef({ kind: 'Group', namespace: 'default', name: owner }),
    );
  }
  for (const rel of entity.relations ?? []) {
    if (rel.type === RELATION_OWNED_BY) {
      refs.add(rel.targetRef);
    }
  }
  return Array.from(refs);
}

/**
 * Factory for the `capstone:seal-secret` action. Takes its service deps so the module wires
 * them in at registration (createBackendModule registerInit), keeping the action unit-
 * testable with mocks.
 */
export function createSealSecretAction(deps: SealSecretActionDeps) {
  const { config, logger, catalog, permissions, auth } = deps;

  return createTemplateAction({
    id: 'capstone:seal-secret',
    description:
      'Seal a team secret (kubeseal, offline cert) and open a PR committing the ' +
      'SealedSecret to the team app repo. Write-only: values cannot be read back.',
    schema: {
      input: {
        entityRef: z =>
          z.string({
            description:
              'Catalog entity ref of the target Component (e.g. component:default/my-app).',
          }),
        key: z =>
          z.string({
            description: 'The secret key/name (e.g. DATABASE_URL).',
          }),
        value: z =>
          z.string({
            description:
              'The secret value (plaintext). Sealed immediately; never stored or logged.',
          }),
        envs: z =>
          z
            .array(z.enum(['dev', 'staging', 'prod']))
            .min(1)
            .describe(
              'Target environments to seal for (dev, staging, and/or prod). ' +
                'Preview (ephemeral pr-<n>) namespaces are out of scope — strict scope ' +
                'cannot pre-seal for an unknown namespace.',
            ),
      },
      output: {
        pullRequestUrls: z =>
          z
            .array(z.string())
            .describe('The opened pull request URL(s), one per env.'),
      },
    },
    async handler(ctx) {
      const { entityRef, key, value, envs } = ctx.input;
      const secretsCfg = readSecretsConfig(config);

      // NEVER log the value. Only the key + envs + entity are ever logged.
      logger.info(
        `capstone:seal-secret requested for key="${key}" envs=[${envs.join(
          ',',
        )}] target=${entityRef}`,
      );

      // ── 1. AUTHORIZE via the permission framework (M2's policy decides) ──────────────
      const credentials = await ctx.getInitiatorCredentials();
      const decision = (
        await permissions.authorize([{ permission: sealSecretPermission }], {
          credentials,
        })
      )[0];
      if (decision.result !== AuthorizeResult.ALLOW) {
        throw new NotAllowedError(
          'You are not permitted to seal secrets for this team (capstone.secret.seal).',
        );
      }

      // ── 2. Resolve the target Component + its owner ─────────────────────────────────
      const svcCreds = await auth.getOwnServiceCredentials();
      const target = await catalog.getEntityByRef(entityRef, {
        credentials: svcCreds,
      });
      if (!target) {
        throw new NotFoundError(
          `Target Component not found in the catalog: ${entityRef}`,
        );
      }
      const ownerRefs = entityOwnerRefs(target);

      // ── 3. BELT-AND-SUSPENDERS owner re-check (fails CLOSED, plan §2.3 / R1) ─────────
      // Even with the policy ALLOW above, re-derive the actor's ownership and require it to
      // intersect the target's owner (admin override for `labmx`). This makes the action safe
      // even if the policy is ever misconfigured to a blanket ALLOW.
      const actorUserRef =
        (credentials.principal as { userEntityRef?: string } | undefined)
          ?.userEntityRef ?? undefined;
      if (!actorUserRef) {
        throw new NotAllowedError(
          'Sealing requires an authenticated user identity (no service-to-service sealing).',
        );
      }
      const actorOwnership = await resolveActorOwnership(
        deps,
        svcCreds,
        actorUserRef,
      );
      const isAdmin = actorOwnership.includes(ADMIN_GROUP_REF);
      const intersects = ownerRefs.some(o => actorOwnership.includes(o));
      if (!isAdmin && !intersects) {
        throw new NotAllowedError(
          `You do not own ${entityRef}; sealing is restricted to the owning team.`,
        );
      }

      // ── 4. Resolve the team app repo from the Component's source-location ────────────
      const sourceLocation =
        target.metadata.annotations?.[ANNOTATION_SOURCE_LOCATION];
      if (!sourceLocation) {
        throw new InputError(
          `Target Component ${entityRef} has no ${ANNOTATION_SOURCE_LOCATION} annotation; ` +
            `cannot determine which repo to open the PR against.`,
        );
      }
      const { owner, repo } = parseGithubRepo(sourceLocation);

      // ── 5. Build an Octokit from the App credentials via integrations (no PAT) ───────
      const integrations = ScmIntegrations.fromConfig(config);
      const ghCredentials = DefaultGithubCredentialsProvider.fromIntegrations(
        integrations,
      );
      const repoUrl = `https://github.com/${owner}/${repo}`;
      const { token } = await ghCredentials.getCredentials({ url: repoUrl });
      if (!token) {
        throw new Error(
          `No GitHub credentials resolved for ${repoUrl}; check integrations.github.`,
        );
      }
      const octokit = new Octokit({ auth: token });

      // The team's canonical slug = the owning team's group name (drives the namespace).
      const teamSlug = parseEntityRef(
        ownerRefs.find(r => r.startsWith('group:')) ?? ownerRefs[0] ?? entityRef,
      ).name;
      const resourceName = toResourceName(key);
      const secretFilePath = `${secretsCfg.secretsDir}/${resourceName}.sealedsecret.yaml`;

      // Repo default branch (PR base).
      const { data: repoInfo } = await octokit.repos.get({ owner, repo });
      const baseBranch = repoInfo.default_branch;
      const { data: baseRef } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${baseBranch}`,
      });
      const baseSha = baseRef.object.sha;

      const pullRequestUrls: string[] = [];

      // ── 6. Per env: seal -> commit the SealedSecret -> append to the overlay -> PR ───
      for (const env of envs) {
        const namespace = `${teamSlug}-${env}`;
        const manifest = buildSecretManifest(
          resourceName,
          namespace,
          key,
          value,
        );

        // Seal OFFLINE (R2: stdin only; the exact `make seal` invocation, strict scope).
        const sealedYaml = await kubesealStdin(
          secretsCfg.kubesealBin,
          [
            '--cert',
            secretsCfg.sealingCertPath,
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

        // Branch per env+key+timestamp (avoids collisions; R7).
        const branch = `${secretsCfg.defaultBranchPrefix}${resourceName}-${env}-${Date.now()}`;
        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        });

        // Commit the SealedSecret (create or overwrite/rotate — R, §2.4).
        await putFile(
          octokit,
          owner,
          repo,
          branch,
          secretFilePath,
          sealedYaml,
          `chore(secrets): seal ${key} for ${env}`,
        );

        // Append the SealedSecret to the env overlay's kustomization (Option A, m4-dev).
        await appendToOverlayKustomization(
          octokit,
          owner,
          repo,
          branch,
          `${secretsCfg.overlaysDir}/${env}/kustomization.yaml`,
          `${secretsCfg.overlayRelPath}/${resourceName}.sealedsecret.yaml`,
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
        logger.info(
          `capstone:seal-secret opened PR for key="${key}" env=${env}: ${pr.html_url}`,
        );
      }

      ctx.output('pullRequestUrls', pullRequestUrls);
    },
  });
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
    // 404 => new file; anything else re-throws.
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
 * Tolerant: if the file or a `resources:` block is missing it creates/extends them. Never
 * duplicates an entry that is already present.
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

  // Already referenced — nothing to do (idempotent across re-seals/rotations).
  if (existing.includes(resourceRelPath)) {
    return;
  }

  let updated: string;
  if (/^resources:\s*$/m.test(existing) || /^resources:\s*\n/m.test(existing)) {
    // Append under the existing resources: block.
    updated = existing.replace(
      /^resources:\s*$/m,
      `resources:\n  - ${resourceRelPath}`,
    );
    // If the regex above didn't insert (block had inline items), fall back to appending.
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
