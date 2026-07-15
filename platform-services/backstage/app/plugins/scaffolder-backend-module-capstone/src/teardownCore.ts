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

/**
 * A provisioned tenant = one ledger file — a `_claims` CapstoneTenant claim (container tenant,
 * ADR-031) OR a `_vm-claims` teardown marker (VM tenant, ADR-032a §D5/§D6). `name` is the delete
 * key (file stem) for both kinds.
 */
export interface TenantSummary {
  /** `<team>-<appName>` — the ledger file's basename; the delete key. */
  name: string;
  team: string;
  appName: string;
  semester: string;
  /** Provisioned database engine (none|mysql|postgres) — for display. Container tenants only. */
  database?: string;
  /**
   * Repo-relative path of the PRIMARY ledger file identifying this tenant: the CapstoneTenant
   * claim (`tenants/_claims/<name>.yaml`) for `layout: 'container'`, or the VM teardown marker
   * (`tenants/_vm-claims/<name>.yaml`) for `layout: 'vm'`.
   */
  claimPath: string;
  /**
   * Which onboarding path provisioned this tenant, and therefore which teardown branch applies.
   * `'container'` (also the default when omitted, for back-compat) = the original Crossplane-
   * claim tenants; `'vm'` = a KubeVirt VM tenant onboarded via the `_vm-claims` ledger.
   */
  layout?: 'container' | 'vm';
  /**
   * Every repo-relative path the teardown PR removes. Container = `[claimPath]` (one file). VM =
   * `[markerPath, ...everything under tenants/team-<team>/]`, removed via the Git Trees API
   * (teardownVmTenant) since deleteFile only handles one file at a time.
   */
  teardownPaths: string[];
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
  /** The PR that removes the claim/marker. Merge it to start the reclaim (cascade or prune). */
  pullRequestUrl: string;
  /** The primary ledger file the PR removes (the claim for container; the marker for VM). */
  claimPath: string;
  /** Every repo-relative path the PR removes. Container = `[claimPath]`; VM = marker + tree. */
  teardownPaths: string[];
  /** Whether the GitHub app repo was archived (only when archiveRepo was requested). */
  repoArchived: boolean;
  /**
   * Whether the `capstone-tenant` GitHub topic was stripped from the app repo. This is what
   * makes the catalog GitHub-discovery provider stop re-registering the repo (the "ghost
   * tenant" cure — see teardownTenant). Done UNCONDITIONALLY on teardown (independent of
   * archiveRepo); false only if the repo already lacked the topic or the strip call failed.
   */
  topicStripped: boolean;
}

/**
 * The GitHub topic the catalog discovery provider (app-config catalog.providers.github.tenants)
 * filters on. Every scaffolder template self-tags new tenant repos with it; discovery
 * (re)registers any repo carrying it as a Component Location every cycle. Teardown must strip it
 * so a de-provisioned tenant stops being resurrected.
 */
const CAPSTONE_TENANT_TOPIC = 'capstone-tenant';

/** Resolved capstone.teardown.* config — where the onboarding ledger lives + PR conventions. */
interface TeardownConfig {
  /** GitHub org owning the platform-infra ledger repo. */
  infraRepoOwner: string;
  /** The ledger repo (holds tenants/_claims and tenants/_vm-claims). */
  infraRepoName: string;
  /** Dir under the ledger repo holding the per-tenant CapstoneTenant claim files. */
  claimsDir: string;
  /** Dir under the ledger repo holding the per-VM-tenant teardown marker files (ADR-032a). */
  vmClaimsDir: string;
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
    vmClaimsDir: c?.getOptionalString('vmClaimsDir') ?? 'tenants/_vm-claims',
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

/**
 * Strip the `capstone-tenant` topic from a repo so the catalog GitHub-discovery provider's
 * `topic.include: [capstone-tenant]` filter stops matching it — i.e. discovery stops
 * re-registering the torn-down tenant's Component every cycle ("ghost tenant" cure). Combined
 * with `catalog.orphanStrategy: delete` (app-config), the now-orphaned Component + Location are
 * then pruned automatically instead of lingering forever.
 *
 * PERMISSION: `PUT /repos/{owner}/{repo}/topics` (replaceAllTopics) needs the GitHub App's
 * "Administration" repository permission (write) — the SAME permission `repos.update({archived})`
 * uses, which this module already exercises for archiveRepo, so NO new App grant is required.
 *
 * ORDER: this MUST run BEFORE any archive — an archived repo is READ-ONLY and its topics can no
 * longer be changed. Non-fatal: the claim-removal PR is the primary teardown action; a failure
 * here is logged and returns false (the admin can strip the topic by hand — see the PR body).
 */
async function stripCapstoneTopic(
  deps: CapstoneTenantsDeps,
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.repos.getAllTopics({ owner, repo });
    const names: string[] = data.names ?? [];
    if (!names.includes(CAPSTONE_TENANT_TOPIC)) {
      return false; // nothing to strip (never tagged, or already stripped)
    }
    await octokit.repos.replaceAllTopics({
      owner,
      repo,
      names: names.filter(n => n !== CAPSTONE_TENANT_TOPIC),
    });
    deps.logger.info(
      `capstone tenant-teardown stripped '${CAPSTONE_TENANT_TOPIC}' topic from ${owner}/${repo} ` +
        `(catalog discovery will drop it)`,
    );
    return true;
  } catch (e) {
    deps.logger.warn(
      `capstone tenant-teardown could not strip '${CAPSTONE_TENANT_TOPIC}' topic from ` +
        `${owner}/${repo}: ${(e as Error).message}`,
    );
    return false;
  }
}

