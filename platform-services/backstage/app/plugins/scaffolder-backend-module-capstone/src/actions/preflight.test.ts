/*
 * Tests for capstone:preflight.
 *
 * Strategy: inject a mock Octokit (no live GitHub App) + a mock GithubCredentialsProvider
 * + a mock CatalogService/AuthService + a ConfigReader with an integrations.github entry,
 * drive repoExists / claimExists / catalogEntryExists / teamClaimConflict / the action
 * handler, and assert:
 *   - each collision check (repo / catalog / claim / team-claim-per-semester) is
 *     independently detected;
 *   - a 404 on the relevant GitHub call means "does not exist" (no collision);
 *   - a non-404 GitHub error is rethrown (never silently treated as "clear");
 *   - the action THROWS a single clear message naming EVERY collision found, and makes
 *     no repo/catalog calls at all when the team/appName/semester is invalid (fail closed);
 *   - on a clean name, the action does NOT throw and calls the GitHub App credentials
 *     provider / Octokit factory the same way commitToMain does (org-scoped, no token input);
 *   - the ONE-CLAIM-PER-TEAM guard (PR #311): emits normally when no existing claim for the
 *     team, FAILS with a dedicated message when a claim for the same team+semester already
 *     exists under a different appName, and allows a different team.
 */
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { ConfigReader } from '@backstage/config';
import {
  catalogEntryExists,
  claimExists,
  createPreflightAction,
  listClaimFiles,
  parseClaimTeamSemester,
  repoExists,
  teamClaimConflict,
  tenantDirExists,
  type OctokitLike,
} from './preflight';

type GetRepoParams = { owner: string; repo: string };
type GetContentParams = { owner: string; repo: string; path: string; ref?: string };

function notFound(): never {
  const e: any = new Error('Not Found');
  e.status = 404;
  throw e;
}

/** A `tenants/_claims/` entry for the mock — rendered into a minimal CapstoneTenant YAML. */
interface MockClaimFile {
  name: string;
  team: string;
  semester: string;
}

function renderMockClaimYaml(f: MockClaimFile): string {
  return [
    'apiVersion: platform.capstone.uamishub.com/v1alpha1',
    'kind: CapstoneTenant',
    'spec:',
    `  team: "${f.team}"`,
    `  semester: "${f.semester}"`,
    '',
  ].join('\n');
}

/**
 * Mock Octokit whose repos.get/getContent either succeed or 404, per the flags given.
 * getContent serves FOUR probes, differentiated by path: the zero-touch claim file
 * (`tenants/_claims/<team>-<appName>.yaml`, the exact-name collision check), the
 * imperative team namespaces dir (`tenants/team-...`), the claims DIRECTORY listing
 * (`tenants/_claims` exactly — the one-claim-per-team guard's scan), and a per-file read
 * of one of `claimsDir`'s entries (their content, base64-encoded, for the same guard).
 */
