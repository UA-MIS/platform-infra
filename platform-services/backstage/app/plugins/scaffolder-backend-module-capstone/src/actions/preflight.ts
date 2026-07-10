/*
 * capstone:preflight — FAIL FAST + CLEAN on a project-name collision, BEFORE any
 * destructive scaffold step runs.
 *
 * WHY THIS ACTION EXISTS (the swamiapp lesson): a prior "New Project" run for an
 * already-taken app name got PAST compose/publish — creating the GitHub repo and
 * rendering code — and only failed at the `register` step, when the catalog rejected
 * the Location as a 409 (already registered). That left an orphaned repo with no
 * catalog entry and no tenant claim, and the student saw an opaque mid-run failure
 * instead of a clear "pick a different name" message up front. This action is step 1
 * of every project/VM wizard (before compose/fetch/publish/register): it checks the
 * FOUR places a name collision can hide and throws one clear, user-facing error if any
 * of them already exist, so nothing is created at all on a collision.
 *
 * WHAT IT CHECKS (all four, so the error message names every place that collides —
 * not just the first one hit):
 *   1. the target GitHub repo `<owner>/<appName>` (does publish:github's create fail?)
 *   2. the catalog entry for it (does catalog:register's Location fail?) — checked as
 *      the Component entity `component:default/<appName>` the register step would
 *      produce; if that entity exists, its backing Location already exists too.
 *   3. the team's NAMESPACES — checked as the imperative onboarding marker
 *      `tenants/team-<team>/` on `<owner>/platform-infra` main. That directory is what
 *      the tenants-appset git generator reconciles into the team's `<team>-dev`,
 *      `<team>-staging`, and `<team>-prod` namespaces (+ AppProject/RBAC/quota), so its
 *      presence means the team is already onboarded and those namespaces already exist.
 *      GIT is the source of truth (ArgoCD reconciles namespaces FROM it), so this is a
 *      more reliable — and lower-trust — signal than querying the live cluster: it reuses
 *      the already-wired GitHub App and needs NO cluster credentials in this web-facing
 *      backend (the same blast-radius concern harborOnboard calls out).
 *   4. the tenant claim `tenants/_claims/<team>-<appName>.yaml` on `<owner>/platform-infra`
 *      main (does the zero-touch claim-emit/commit step collide with a prior claim?)
 *   5. ONE-CLAIM-PER-TEAM (the 2026-07-09 incident, PR #311): does this TEAM already have
 *      ANY CapstoneTenant claim for this semester, under a DIFFERENT appName? `emitTenant-
 *      Claim.ts` + `commitToMain.ts` had NO such check — a second `capstone:emit-tenant-
 *      claim` run for the same team just wrote a second `tenants/_claims/<team>-<other-
 *      app>.yaml` file straight onto main (no PR, no review). Two CapstoneTenant XRs then
 *      co-managed the same team-keyed namespaces/netpols/quotas; when their rendered specs
 *      diverged, the provider-kubernetes reconcile loops fought over the objects every
 *      30-60s, which cascaded into a Vault raft-leader fsync stall (full root cause in PR
 *      #311). `make validate`'s claim-uniqueness guard (also PR #311) catches this AFTER
 *      the fact in CI; this is the scaffolder-side guard that stops it from ever being
 *      committed in the first place. It scans `tenants/_claims/*.yaml` on
 *      `<owner>/platform-infra` main for any OTHER file whose `spec.team`+`spec.semester`
 *      match this run's — the EXACT team+semester key `make validate` uses (mirrored so the
 *      two guards can never disagree) — and fails closed with a dedicated, actionable error
 *      if one is found (see `teamClaimConflict`).
 *
 * AUTH: same model as capstone:commit-to-main / publish:github — NO token input. The
 * GitHub App installation token is resolved from `integrations.github` via
 * DefaultGithubCredentialsProvider. Read-only calls only (repos.get, repos.getContent,
 * catalog.getEntities) — this action creates and deletes nothing.
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { AuthService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
  type GithubCredentialsProvider,
} from '@backstage/integration';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { Octokit } from '@octokit/rest';

/** Team/github-team slug (mirrors harborOnboard's SLUG / the templates' `team` pattern). */
const TEAM_SLUG = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
/** App slug — DNS-1123 label (mirrors the templates' `appName` pattern). */
const APP_SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** Semester slug `YYYY-(spring|summer|fall)` (mirrors emitTenantClaim's SEMESTER pattern). */
const SEMESTER = /^[0-9]{4}-(spring|summer|fall)$/;

/** Default org — matches the templates' hardcoded `owner=UA-MIS` publish target. */
export const DEFAULT_OWNER = 'UA-MIS';
/** The platform repo the zero-touch tenant claim lands on. */
const CLAIMS_REPO = 'platform-infra';

/**
 * The minimal Octokit surface this action uses — a read on the target repo and a read
 * on the claim file. Declared as an interface (not the full Octokit type) so the checks
 * are unit-testable with a hand-rolled mock, like commitToMain's OctokitLike.
 */
export interface OctokitLike {
  rest: {
    repos: {
      get(params: { owner: string; repo: string }): Promise<{ data: unknown }>;
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref?: string;
      }): Promise<{ data: unknown }>;
    };
  };
}