/**
 * A file is a LIVE ledger entry iff it ends in .yaml/.yml and is not an `_*`-prefixed sample or
 * README. Shared by both the `_claims` and `_vm-claims` scans (mirrors the ArgoCD/ApplicationSet
 * sync excludes on each dir — see _claims/README and _vm-claims/README).
 */
function isLiveClaimFile(name: string): boolean {
  if (!name.endsWith('.yaml') && !name.endsWith('.yml')) {
    return false;
  }
  return !name.startsWith('_');
}

/** Scan a single scalar field out of a small machine-generated claim/marker YAML (no full parse). */
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
): Omit<TenantSummary, 'claimPath' | 'teardownPaths' | 'layout'> {
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
 * Parse a `_vm-claims/<team>-<app>.yaml` VM teardown marker (ADR-032a §D5, schema documented in
 * `tenants/_vm-claims/README.md` and emitted by the vm-app template's `skeleton-vm-ledger`
 * fragment). All fields are top-level scalars — `scanField` handles it exactly like a claim.
 * `teardownPath` is the `tenants/team-<team>/` tree the teardown PR must additionally remove.
 */
function parseVmMarker(
  fileName: string,
  yaml: string,
): Omit<TenantSummary, 'claimPath' | 'teardownPaths' | 'layout' | 'database'> & {
  teardownPath: string;
} {
  const name = fileName.replace(/\.(ya?ml)$/, '');
  const team = scanField(yaml, 'team') ?? name;
  return {
    name,
    team,
    appName: scanField(yaml, 'appName') ?? name,
    semester: scanField(yaml, 'semester') ?? '',
    teardownPath: scanField(yaml, 'teardownPath') ?? `tenants/team-${team}`,
  };
}

/** Directory listing helper: list `{name,type,path}` entries in `dir`, or `[]` if it 404s (no ledger dir yet). */
async function listDirEntries(
  octokit: Octokit,
  owner: string,
  repo: string,
  dir: string,
): Promise<Array<{ name: string; type: string; path: string }>> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: dir });
    return Array.isArray(data)
      ? (data as Array<{ name: string; type: string; path: string }>)
      : [];
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      return [];
    }
    throw e;
  }
}