function mockOctokit(opts: {
  repoExists?: boolean;
  claimExists?: boolean;
  tenantDirExists?: boolean;
  repoError?: unknown;
  claimError?: unknown;
  tenantDirError?: unknown;
  /** Files present under tenants/_claims/ (for the one-claim-per-team guard's directory scan). */
  claimsDir?: MockClaimFile[];
  claimsDirError?: unknown;
}): { octokit: OctokitLike; getRepoCalls: GetRepoParams[]; getContentCalls: GetContentParams[] } {
  const getRepoCalls: GetRepoParams[] = [];
  const getContentCalls: GetContentParams[] = [];
  const octokit: OctokitLike = {
    rest: {
      repos: {
        get: async (params: GetRepoParams) => {
          getRepoCalls.push(params);
          if (opts.repoError) throw opts.repoError;
          if (!opts.repoExists) notFound();
          return { data: {} };
        },
        getContent: async (params: GetContentParams) => {
          getContentCalls.push(params);
          if (params.path === 'tenants/_claims') {
            if (opts.claimsDirError) throw opts.claimsDirError;
            if (!opts.claimsDir || opts.claimsDir.length === 0) notFound();
            return {
              data: opts.claimsDir.map(f => ({
                name: f.name,
                path: `tenants/_claims/${f.name}`,
                type: 'file',
              })),
            };
          }
          const isTeamDir = params.path.startsWith('tenants/team-');
          if (isTeamDir) {
            if (opts.tenantDirError) throw opts.tenantDirError;
            if (!opts.tenantDirExists) notFound();
            return { data: [{ name: 'appproject.yaml' }] };
          }
          const dirMatch = opts.claimsDir?.find(
            f => `tenants/_claims/${f.name}` === params.path,
          );
          if (dirMatch) {
            return {
              data: {
                content: Buffer.from(renderMockClaimYaml(dirMatch)).toString('base64'),
                encoding: 'base64',
              },
            };
          }
          if (opts.claimError) throw opts.claimError;
          if (!opts.claimExists) notFound();
          return { data: { sha: 'abc' } };
        },
      },
    },
  };
  return { octokit, getRepoCalls, getContentCalls };
}

/** Catalog mock whose getEntities returns `items` verbatim and records its call args. */
function mockCatalog(items: unknown[]): { catalog: any; calls: any[] } {
  const calls: any[] = [];
  const catalog = {
    getEntities: jest.fn(async (request: unknown, opts: unknown) => {
      calls.push({ request, opts });
      return { items };
    }),
  };
  return { catalog, calls };
}

const mockAuth: any = {
  getOwnServiceCredentials: jest.fn(async () => ({ token: 'svc' })),
};

describe('repoExists', () => {
  it('true when repos.get succeeds', async () => {
    const { octokit } = mockOctokit({ repoExists: true });
    await expect(repoExists(octokit, 'UA-MIS', 'widgets')).resolves.toBe(true);
  });

  it('false on a 404', async () => {
    const { octokit } = mockOctokit({ repoExists: false });
    await expect(repoExists(octokit, 'UA-MIS', 'widgets')).resolves.toBe(false);
  });

  it('rethrows a non-404 error', async () => {
    const boom: any = new Error('server error');
    boom.status = 500;
    const { octokit } = mockOctokit({ repoError: boom });
    await expect(repoExists(octokit, 'UA-MIS', 'widgets')).rejects.toThrow(/server error/i);
  });
});

describe('claimExists', () => {
  it('true when the claim file is present on main', async () => {
    const { octokit, getContentCalls } = mockOctokit({ claimExists: true });
    await expect(claimExists(octokit, 'UA-MIS', 'acme', 'widgets')).resolves.toBe(true);
    expect(getContentCalls).toEqual([
      {
        owner: 'UA-MIS',
        repo: 'platform-infra',
        path: 'tenants/_claims/acme-widgets.yaml',
        ref: 'main',
      },
    ]);
  });

  it('false on a 404', async () => {
    const { octokit } = mockOctokit({ claimExists: false });
    await expect(claimExists(octokit, 'UA-MIS', 'acme', 'widgets')).resolves.toBe(false);
  });

  it('rethrows a non-404 error', async () => {
    const boom: any = new Error('server error');
    boom.status = 500;
    const { octokit } = mockOctokit({ claimError: boom });
    await expect(claimExists(octokit, 'UA-MIS', 'acme', 'widgets')).rejects.toThrow(/server error/i);
  });
});

describe('tenantDirExists', () => {
  it('true when tenants/team-<team>/ is present on platform-infra main', async () => {
    const { octokit, getContentCalls } = mockOctokit({ tenantDirExists: true });
    await expect(tenantDirExists(octokit, 'UA-MIS', 'acme')).resolves.toBe(true);
    expect(getContentCalls).toEqual([
      { owner: 'UA-MIS', repo: 'platform-infra', path: 'tenants/team-acme', ref: 'main' },
    ]);
  });

  it('false on a 404 (team not yet onboarded)', async () => {
    const { octokit } = mockOctokit({ tenantDirExists: false });
    await expect(tenantDirExists(octokit, 'UA-MIS', 'acme')).resolves.toBe(false);
  });

  it('rethrows a non-404 error', async () => {
    const boom: any = new Error('server error');
    boom.status = 500;
    const { octokit } = mockOctokit({ tenantDirError: boom });
    await expect(tenantDirExists(octokit, 'UA-MIS', 'acme')).rejects.toThrow(/server error/i);
  });
});