/** Factory for an authenticated Octokit — injectable so tests skip the real GitHub App. */
export type OctokitFactory = (opts: {
  auth: string;
  baseUrl?: string;
}) => OctokitLike;

/** true if an Octokit error is a 404 (the thing being probed does not exist). */
function isNotFound(err: unknown): boolean {
  return (err as { status?: number } | undefined)?.status === 404;
}

/** Re-validate the slugs before making any network call (fail closed, mirrors harborOnboard/emitTenantClaim). */
function assertSlugs(team: string, appName: string, semester: string): void {
  if (!TEAM_SLUG.test(team)) {
    throw new Error(
      `capstone:preflight: invalid team slug '${team}' — must match ${TEAM_SLUG}.`,
    );
  }
  if (!APP_SLUG.test(appName)) {
    throw new Error(
      `capstone:preflight: invalid app name '${appName}' — must match ${APP_SLUG}.`,
    );
  }
  if (!SEMESTER.test(semester)) {
    throw new Error(
      `capstone:preflight: invalid semester '${semester}' — must match ${SEMESTER} ` +
        '(e.g. 2026-fall).',
    );
  }
}

/** true if `<owner>/<repo>` already exists on GitHub. */
export async function repoExists(
  octokit: OctokitLike,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    await octokit.rest.repos.get({ owner, repo });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** true if `tenants/_claims/<team>-<appName>.yaml` already exists on `<owner>/platform-infra` main. */
export async function claimExists(
  octokit: OctokitLike,
  owner: string,
  team: string,
  appName: string,
): Promise<boolean> {
  try {
    await octokit.rest.repos.getContent({
      owner,
      repo: CLAIMS_REPO,
      path: `tenants/_claims/${team}-${appName}.yaml`,
      ref: 'main',
    });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * true if the team's imperative onboarding dir `tenants/team-<team>/` already exists on
 * `<owner>/platform-infra` main. That dir is what the tenants-appset git generator
 * reconciles into the team's `<team>-dev`/`<team>-staging`/`<team>-prod` namespaces, so
 * its presence is the git-source-of-truth signal that the team is already onboarded and
 * those namespaces already exist. A directory `getContent` returns 200 (an array) when
 * present and 404 when absent — same not-found handling as the repo/claim probes.
 */
export async function tenantDirExists(
  octokit: OctokitLike,
  owner: string,
  team: string,
): Promise<boolean> {
  try {
    await octokit.rest.repos.getContent({
      owner,
      repo: CLAIMS_REPO,
      path: `tenants/team-${team}`,
      ref: 'main',
    });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** One entry from a `tenants/_claims/` directory listing (GitHub contents API, dir form). */
interface ClaimFileEntry {
  name: string;
  path: string;
  type?: string;
}

/**
 * List the `.yaml` claim files under `tenants/_claims/` on `<owner>/platform-infra` main.
 * Returns `[]` if the directory does not exist yet (404 — no claims onboarded at all,
 * so there can be no team-claim conflict). A non-404 error is rethrown (fail closed).
 */
export async function listClaimFiles(
  octokit: OctokitLike,
  owner: string,
): Promise<ClaimFileEntry[]> {
  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo: CLAIMS_REPO,
      path: 'tenants/_claims',
      ref: 'main',
    });
    const data = res.data;
    if (!Array.isArray(data)) return [];
    return (data as ClaimFileEntry[]).filter(
      e => e.type !== 'dir' && e.name.endsWith('.yaml'),
    );
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/** Decode a GitHub file-content response body (base64) to a UTF-8 string. */
function decodeFileContent(data: unknown): string {
  const content = (data as { content?: string }).content;
  if (!content) return '';
  return Buffer.from(content, 'base64').toString('utf8');
}

/**
 * Parse the `spec.team` / `spec.semester` scalar values out of a rendered CapstoneTenant
 * claim YAML. Mirrors the Makefile `validate` claim-uniqueness guard's sed extraction (PR
 * #311, the `team:`/`semester:` capture-group sed one-liners in the Makefile's claim-
 * uniqueness target) EXACTLY — same 2-space indent, same optional-double-quote scalar,
 * same charset — so this scaffolder-side guard and the git-side `make validate` guard key
 * on the identical team+semester pair and can never disagree. Exported for unit tests.
 */
export function parseClaimTeamSemester(yaml: string): {
  team?: string;
  semester?: string;
} {
  const teamMatch = /^ {2}team: *"?([A-Za-z0-9-]+)"?/m.exec(yaml);
  const semesterMatch = /^ {2}semester: *"?([A-Za-z0-9-]+)"?/m.exec(yaml);
  return { team: teamMatch?.[1], semester: semesterMatch?.[1] };
}

/**
 * true (returning the conflicting file's repo-relative path) if the TEAM already has a
 * CapstoneTenant claim for this semester under a DIFFERENT appName — the ONE-CLAIM-PER-
 * TEAM guard (PR #311 incident). Excludes the literal target file `<team>-<appName>.yaml`
 * itself: an exact-name resubmit is already reported by `claimExists`, above, so the two
 * checks don't both fire on the same file with overlapping messages. Lists the claims
 * directory once, then reads each OTHER file to check its team+semester — read-only,
 * mirrors the Makefile guard's key exactly (see `parseClaimTeamSemester`).
 */
export async function teamClaimConflict(
  octokit: OctokitLike,
  owner: string,
  team: string,
  appName: string,
  semester: string,
): Promise<string | undefined> {
  const targetFile = `${team}-${appName}.yaml`;
  const files = await listClaimFiles(octokit, owner);
  for (const file of files) {
    if (file.name === targetFile) continue;
    const res = await octokit.rest.repos.getContent({
      owner,
      repo: CLAIMS_REPO,
      path: file.path,
      ref: 'main',
    });
    const { team: fileTeam, semester: fileSemester } = parseClaimTeamSemester(
      decodeFileContent(res.data),
    );
    if (fileTeam === team && fileSemester === semester) {
      return file.path;
    }
  }
  return undefined;
}

/**
 * true if the catalog already has a Component named `appName` in the default namespace
 * — i.e. the entity `catalog:register` would produce for a fresh scaffold. If that
 * entity is present, the Location that backs it is already registered too, so this is
 * the practical equivalent of "the catalog Location for it already exists".
 */
export async function catalogEntryExists(
  catalog: CatalogService,
  auth: AuthService,
  appName: string,
): Promise<boolean> {
  const serviceCreds = await auth.getOwnServiceCredentials();
  const { items } = await catalog.getEntities(
    {
      filter: [
        { kind: 'Component', 'metadata.name': appName, 'metadata.namespace': 'default' },
      ],
      fields: ['kind', 'metadata.name', 'metadata.namespace'],
    },
    { credentials: serviceCreds },
  );
  return items.length > 0;
}

/** Services the action handler needs, injected from the module's registerInit. */
export interface PreflightActionDeps {
  config: Config;
  catalog: CatalogService;
  auth: AuthService;
  /** Override the GitHub credentials provider (tests). Defaults to the App/token provider. */
  githubCredentialsProvider?: GithubCredentialsProvider;
  /** Injectable Octokit factory (tests). Defaults to a real @octokit/rest client. */
  octokitFactory?: OctokitFactory;
}

/**
 * Factory for the `capstone:preflight` action. Takes its deps so the module wires
 * config/catalog/auth in at registration, keeping the checks unit-testable with mocks.
 */
export function createPreflightAction(deps: PreflightActionDeps) {
  const { config, catalog, auth } = deps;
  const integrations = ScmIntegrations.fromConfig(config);
  const credentialsProvider =
    deps.githubCredentialsProvider ??
    DefaultGithubCredentialsProvider.fromIntegrations(integrations);
  const octokitFactory: OctokitFactory =
    deps.octokitFactory ??
    (opts =>
      new Octokit({
        auth: opts.auth,
        baseUrl: opts.baseUrl,
        userAgent: 'capstone-scaffolder',
      }) as unknown as OctokitLike);

  return createTemplateAction({
    id: 'capstone:preflight',
    description:
      'Fail fast, before any repo/catalog/namespace/claim is created, if a project with ' +
      'this name already exists (GitHub repo, catalog entry, the team namespaces via ' +
      'tenants/team-<team>/, or a zero-touch tenant claim), OR if the team already has a ' +
      'tenant claim for this semester under a different app name (one claim per team ' +
      'per semester — PR #311). Read-only.',
    schema: {
      input: {
        team: z =>
          z.string({
            description: 'Team slug (the canonical D-026 slug, e.g. as onboarded).',
          }),
        appName: z =>
          z.string({
            description:
              'App name / repo slug you want to scaffold — checked for collisions.',
          }),
        semester: z =>
          z.string({
            description:
              'Cohort slug YYYY-(spring|summer|fall) — used to key the one-claim-per-' +
              'team-per-semester guard (mirrors make validate, PR #311).',
          }),
        owner: z =>
          z
            .string({
              description: `GitHub org that owns both the app repo and platform-infra. Defaults to '${DEFAULT_OWNER}'.`,
            })
            .optional(),
      },
    },

    async handler(ctx) {
      const { team, appName, semester } = ctx.input;
      const owner = ctx.input.owner ?? DEFAULT_OWNER;

      assertSlugs(team, appName, semester);

      const { token } = await credentialsProvider.getCredentials({
        url: `https://github.com/${owner}`,
      });
      if (!token) {
        throw new Error(
          'capstone:preflight: no GitHub credentials for github.com — is ' +
            'integrations.github configured with the platform App?',
        );
      }
      const apiBaseUrl = integrations.github.byHost('github.com')?.config.apiBaseUrl;
      const octokit = octokitFactory({ auth: token, baseUrl: apiBaseUrl });

      const [hasRepo, hasCatalogEntry, hasNamespaces, hasClaim, teamConflictFile] =
        await Promise.all([
          repoExists(octokit, owner, appName),
          catalogEntryExists(catalog, auth, appName),
          tenantDirExists(octokit, owner, team),
          claimExists(octokit, owner, team, appName),
          teamClaimConflict(octokit, owner, team, appName, semester),
        ]);

      // ONE-CLAIM-PER-TEAM (PR #311): a dedicated, earlier failure — separate from the
      // name-collision block below — because the remediation is different ("edit the
      // existing claim", not "pick a different name"). Checked first so it wins even if a
      // name-collision also happens to be true.
      if (teamConflictFile) {
        ctx.logger.error(
          `capstone:preflight: team '${team}' already has a tenant claim ` +
            `(${teamConflictFile}) for semester '${semester}'.`,
        );
        throw new Error(
          `team '${team}' already has a tenant claim (${teamConflictFile}) for this ` +
            `semester ('${semester}') — a team gets ONE app claim per semester; edit ` +
            'the existing claim or contact platform admins.',
        );
      }

      const collisions: string[] = [];
      if (hasRepo) collisions.push(`the GitHub repo ${owner}/${appName}`);
      if (hasCatalogEntry) collisions.push('a catalog entry');
      if (hasNamespaces)
        collisions.push(
          `the team's namespaces (${team}-dev/staging/prod — tenants/team-${team}/)`,
        );
      if (hasClaim) collisions.push(`a tenant claim (tenants/_claims/${team}-${appName}.yaml)`);

      if (collisions.length > 0) {
        ctx.logger.error(
          `capstone:preflight: collision on '${appName}' — ${collisions.join(', ')}.`,
        );
        throw new Error(
          `A project named '${appName}' already exists (${collisions.join(', ')}) — ` +
            'pick a different name, or clean up the previous one first.',
        );
      }

      ctx.logger.info(`capstone:preflight: '${appName}' is clear — no repo/catalog/claim collision.`);
    },
  });
}
