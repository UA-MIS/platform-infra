/*
 * Tests for capstone:preflight.
 *
 * Strategy: inject a mock Octokit (no live GitHub App) + a mock GithubCredentialsProvider
 * + a mock CatalogService/AuthService + a ConfigReader with an integrations.github entry,
 * drive repoExists / claimExists / catalogEntryExists / the action handler, and assert:
 *   - each collision check (repo / catalog / claim) is independently detected;
 *   - a 404 on the relevant GitHub call means "does not exist" (no collision);
 *   - a non-404 GitHub error is rethrown (never silently treated as "clear");
 *   - the action THROWS a single clear message naming EVERY collision found, and makes
 *     no repo/catalog calls at all when the team/appName slug is invalid (fail closed);
 *   - on a clean name, the action does NOT throw and calls the GitHub App credentials
 *     provider / Octokit factory the same way commitToMain does (org-scoped, no token input).
 */
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { ConfigReader } from '@backstage/config';
import {
  catalogEntryExists,
  claimExists,
  createPreflightAction,
  repoExists,
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

/**
 * Mock Octokit whose repos.get/getContent either succeed or 404, per the flags given.
 * getContent serves TWO probes, differentiated by path: the zero-touch claim file
 * (`tenants/_claims/...`) and the imperative team namespaces dir (`tenants/team-...`).
 */
function mockOctokit(opts: {
  repoExists?: boolean;
  claimExists?: boolean;
  tenantDirExists?: boolean;
  repoError?: unknown;
  claimError?: unknown;
  tenantDirError?: unknown;
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
          const isTeamDir = params.path.startsWith('tenants/team-');
          if (isTeamDir) {
            if (opts.tenantDirError) throw opts.tenantDirError;
            if (!opts.tenantDirExists) notFound();
            return { data: [{ name: 'appproject.yaml' }] };
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

  function ctxFor(input: Record<string, unknown>): any {
    return createMockActionContext({ input } as any);
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