describe('parseClaimTeamSemester', () => {
  it('parses team + semester from a rendered CapstoneTenant claim (double-quoted scalars)', () => {
    const yaml = renderMockClaimYaml({ name: 'x', team: 'acme', semester: '2026-fall' });
    expect(parseClaimTeamSemester(yaml)).toEqual({ team: 'acme', semester: '2026-fall' });
  });

  it('parses unquoted scalars too (mirrors the Makefile sed pattern)', () => {
    const yaml = ['spec:', '  team: acme', '  semester: 2026-fall', ''].join('\n');
    expect(parseClaimTeamSemester(yaml)).toEqual({ team: 'acme', semester: '2026-fall' });
  });

  it('returns undefined fields when team/semester are absent', () => {
    expect(parseClaimTeamSemester('spec:\n  appName: "widgets"\n')).toEqual({
      team: undefined,
      semester: undefined,
    });
  });
});

describe('listClaimFiles', () => {
  it('lists the .yaml entries under tenants/_claims/', async () => {
    const { octokit, getContentCalls } = mockOctokit({
      claimsDir: [
        { name: 'acme-otherapp.yaml', team: 'acme', semester: '2026-fall' },
        { name: 'other-team-app.yaml', team: 'other-team', semester: '2026-fall' },
      ],
    });
    await expect(listClaimFiles(octokit, 'UA-MIS')).resolves.toEqual([
      { name: 'acme-otherapp.yaml', path: 'tenants/_claims/acme-otherapp.yaml', type: 'file' },
      { name: 'other-team-app.yaml', path: 'tenants/_claims/other-team-app.yaml', type: 'file' },
    ]);
    expect(getContentCalls).toEqual([
      { owner: 'UA-MIS', repo: 'platform-infra', path: 'tenants/_claims', ref: 'main' },
    ]);
  });

  it('returns [] on a 404 (no claims onboarded yet)', async () => {
    const { octokit } = mockOctokit({});
    await expect(listClaimFiles(octokit, 'UA-MIS')).resolves.toEqual([]);
  });

  it('rethrows a non-404 error', async () => {
    const boom: any = new Error('server error');
    boom.status = 500;
    const { octokit } = mockOctokit({ claimsDirError: boom });
    await expect(listClaimFiles(octokit, 'UA-MIS')).rejects.toThrow(/server error/i);
  });
});

describe('teamClaimConflict', () => {
  it('undefined when the claims dir is empty (nothing onboarded yet)', async () => {
    const { octokit } = mockOctokit({});
    await expect(
      teamClaimConflict(octokit, 'UA-MIS', 'acme', 'widgets', '2026-fall'),
    ).resolves.toBeUndefined();
  });

  it('undefined when no OTHER claim matches this team+semester (a different team is fine)', async () => {
    const { octokit } = mockOctokit({
      claimsDir: [{ name: 'other-team-app.yaml', team: 'other-team', semester: '2026-fall' }],
    });
    await expect(
      teamClaimConflict(octokit, 'UA-MIS', 'acme', 'widgets', '2026-fall'),
    ).resolves.toBeUndefined();
  });

  it('returns the conflicting file when the team already has a claim for this semester under a different appName', async () => {
    const { octokit } = mockOctokit({
      claimsDir: [{ name: 'acme-otherapp.yaml', team: 'acme', semester: '2026-fall' }],
    });
    await expect(
      teamClaimConflict(octokit, 'UA-MIS', 'acme', 'widgets', '2026-fall'),
    ).resolves.toBe('tenants/_claims/acme-otherapp.yaml');
  });

  it('undefined when the team has a claim, but for a DIFFERENT semester', async () => {
    const { octokit } = mockOctokit({
      claimsDir: [{ name: 'acme-otherapp.yaml', team: 'acme', semester: '2025-spring' }],
    });
    await expect(
      teamClaimConflict(octokit, 'UA-MIS', 'acme', 'widgets', '2026-fall'),
    ).resolves.toBeUndefined();
  });

  it('excludes the literal target file itself (an exact-name resubmit is claimExists territory, not this guard)', async () => {
    const { octokit } = mockOctokit({
      claimsDir: [{ name: 'acme-widgets.yaml', team: 'acme', semester: '2026-fall' }],
    });
    await expect(
      teamClaimConflict(octokit, 'UA-MIS', 'acme', 'widgets', '2026-fall'),
    ).resolves.toBeUndefined();
  });
});

