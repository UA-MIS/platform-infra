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
function assertSlugs(team: string, appName: string): void {
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
      'tenants/team-<team>/, or a zero-touch tenant claim). Read-only.',
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
        owner: z =>
          z
            .string({
              description: `GitHub org that owns both the app repo and platform-infra. Defaults to '${DEFAULT_OWNER}'.`,
            })
            .optional(),
      },
    },

    async handler(ctx) {
      const { team, appName } = ctx.input;
      const owner = ctx.input.owner ?? DEFAULT_OWNER;

      assertSlugs(team, appName);

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

      const [hasRepo, hasCatalogEntry, hasNamespaces, hasClaim] = await Promise.all([
        repoExists(octokit, owner, appName),
        catalogEntryExists(catalog, auth, appName),
        tenantDirExists(octokit, owner, team),
        claimExists(octokit, owner, team, appName),
      ]);

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