/**
 * List every LIVE tenant across BOTH onboarding ledgers:
 *  - `tenants/_claims/*.yaml` — container tenants (Crossplane CapstoneTenant claims, ADR-031);
 *  - `tenants/_vm-claims/*.yaml` — VM tenants (teardown markers, ADR-032a §D5).
 * Both exclude `_*` samples + README (mirrors each dir's own sync exclude). Reads each file to
 * surface team/app/semester(/database) for display, tagging each row's `layout`. ADMIN-ONLY.
 * The ledger file(s) ARE the delete target, so listing ties each row 1:1 to a teardown.
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

  const tenants: TenantSummary[] = [];

  // Container tenants (tenants/_claims) — unchanged behavior.
  const claimEntries = await listDirEntries(
    octokit,
    cfg.infraRepoOwner,
    cfg.infraRepoName,
    cfg.claimsDir,
  );
  for (const entry of claimEntries) {
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
    tenants.push({
      ...parseClaim(entry.name, text),
      claimPath: entry.path,
      layout: 'container',
      teardownPaths: [entry.path],
    });
  }

  // VM tenants (tenants/_vm-claims) — ADR-032a §D5/§D6.
  const vmEntries = await listDirEntries(
    octokit,
    cfg.infraRepoOwner,
    cfg.infraRepoName,
    cfg.vmClaimsDir,
  );
  for (const entry of vmEntries) {
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
    const { teardownPath, ...marker } = parseVmMarker(entry.name, text);
    tenants.push({
      ...marker,
      claimPath: entry.path,
      layout: 'vm',
      teardownPaths: [entry.path, teardownPath],
    });
  }

  tenants.sort((a, b) => a.name.localeCompare(b.name));
  return tenants;
}

/** A ledger file already fetched from the base branch, ready to be deleted. */
interface ExistingLedgerFile {
  sha: string;
  content: string;
}

/** Fetch a single file's sha+content from `ref`, or `undefined` on a 404 (file absent). */
async function getExistingFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<ExistingLedgerFile | undefined> {
  const existing = await octokit.repos
    .getContent({ owner, repo, path, ref })
    .catch((e: { status?: number }) => {
      if (e.status === 404) {
        return undefined;
      }
      throw e;
    });
  if (!existing || Array.isArray(existing.data) || !('sha' in existing.data)) {
    return undefined;
  }
  return { sha: existing.data.sha, content: decodeContent(existing.data) };
}

/**
 * Post-PR app-repo tidy-up shared by both teardown branches (the Composition/scaffolder-created
 * app repo is NOT git-removed by the ledger-file delete). TWO actions, in a fixed order because
 * an archived repo is READ-ONLY:
 *   1. ALWAYS strip the `capstone-tenant` topic so catalog GitHub-discovery stops re-registering
 *      the Component ("ghost tenant" cure). Independent of archiveRepo — the ghost recurs on
 *      every teardown, archived or not, so untag is unconditional.
 *   2. OPTIONALLY archive the repo (read-only, kept for the record) when archiveRepo is set.
 * Both are non-fatal: the ledger-removal PR is the primary teardown action.
 */
