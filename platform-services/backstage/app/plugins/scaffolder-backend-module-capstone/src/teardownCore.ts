/*
 * teardownCore — the SHARED implementation of the ADMIN tenant-teardown capability.
 *
 * WHAT A TENANT IS (ADR-031): every capstone tenant is provisioned by exactly ONE Crossplane
 * `CapstoneTenant` composite resource (XR), committed as a single file at
 * `platform-infra:tenants/_claims/<team>-<app>.yaml` (the "onboarding ledger", see that dir's
 * README). ArgoCD (`platform-crossplane-claims`) syncs the dir; Crossplane's reviewed-once
 * Composition expands the XR into the WHOLE tenant — repo, Harbor project + robots, Vault
 * policy/role, per-env namespaces + quota/limitrange/netpol/RBAC/PSA, ESO plumbing, and the
 * env/preview ApplicationSets.
 *
 * WHAT TEARDOWN IS (the inverse — the ledger's own De-provision contract):
 *   `git rm tenants/_claims/<team>-<app>.yaml` → ArgoCD prunes the XR → Crossplane's finalizer
 *   CASCADE-DELETES every managed resource it composed (namespaces + pods → the reclaimed
 *   cluster RAM/CPU, Harbor project, Vault paths, DB grants, ArgoCD apps).
 * So "delete a finished project" is a SINGLE-FILE git removal against platform-infra. This
 * module opens a PR that removes that one file (admin merges → the cascade runs); it never
 * talks to the cluster directly (there is no k8s client in this app — the whole platform is
 * GitOps-driven, exactly like sealCore's PR-based writes).
 *
 * WHY PR-not-direct-commit: teardown is IRREVERSIBLE and wide-blast-radius, so a merge gate is
 * the honest control even though the caller is already an admin. The Vault-value delete in
 * sealCore is immediate; here NOTHING is destroyed until the PR merges — the frontend says so.
 *
 * SECURITY: ADMIN-ONLY (D-027 `labmx`). Both entry points (the capstone-tenants backend route
 * and any future action) call requireAdmin() here, which runs the `capstone.tenant.teardown`
 * permission check AND a belt-and-suspenders admin-group re-derivation, failing CLOSED — a
 * non-admin never reaches the list or the delete. This mirrors sealCore's shared authz spine
 * so there is no softer back-door.
 */