describe('catalogEntryExists', () => {
  it('true when a matching Component is found, using the service identity', async () => {
    const { catalog, calls } = mockCatalog([{ kind: 'Component', metadata: { name: 'widgets' } }]);
    await expect(catalogEntryExists(catalog, mockAuth, 'widgets')).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].request).toEqual({
      filter: [{ kind: 'Component', 'metadata.name': 'widgets', 'metadata.namespace': 'default' }],
      fields: ['kind', 'metadata.name', 'metadata.namespace'],
    });
    expect(calls[0].opts).toEqual({ credentials: { token: 'svc' } });
  });

  it('false when no Component matches', async () => {
    const { catalog } = mockCatalog([]);
    await expect(catalogEntryExists(catalog, mockAuth, 'widgets')).resolves.toBe(false);
  });
});

describe('capstone:preflight action', () => {
  function config(): ConfigReader {
    return new ConfigReader({
      integrations: { github: [{ host: 'github.com' }] },
    });
  }

  const credsProvider: any = {
    getCredentials: jest.fn(async () => ({ token: 'ghs_installtoken' })),
  };

  /** Defaults `semester` (now required) so existing collision tests don't all need it explicit. */
  function ctxFor(input: Record<string, unknown>): any {
    return createMockActionContext({ input: { semester: '2026-fall', ...input } } as any);
  }

  beforeEach(() => {
    credsProvider.getCredentials.mockClear();
    mockAuth.getOwnServiceCredentials.mockClear();
  });

  it('does NOT throw on a clean name, and resolves App creds org-scoped (no token input)', async () => {
    const { octokit } = mockOctokit({ repoExists: false, claimExists: false });
    const octokitFactory = jest.fn(() => octokit);
    const { catalog } = mockCatalog([]);
    const action = createPreflightAction({
      config: config(),
      catalog,
      auth: mockAuth,
      githubCredentialsProvider: credsProvider,
      octokitFactory,
    });

    await expect(
      action.handler(ctxFor({ team: 'acme', appName: 'widgets' })),
    ).resolves.not.toThrow();

    expect(credsProvider.getCredentials).toHaveBeenCalledWith({
      url: 'https://github.com/UA-MIS',
    });
    expect(octokitFactory).toHaveBeenCalledWith({
      auth: 'ghs_installtoken',
      baseUrl: 'https://api.github.com',
    });
  });

  it('throws naming ALL collisions when repo + catalog + namespaces + claim all already exist', async () => {
    const { octokit } = mockOctokit({
      repoExists: true,
      claimExists: true,
      tenantDirExists: true,
    });
    const { catalog } = mockCatalog([{ kind: 'Component', metadata: { name: 'widgets' } }]);
    const action = createPreflightAction({
      config: config(),
      catalog,
      auth: mockAuth,
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
    });

    await expect(action.handler(ctxFor({ team: 'acme', appName: 'widgets' }))).rejects.toThrow(
      /already exists.*UA-MIS\/widgets.*catalog entry.*acme-dev\/staging\/prod.*tenants\/_claims\/acme-widgets\.yaml/s,
    );
  });

  it('throws naming just the namespaces when only the team tenant dir collides', async () => {
    const { octokit } = mockOctokit({
      repoExists: false,
      claimExists: false,
      tenantDirExists: true,
    });
    const { catalog } = mockCatalog([]);
    const action = createPreflightAction({
      config: config(),
      catalog,
      auth: mockAuth,
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
    });

    await expect(
      action.handler(ctxFor({ team: 'acme', appName: 'widgets' })),
    ).rejects.toThrow(/acme-dev\/staging\/prod.*tenants\/team-acme\//);
  });

  it('throws naming just the repo when only the GitHub repo collides', async () => {
    const { octokit } = mockOctokit({ repoExists: true, claimExists: false });
    const { catalog } = mockCatalog([]);
    const action = createPreflightAction({
      config: config(),
      catalog,
      auth: mockAuth,
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
    });

    await expect(
      action.handler(ctxFor({ team: 'acme', appName: 'widgets' })),
    ).rejects.toThrow(/UA-MIS\/widgets/);
    await expect(
      action.handler(ctxFor({ team: 'acme', appName: 'widgets' })),
    ).rejects.not.toThrow(/catalog entry/);
  });

  it('throws naming just the catalog entry when only the catalog collides', async () => {
    const { octokit } = mockOctokit({ repoExists: false, claimExists: false });
    const { catalog } = mockCatalog([{ kind: 'Component', metadata: { name: 'widgets' } }]);
    const action = createPreflightAction({
      config: config(),
      catalog,
      auth: mockAuth,
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
    });

    await expect(
      action.handler(ctxFor({ team: 'acme', appName: 'widgets' })),
    ).rejects.toThrow(/catalog entry/);
  });

  it('throws naming just the tenant claim when only the claim collides', async () => {
    const { octokit } = mockOctokit({ repoExists: false, claimExists: true });
    const { catalog } = mockCatalog([]);
    const action = createPreflightAction({
      config: config(),
      catalog,
      auth: mockAuth,
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
    });

    await expect(
      action.handler(ctxFor({ team: 'acme', appName: 'widgets' })),
    ).rejects.toThrow(/tenants\/_claims\/acme-widgets\.yaml/);
  });

  it('fails CLOSED on an invalid team/appName slug — no GitHub or catalog call at all', async () => {
    const { octokit, getRepoCalls, getContentCalls } = mockOctokit({});
    const { catalog, calls } = mockCatalog([]);
    const action = createPreflightAction({
      config: config(),
      catalog,
      auth: mockAuth,
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
    });

    await expect(
      action.handler(ctxFor({ team: 'ACME_Team!', appName: 'widgets' })),
    ).rejects.toThrow(/invalid team slug/i);

    expect(getRepoCalls).toHaveLength(0);
    expect(getContentCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(credsProvider.getCredentials).not.toHaveBeenCalled();
  });

  it('fails CLOSED on an invalid semester — no GitHub or catalog call at all', async () => {
    const { octokit, getRepoCalls, getContentCalls } = mockOctokit({});
    const { catalog, calls } = mockCatalog([]);
    const action = createPreflightAction({
      config: config(),
      catalog,
      auth: mockAuth,
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
    });

    await expect(
      action.handler(ctxFor({ team: 'acme', appName: 'widgets', semester: 'fall-2026' })),
    ).rejects.toThrow(/invalid semester/i);

    expect(getRepoCalls).toHaveLength(0);
    expect(getContentCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(credsProvider.getCredentials).not.toHaveBeenCalled();
  });

  // ONE-CLAIM-PER-TEAM guard (PR #311 — the swami-swamiapp / swami-student3 duplicate-claim
  // incident that cascaded into a Vault outage). capstone:preflight is step 1 of every
  // project/VM wizard, so this fails BEFORE the repo/catalog entry/claim are ever created —
  // no orphaned repo, no duplicate committed to platform-infra main.
  describe('one-claim-per-team guard', () => {
    it('(a) emits normally (does not throw) when the team has no existing claim', async () => {
      const { octokit } = mockOctokit({ repoExists: false, claimExists: false });
      const { catalog } = mockCatalog([]);
      const action = createPreflightAction({
        config: config(),
        catalog,
        auth: mockAuth,
        githubCredentialsProvider: credsProvider,
        octokitFactory: () => octokit,
      });

      await expect(
        action.handler(
          ctxFor({ team: 'swami', appName: 'student3', semester: '2026-fall' }),
        ),
      ).resolves.not.toThrow();
    });

    it('(b) FAILS with a dedicated message when the team already has a claim for the same team+semester under a different appName', async () => {
      const { octokit } = mockOctokit({
        repoExists: false,
        claimExists: false,
        // The live incident: swami-swamiapp already claimed for team=swami, 2026-fall.
        claimsDir: [{ name: 'swami-swamiapp.yaml', team: 'swami', semester: '2026-fall' }],
      });
      const { catalog } = mockCatalog([]);
      const action = createPreflightAction({
        config: config(),
        catalog,
        auth: mockAuth,
        githubCredentialsProvider: credsProvider,
        octokitFactory: () => octokit,
      });

      // A second scaffold for the SAME team, a DIFFERENT app (the duplicate-claim bug).
      await expect(
        action.handler(
          ctxFor({ team: 'swami', appName: 'student3', semester: '2026-fall' }),
        ),
      ).rejects.toThrow(
        /team 'swami' already has a tenant claim \(tenants\/_claims\/swami-swamiapp\.yaml\) for this semester.*ONE app claim per semester.*edit the existing claim or contact platform admins/s,
      );
    });

    it('(c) allows a DIFFERENT team to claim in the same semester', async () => {
      const { octokit } = mockOctokit({
        repoExists: false,
        claimExists: false,
        claimsDir: [{ name: 'swami-swamiapp.yaml', team: 'swami', semester: '2026-fall' }],
      });
      const { catalog } = mockCatalog([]);
      const action = createPreflightAction({
        config: config(),
        catalog,
        auth: mockAuth,
        githubCredentialsProvider: credsProvider,
        octokitFactory: () => octokit,
      });

      await expect(
        action.handler(
          ctxFor({ team: 'other-team', appName: 'widgets', semester: '2026-fall' }),
        ),
      ).resolves.not.toThrow();
    });

    it('wins over a simultaneous name collision, with its own dedicated remediation message', async () => {
      const { octokit } = mockOctokit({
        repoExists: true, // also a plain name collision
        claimExists: false,
        claimsDir: [{ name: 'swami-swamiapp.yaml', team: 'swami', semester: '2026-fall' }],
      });
      const { catalog } = mockCatalog([]);
      const action = createPreflightAction({
        config: config(),
        catalog,
        auth: mockAuth,
        githubCredentialsProvider: credsProvider,
        octokitFactory: () => octokit,
      });

      await expect(
        action.handler(
          ctxFor({ team: 'swami', appName: 'student3', semester: '2026-fall' }),
        ),
      ).rejects.toThrow(/already has a tenant claim/);
      await expect(
        action.handler(
          ctxFor({ team: 'swami', appName: 'student3', semester: '2026-fall' }),
        ),
      ).rejects.not.toThrow(/pick a different name/);
    });
  });

  it('respects a custom `owner` input instead of the UA-MIS default', async () => {
    const { octokit } = mockOctokit({ repoExists: false, claimExists: false });
    const { catalog } = mockCatalog([]);
    const action = createPreflightAction({
      config: config(),
      catalog,
      auth: mockAuth,
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
    });

    await action.handler(ctxFor({ team: 'acme', appName: 'widgets', owner: 'some-other-org' }));

    expect(credsProvider.getCredentials).toHaveBeenCalledWith({
      url: 'https://github.com/some-other-org',
    });
  });
});