async function tidyAppRepo(
  deps: CapstoneTenantsDeps,
  cfg: TeardownConfig,
  appName: string | undefined,
  archiveRepo: boolean | undefined,
): Promise<{ topicStripped: boolean; repoArchived: boolean }> {
  let topicStripped = false;
  let repoArchived = false;
  if (appName) {
    const appOctokit = await octokitForRepo(deps.config, cfg.appRepoOwner, appName);
    // MUST precede archive — topics can't be changed once the repo is archived (read-only).
    topicStripped = await stripCapstoneTopic(deps, appOctokit, cfg.appRepoOwner, appName);
    if (archiveRepo) {
      try {
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
  }
  return { topicStripped, repoArchived };
}

/**
 * Tear down a CONTAINER tenant: open a PR against platform-infra that REMOVES its one claim file
 * (`tenants/_claims/<name>.yaml`). On merge, ArgoCD prunes the XR and Crossplane cascade-deletes
 * the whole tenant. Unchanged behavior from the pre-VM-teardown implementation.
 */
async function teardownContainerTenant(
  deps: CapstoneTenantsDeps,
  octokit: Octokit,
  cfg: TeardownConfig,
  baseBranch: string,
  name: string,
  claimPath: string,
  claimFile: ExistingLedgerFile,
  archiveRepo: boolean | undefined,
): Promise<TeardownResult> {
  const appName = parseClaim(`${name}.yaml`, claimFile.content).appName;

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
    sha: claimFile.sha,
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
      '',
      `The \`${CAPSTONE_TENANT_TOPIC}\` topic has been stripped from the tenant's GitHub app repo`,
      `(\`${cfg.appRepoOwner}/${appName}\`) so the catalog discovery provider stops re-registering`,
      "its Component (with `catalog.orphanStrategy: delete`, the orphaned entity is then pruned",
      'automatically). If the strip failed — check the teardown logs — remove the topic by hand:',
      '`gh api -X PUT repos/' +
        `${cfg.appRepoOwner}/${appName}` +
        '/topics -f names[]=""` (with the repo\'s remaining topics).',
      archiveRepo ? `\nThe app repo has also been archived.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const { topicStripped, repoArchived } = await tidyAppRepo(deps, cfg, appName, archiveRepo);

  deps.logger.info(
    `capstone tenant-teardown opened PR for tenant="${name}": ${pr.html_url}`,
  );
  return {
    pullRequestUrl: pr.html_url,
    claimPath,
    teardownPaths: [claimPath],
    repoArchived,
    topicStripped,
  };
}

/**
 * Tear down a VM tenant (ADR-032a §D5/§D6): open a PR against platform-infra that REMOVES the
 * `_vm-claims/<name>.yaml` marker AND every file under the marker's `teardownPath`
 * (`tenants/team-<team>/`) — the appset/appproject/namespace tree the VM tenant deploys from.
 * `deleteFile` only handles one file per commit, so this uses the Git Trees API: read the base
 * tree, build a new tree with every blob under `teardownPath/` plus the marker blob removed
 * (`sha: null`), commit it once, and point the teardown branch at that commit.
 *
 * On merge: the `tenants` ApplicationSet (directory generator) drops the `tenant-<team>`
 * bootstrap App -> ArgoCD prunes the VM AppProject + `<team>-vm-envs` ApplicationSet +
 * `<team>-vm-prod` namespace -> namespace GC deletes the VM/DataVolume and reclaims the rootdisk
 * PVC (`ceph-block` is `reclaimPolicy: Delete`, so the RBD image is freed, no orphan).
 */
async function teardownVmTenant(
  deps: CapstoneTenantsDeps,
  octokit: Octokit,
  cfg: TeardownConfig,
  baseBranch: string,
  name: string,
  markerPath: string,
  markerFile: ExistingLedgerFile,
  archiveRepo: boolean | undefined,
): Promise<TeardownResult> {
  const { appName, teardownPath } = parseVmMarker(`${name}.yaml`, markerFile.content);

  const { data: baseRef } = await octokit.git.getRef({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    ref: `heads/${baseBranch}`,
  });
  const baseCommitSha = baseRef.object.sha;
  const { data: baseCommit } = await octokit.git.getCommit({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    commit_sha: baseCommitSha,
  });
  const baseTreeSha = baseCommit.tree.sha;

  // Enumerate the WHOLE repo tree recursively so every file under teardownPath/ is found no
  // matter how deeply nested (README.md, vm/*.yaml, vm/namespaces/*.yaml, ...).
  const { data: fullTree } = await octokit.git.getTree({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    tree_sha: baseTreeSha,
    recursive: 'true',
  });
  if (fullTree.truncated) {
    // Fail closed rather than silently remove a PARTIAL tree and orphan the rest.
    throw new Error(
      `capstone tenant-teardown: GitHub truncated the recursive tree listing for ` +
        `${cfg.infraRepoOwner}/${cfg.infraRepoName}; cannot safely enumerate ${teardownPath}/ ` +
        'for VM teardown. Aborting instead of risking an orphaned partial removal.',
    );
  }

  const treeDirPrefix = `${teardownPath}/`;
  const teardownPaths = Array.from(
    new Set<string>([
      markerPath,
      ...fullTree.tree
        .filter(
          (entry): entry is typeof entry & { path: string } =>
            entry.type === 'blob' &&
            typeof entry.path === 'string' &&
            entry.path.startsWith(treeDirPrefix),
        )
        .map(entry => entry.path),
    ]),
  );

  const { data: newTree } = await octokit.git.createTree({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    base_tree: baseTreeSha,
    tree: teardownPaths.map(path => ({
      path,
      mode: '100644' as const,
      type: 'blob' as const,
      sha: null,
    })),
  });

  const { data: newCommit } = await octokit.git.createCommit({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    message: `chore(teardown): de-provision VM tenant ${name}`,
    tree: newTree.sha,
    parents: [baseCommitSha],
  });

  const branch = `${cfg.branchPrefix}${name}-${Date.now()}`;
  await octokit.git.createRef({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    ref: `refs/heads/${branch}`,
    sha: newCommit.sha,
  });

  const { data: pr } = await octokit.pulls.create({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
    base: baseBranch,
    head: branch,
    title: `chore(teardown): de-provision VM tenant ${name}`,
    body: [
      `Removes the VM-tenant teardown marker \`${markerPath}\` **and** the \`${teardownPath}/\``,
      `tree (${teardownPaths.length} file(s) total) — the entire per-VM-tenant onboarding`,
      `artifact for **${name}** (ADR-032a §D5).`,
      '',
      '**On merge (this is when resources are actually freed):**',
      '',
      '1. The `tenants` ApplicationSet (directory generator) drops the `tenant-<team>`',
      '   bootstrap App.',
      '2. ArgoCD prunes the VM `AppProject`, the `<team>-vm-envs` ApplicationSet, and the',
      '   `<team>-vm-prod` Application — deleting the `VirtualMachine`, `DataVolume`,',
      '   `Service`, `Ingress`, cloud-init `Secret`, and the tenant namespace.',
      '3. Namespace GC then deletes the rootdisk PVC; `ceph-block` is `reclaimPolicy: Delete`,',
      '   so the RBD image is freed — no orphaned disk.',
      '',
      '**This is irreversible.** Re-onboarding the same team later re-creates a fresh VM from',
      'scratch (new disk, empty state — the pet is gone).',
      '',
      `The \`${CAPSTONE_TENANT_TOPIC}\` topic has been stripped from the tenant's GitHub app repo`,
      `(\`${cfg.appRepoOwner}/${appName}\`) so the catalog discovery provider stops re-registering`,
      "its Component (with `catalog.orphanStrategy: delete`, the orphaned entity is then pruned",
      'automatically). If the strip failed — check the teardown logs — remove the topic by hand:',
      '`gh api -X PUT repos/' +
        `${cfg.appRepoOwner}/${appName}` +
        '/topics -f names[]=""` (with the repo\'s remaining topics).',
      archiveRepo ? `\nThe app repo has also been archived.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const { topicStripped, repoArchived } = await tidyAppRepo(deps, cfg, appName, archiveRepo);

  deps.logger.info(
    `capstone tenant-teardown opened PR for VM tenant="${name}": ${pr.html_url} ` +
      `(${teardownPaths.length} file(s) removed)`,
  );
  return {
    pullRequestUrl: pr.html_url,
    claimPath: markerPath,
    teardownPaths,
    repoArchived,
    topicStripped,
  };
}

/**
 * Tear down a tenant: open a PR against platform-infra that removes its ledger entry/entries.
 * Dispatches on which ledger the tenant `name` is found in:
 *  - `tenants/_claims/<name>.yaml` exists -> CONTAINER teardown (single-file delete, unchanged).
 *  - else `tenants/_vm-claims/<name>.yaml` exists -> VM teardown (marker + team tree, Trees API).
 *  - else -> NotFoundError (fail closed — never open an empty PR for a typo'd/non-existent
 *    tenant).
 * Optionally archives the tenant's GitHub app repo (UA-MIS/<appName>). Nothing is destroyed
 * until the PR merges — the returned URL is where the admin completes the teardown. ADMIN-ONLY;
 * the type-to-confirm `confirmName` MUST equal `name` (fails closed on mismatch).
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
  const { data: repoInfo } = await octokit.repos.get({
    owner: cfg.infraRepoOwner,
    repo: cfg.infraRepoName,
  });
  const baseBranch = repoInfo.default_branch;

  const claimPath = `${cfg.claimsDir}/${name}.yaml`;
  const claimFile = await getExistingFile(
    octokit,
    cfg.infraRepoOwner,
    cfg.infraRepoName,
    claimPath,
    baseBranch,
  );
  if (claimFile) {
    return teardownContainerTenant(
      deps,
      octokit,
      cfg,
      baseBranch,
      name,
      claimPath,
      claimFile,
      archiveRepo,
    );
  }

  const markerPath = `${cfg.vmClaimsDir}/${name}.yaml`;
  const markerFile = await getExistingFile(
    octokit,
    cfg.infraRepoOwner,
    cfg.infraRepoName,
    markerPath,
    baseBranch,
  );
  if (markerFile) {
    return teardownVmTenant(
      deps,
      octokit,
      cfg,
      baseBranch,
      name,
      markerPath,
      markerFile,
      archiveRepo,
    );
  }

  throw new NotFoundError(
    `No tenant claim or VM marker found for '${name}' (checked ${claimPath} and ${markerPath}); ` +
      'nothing to tear down (already removed?).',
  );
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