import type {
  AuthService,
  BackstageCredentials,
  LoggerService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type { Config } from '@backstage/config';
import {
  parseEntityRef,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { Octokit } from '@octokit/rest';
import { tenantTeardownPermission } from './permissions';
import { ADMIN_GROUP_REF } from './sealCore';

/** Services the teardown core needs, injected by the backend plugin (same shape as secrets). */
export interface CapstoneTenantsDeps {
  config: Config;
  logger: LoggerService;
  catalog: CatalogService;
  permissions: PermissionsService;
  auth: AuthService;
}

/** A provisioned tenant = one CapstoneTenant claim file. `name` is the delete key (file stem). */
export interface TenantSummary {
  /** `<team>-<appName>` — the claim's metadata.name AND its file basename; the delete key. */
  name: string;
  team: string;
  appName: string;
  semester: string;
  /** Provisioned database engine (none|mysql|postgres) — for display. */
  database?: string;
  /** Repo-relative path of the claim file (tenants/_claims/<name>.yaml) that teardown removes. */
  claimPath: string;
}

export interface ListTenantsRequest {
  credentials: BackstageCredentials;
}

export interface TeardownRequest {
  credentials: BackstageCredentials;
  /** The tenant `name` (== claim file stem) to tear down. */
  name: string;
  /**
   * Type-to-confirm guard — MUST equal `name`. A mismatch fails closed with a 400 (belt to the
   * frontend dialog's type-the-name-to-enable-Delete UX; the server never trusts the client to
   * have enforced it).
   */
  confirmName: string;
  /** Also archive the tenant's GitHub app repo (UA-MIS/<appName>) after the PR is opened. */
  archiveRepo?: boolean;
}

export interface TeardownResult {
  /** The PR that removes the claim file. Merge it to start the Crossplane cascade. */
  pullRequestUrl: string;
  /** The claim file the PR removes. */
  claimPath: string;
  /** Whether the GitHub app repo was archived (only when archiveRepo was requested). */
  repoArchived: boolean;
}

/** Resolved capstone.teardown.* config — where the onboarding ledger lives + PR conventions. */
interface TeardownConfig {
  /** GitHub org owning the platform-infra ledger repo. */
  infraRepoOwner: string;
  /** The ledger repo (holds tenants/_claims). */
  infraRepoName: string;
  /** Dir under the ledger repo holding the per-tenant claim files. */
  claimsDir: string;
  /** GitHub org the tenant APP repos live under (for optional archive). */
  appRepoOwner: string;
  /** PR branch name prefix. */
  branchPrefix: string;
}

function readTeardownConfig(config: Config): TeardownConfig {
  const c = config.getOptionalConfig('capstone.teardown');
  return {
    infraRepoOwner: c?.getOptionalString('infraRepoOwner') ?? 'UA-MIS',
    infraRepoName: c?.getOptionalString('infraRepoName') ?? 'platform-infra',
    claimsDir: c?.getOptionalString('claimsDir') ?? 'tenants/_claims',
    appRepoOwner: c?.getOptionalString('appRepoOwner') ?? 'UA-MIS',
    branchPrefix: c?.getOptionalString('branchPrefix') ?? 'teardown/',
  };
}

/** Extract the actor's user entity ref from credentials; throws if not an authenticated user. */
function requireUserRef(credentials: BackstageCredentials): string {
  const userRef = (
    credentials.principal as { userEntityRef?: string } | undefined
  )?.userEntityRef;
  if (!userRef) {
    throw new NotAllowedError(
      'Tenant teardown requires an authenticated user identity (no service-to-service teardown).',
    );
  }
  return userRef;
}

/**
 * Resolve the actor's group refs from the catalog (their team Group memberships). Mirrors how
 * sealCore derives ownership so the admin check matches the M2 policy's ownershipEntityRefs.
 *
 * `spec.members` matching (belt to `relations.hasMember`'s suspenders, robust to relation-
 * stitching lag — see authOidcProcess.ts's F1 and sealCore.ts's resolveActorOwnership, which
 * this mirrors exactly): the GitHub-org provider writes this RAW field as `<namespace>/<login>`
 * (e.g. "default/ccsmith33"), NOT a bare login and NOT a full "user:<namespace>/<login>" ref
 * (confirmed against the live catalog). Match all three shapes.
 */
async function resolveActorGroups(
  deps: CapstoneTenantsDeps,
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

/**
 * Authorize an ADMIN-only teardown operation. Runs the permission-framework check for
 * `capstone.tenant.teardown` AND a belt-and-suspenders re-derivation that the actor is a member
 * of the platform admin group (ADMIN_GROUP_REF = group:default/labmx). Fails CLOSED on either
 * miss. Shared by list + teardown so BOTH gate identically (no softer back-door).
 */
export async function requireAdmin(
  deps: CapstoneTenantsDeps,
  credentials: BackstageCredentials,
): Promise<void> {
  // 1. Permission framework (M2's policy: admins ALLOW, everyone else DENY for this permission).
  const decision = (
    await deps.permissions.authorize([{ permission: tenantTeardownPermission }], {
      credentials,
    })
  )[0];
  if (decision.result !== AuthorizeResult.ALLOW) {
    throw new NotAllowedError(
      'Tenant teardown is restricted to platform administrators (capstone.tenant.teardown).',
    );
  }

  // 2. Belt-and-suspenders: re-derive the actor's groups and require admin membership (fails
  //    closed even if the policy were misconfigured to ALLOW).
  const actorUserRef = requireUserRef(credentials);
  const serviceCreds = await deps.auth.getOwnServiceCredentials();
  const actorGroups = await resolveActorGroups(deps, serviceCreds, actorUserRef);
  if (!actorGroups.includes(ADMIN_GROUP_REF)) {
    throw new NotAllowedError(
      'Tenant teardown is restricted to platform administrators; your account is not in the ' +
        'admin group.',
    );
  }
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

/** A file is a LIVE claim iff it ends in .yaml and is not an `_*`-prefixed sample or README. */
function isLiveClaimFile(name: string): boolean {
  if (!name.endsWith('.yaml') && !name.endsWith('.yml')) {
    return false;
  }
  // `platform-crossplane-claims` excludes `_*.yaml` (samples) + README (see _claims/README).
  return !name.startsWith('_');
}

/** Scan a single scalar field out of a small machine-generated claim YAML (no full parse). */
function scanField(yaml: string, field: string): string | undefined {
  const m = yaml.match(
    new RegExp(`^\\s*${field}:\\s*["']?([^"'#\\n]+?)["']?\\s*$`, 'm'),
  );
  return m ? m[1].trim() : undefined;
}

/** Parse a claim file's display fields. `name` is authoritative from the file stem (metadata.name). */
function parseClaim(
  fileName: string,
  yaml: string,
): Omit<TenantSummary, 'claimPath'> {
  const name = fileName.replace(/\.(ya?ml)$/, '');
  return {
    name,
    team: scanField(yaml, 'team') ?? name,
    appName: scanField(yaml, 'appName') ?? name,
    semester: scanField(yaml, 'semester') ?? '',
    database: scanField(yaml, 'database'),
  };
}

/**
 * List every LIVE tenant = every CapstoneTenant claim file in the onboarding ledger
 * (platform-infra:tenants/_claims), excluding `_*` samples + README (mirrors the ArgoCD sync
 * exclude). Reads each file to surface team/app/semester/database for display. ADMIN-ONLY.
 * The claim file IS the delete target, so listing the ledger ties each row 1:1 to a teardown.
 */
export async function listTenants(
  deps: CapstoneTenantsDeps,
  request: ListTenantsRequest,
): Promise<TenantSummary[]> {
  await requireAdmin(deps, request.credentials);
  const cfg = readTeardownConfig(deps.config);
  const octokit = await octokitForRepo(
    deps.config,
    cfg.infraRepoOwner,
    cfg.infraRepoName,
  );

  let entries: Array<{ name: string; type: string; path: string }>;
  try {
    const { data } = await octokit.repos.getContent({
      owner: cfg.infraRepoOwner,
      repo: cfg.infraRepoName,
      path: cfg.claimsDir,
    });
    entries = Array.isArray(data)
      ? (data as Array<{ name: string; type: string; path: string }>)
      : [];
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      return []; // no ledger dir yet
    }
    throw e;
  }

  const tenants: TenantSummary[] = [];
  for (const entry of entries) {
    if (entry.type !== 'file' || !isLiveClaimFile(entry.name)) {
      continue;
    }
    const text = await getFileContent(
      octokit,
      cfg.infraRepoOwner,
      cfg.infraRepoName,
      undefined,
      entry.path,
    );
    if (text === undefined) {
      continue;
    }
    tenants.push({ ...parseClaim(entry.name, text), claimPath: entry.path });
  }
  tenants.sort((a, b) => a.name.localeCompare(b.name));
  return tenants;
}

/**
 * Tear down a tenant: open a PR against platform-infra that REMOVES its one claim file
 * (`tenants/_claims/<name>.yaml`). On merge, ArgoCD prunes the XR and Crossplane cascade-deletes
 * the whole tenant. Optionally archives the tenant's GitHub app repo (UA-MIS/<appName>). Nothing
 * is destroyed until the PR merges — the returned URL is where the admin completes the teardown.
 * ADMIN-ONLY; the type-to-confirm `confirmName` MUST equal `name` (fails closed on mismatch).
 */
export async function teardownTenant(
  deps: CapstoneTenantsDeps,
  request: TeardownRequest,
): Promise<TeardownResult> {
  const { credentials, name, confirmName, archiveRepo } = request;
  await requireAdmin(deps, credentials);
  const cfg = readTeardownConfig(deps.config);

  if (typeof name !== 'string' || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new InputError(
      `Invalid tenant name '${name}' — expected a DNS-1123 <team>-<app> claim name.`,
    );
  }
  // Type-to-confirm: the client dialog enforces this too, but the server never trusts it.
  if (confirmName !== name) {
    throw new InputError(
      'Confirmation text does not match the tenant name; teardown aborted.',
    );
  }

  deps.logger.info(`capstone tenant-teardown requested for tenant="${name}"`);

  const octokit = await octokitForRepo(
    deps.config,
    cfg.infraRepoOwner,
    cfg.infraRepoName,
  );
  const claimPath = `${cfg.claimsDir}/${name}.yaml`;

  // The claim MUST exist (fail closed — never open an empty PR for a typo'd/non-existent tenant).
  const { data: repoInfo } = await octokit.repos.get({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
  });
  const baseBranch = repoInfo.default_branch;
  const existing = await octokit.repos
    .getContent({
      owner: cfg.infraRepoOwner,
      repo: cfg.infraRepoName,
      path: claimPath,
      ref: baseBranch,
    })
    .catch((e: { status?: number }) => {
      if (e.status === 404) {
        return undefined;
      }
      throw e;
    });
  if (!existing || Array.isArray(existing.data) || !('sha' in existing.data)) {
    throw new NotFoundError(
      `No tenant claim found at ${claimPath}; nothing to tear down (already removed?).`,
    );
  }
  const fileSha = existing.data.sha;
  const appName = parseClaim(`${name}.yaml`, decodeContent(existing.data)).appName;

  const { data: baseRef } = await octokit.git.getRef({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    ref: `heads/${baseBranch}`,
  });
  const branch = `${cfg.branchPrefix}${name}-${Date.now()}`;
  await octokit.git.createRef({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    ref: `refs/heads/${branch}`,
    sha: baseRef.object.sha,
  });

  await octokit.repos.deleteFile({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    path: claimPath,
    message: `chore(teardown): de-provision tenant ${name}`,
    sha: fileSha,
    branch,
  });

  const { data: pr } = await octokit.pulls.create({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    base: baseBranch,
    head: branch,
    title: `chore(teardown): de-provision tenant ${name}`,
    body: [
      `Removes the CapstoneTenant claim \`${claimPath}\` — the entire per-tenant onboarding`,
      `artifact for **${name}**.`,
      '',
      '**On merge (this is when resources are actually freed):**',
      '',
      '1. ArgoCD (`platform-crossplane-claims`) prunes the `CapstoneTenant` XR.',
      '2. Crossplane\'s finalizer **cascade-deletes** everything the Composition created:',
      '   the per-env namespaces + all their pods (reclaiming cluster CPU/RAM), the Harbor',
      '   project, the Vault policy/role + tenant secret paths, any provisioned database',
      '   grant, and the tenant\'s ArgoCD ApplicationSet/apps.',
      '',
      '**This is irreversible.** Re-onboarding the same team/app later re-creates a fresh',
      'tenant from scratch (new Harbor project, new Vault paths, empty database).',
      archiveRepo
        ? `\nThe tenant's GitHub app repo (\`${cfg.appRepoOwner}/${appName}\`) has been archived.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  // Optional: archive the tenant's app repo so it goes read-only (kept for the record; the
  // Composition-created repo is NOT git-removed by the claim delete — archive is the tidy-up).
  let repoArchived = false;
  if (archiveRepo && appName) {
    try {
      const appOctokit = await octokitForRepo(
        deps.config,
        cfg.appRepoOwner,
        appName,
      );
      await appOctokit.repos.update({
        owner: cfg.appRepoOwner,
        repo: appName,
        archived: true,
      });
      repoArchived = true;
      deps.logger.info(
        `capstone tenant-teardown archived app repo ${cfg.appRepoOwner}/${appName}`,
      );
    } catch (e) {
      // Non-fatal: the teardown PR is the primary action. Surface a warning, keep going.
      deps.logger.warn(
        `capstone tenant-teardown could not archive ${cfg.appRepoOwner}/${appName}: ` +
          `${(e as Error).message}`,
      );
    }
  }

  deps.logger.info(
    `capstone tenant-teardown opened PR for tenant="${name}": ${pr.html_url}`,
  );
  return { pullRequestUrl: pr.html_url, claimPath, repoArchived };
}

/** Decode a getContent single-file response body to UTF-8 text. */
function decodeContent(data: unknown): string {
  const d = data as { content?: string; encoding?: string };
  if (d.content) {
    return Buffer.from(d.content, 'base64').toString('utf8');
  }
  return '';
}

/**
 * Read a file's UTF-8 content from a branch (or the default branch when `branch` is undefined).
 * Returns undefined for a 404 (file absent).
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
