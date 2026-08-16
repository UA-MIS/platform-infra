/*
 * Tests for capstone:wait-for-repo-content (FIX-19/CATALOG-001).
 *
 * Strategy: inject a mock Octokit (no live GitHub App) + a mock GithubCredentialsProvider
 * + a ConfigReader with an integrations.github entry + an injectable `sleep` (so backoff
 * tests run instantly instead of waiting on real timers), drive `waitForContent` directly
 * for the retry/backoff/error-shape logic, and drive the action handler for the
 * credentials/Octokit-factory wiring + output, mirroring preflight.test.ts's pattern.
 */
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { ConfigReader } from '@backstage/config';
import {
  createWaitForRepoContentAction,
  isNotFound,
  waitForContent,
  type OctokitLike,
} from './waitForRepoContent';

function notFound(): never {
  const e: any = new Error('Not Found');
  e.status = 404;
  throw e;
}

describe('isNotFound', () => {
  it('true for a 404-shaped error', () => {
    const e: any = new Error('nope');
    e.status = 404;
    expect(isNotFound(e)).toBe(true);
  });

  it('false for a non-404 error', () => {
    const e: any = new Error('server error');
    e.status = 500;
    expect(isNotFound(e)).toBe(false);
  });

  it('false for undefined/non-error input', () => {
    expect(isNotFound(undefined)).toBe(false);
    expect(isNotFound({})).toBe(false);
  });
});

describe('waitForContent', () => {
  const params = { owner: 'UA-MIS', repo: 'widgets', path: 'catalog-info.yaml', ref: 'abc123' };

  function mockOctokit(getContent: (...args: any[]) => Promise<{ data: unknown }>): OctokitLike {
    return { rest: { repos: { getContent } } };
  }

  it('succeeds on the first attempt with no retries and no sleep', async () => {
    const getContent = jest.fn(async () => ({ data: { sha: 'x' } }));
    const octokit = mockOctokit(getContent);
    const sleep = jest.fn(async () => {});

    await expect(
      waitForContent(octokit, params, {
        maxAttempts: 8,
        initialDelayMs: 500,
        maxDelayMs: 8_000,
        sleep,
      }),
    ).resolves.toEqual({ attempts: 1 });

    expect(getContent).toHaveBeenCalledTimes(1);
    expect(getContent).toHaveBeenCalledWith(params);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on 404 with exponential backoff, then succeeds', async () => {
    let calls = 0;
    const getContent = jest.fn(async () => {
      calls += 1;
      if (calls < 4) notFound();
      return { data: { sha: 'x' } };
    });
    const octokit = mockOctokit(getContent);
    const sleep = jest.fn(async () => {});
    const onAttempt = jest.fn();

    await expect(
      waitForContent(octokit, params, {
        maxAttempts: 8,
        initialDelayMs: 500,
        maxDelayMs: 8_000,
        sleep,
        onAttempt,
      }),
    ).resolves.toEqual({ attempts: 4 });

    expect(getContent).toHaveBeenCalledTimes(4);
    // Backoff doubles each retry (500 -> 1000 -> 2000), 3 retries before the 4th (successful) attempt.
    expect(sleep.mock.calls).toEqual([[500], [1000], [2000]]);
    expect(onAttempt.mock.calls).toEqual([
      [1, 500],
      [2, 1000],
      [3, 2000],
    ]);
  });

  it('caps backoff delay at maxDelayMs', async () => {
    let calls = 0;
    const getContent = jest.fn(async () => {
      calls += 1;
      if (calls < 5) notFound();
      return { data: {} };
    });
    const octokit = mockOctokit(getContent);
    const sleep = jest.fn(async () => {});

    await waitForContent(octokit, params, {
      maxAttempts: 8,
      initialDelayMs: 500,
      maxDelayMs: 1500,
      sleep,
    });

    // 500 -> 1000 -> 1500 (capped, would otherwise be 2000) -> 1500 (still capped)
    expect(sleep.mock.calls).toEqual([[500], [1000], [1500], [1500]]);
  });

  it('rethrows a non-404 error immediately without retrying or sleeping', async () => {
    const boom: any = new Error('rate limited');
    boom.status = 429;
    const getContent = jest.fn(async () => {
      throw boom;
    });
    const octokit = mockOctokit(getContent);
    const sleep = jest.fn(async () => {});

    await expect(
      waitForContent(octokit, params, {
        maxAttempts: 8,
        initialDelayMs: 500,
        maxDelayMs: 8_000,
        sleep,
      }),
    ).rejects.toThrow(/rate limited/);

    expect(getContent).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws a clear, actionable error naming repo/path/ref/attempts when maxAttempts is exhausted', async () => {
    const getContent = jest.fn(async () => {
      notFound();
    });
    const octokit = mockOctokit(getContent);
    const sleep = jest.fn(async () => {});

    await expect(
      waitForContent(octokit, params, {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 8_000,
        sleep,
      }),
    ).rejects.toThrow(
      /UA-MIS\/widgets.*catalog-info\.yaml.*abc123.*after 3 attempts.*FIX-19\/CATALOG-001/s,
    );

    expect(getContent).toHaveBeenCalledTimes(3);
    // Sleeps only between attempts (2 sleeps for 3 attempts), never after the final failure.
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe('capstone:wait-for-repo-content action', () => {
  function config(): ConfigReader {
    return new ConfigReader({
      integrations: { github: [{ host: 'github.com' }] },
    });
  }

  const credsProvider: any = {
    getCredentials: jest.fn(async () => ({ token: 'ghs_installtoken' })),
  };

  beforeEach(() => {
    credsProvider.getCredentials.mockClear();
  });

  it('resolves App creds org-scoped, calls the Octokit factory with the API base URL, and outputs attempts', async () => {
    const getContent = jest.fn(async () => ({ data: { sha: 'x' } }));
    const octokit: OctokitLike = { rest: { repos: { getContent } } };
    const octokitFactory = jest.fn(() => octokit);
    const sleep = jest.fn(async () => {});

    const action = createWaitForRepoContentAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory,
      sleep,
    });

    const ctx = createMockActionContext({
      input: { repo: 'widgets', commitHash: 'abc123' },
    } as any);

    await action.handler(ctx as any);

    expect(credsProvider.getCredentials).toHaveBeenCalledWith({
      url: 'https://github.com/UA-MIS',
    });
    expect(octokitFactory).toHaveBeenCalledWith({
      auth: 'ghs_installtoken',
      baseUrl: 'https://api.github.com',
    });
    expect(getContent).toHaveBeenCalledWith({
      owner: 'UA-MIS',
      repo: 'widgets',
      path: 'catalog-info.yaml',
      ref: 'abc123',
    });
    expect(ctx.output).toHaveBeenCalledWith('attempts', 1);
  });

  it('defaults catalogInfoPath to catalog-info.yaml and strips a leading slash when given', async () => {
    const getContent = jest.fn(async () => ({ data: {} }));
    const octokit: OctokitLike = { rest: { repos: { getContent } } };

    const action = createWaitForRepoContentAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
      sleep: async () => {},
    });

    const ctx = createMockActionContext({
      input: { repo: 'widgets', commitHash: 'abc123', catalogInfoPath: '/catalog-info.yaml' },
    } as any);

    await action.handler(ctx as any);

    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'catalog-info.yaml' }),
    );
  });

  it('propagates the exhaustion error when GitHub never serves the content within the retry budget', async () => {
    const getContent = jest.fn(async () => notFound());
    const octokit: OctokitLike = { rest: { repos: { getContent } } };

    const action = createWaitForRepoContentAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
      sleep: async () => {},
    });

    const ctx = createMockActionContext({
      input: { repo: 'widgets', commitHash: 'abc123', maxAttempts: 2, initialDelayMs: 10 },
    } as any);

    await expect(action.handler(ctx as any)).rejects.toThrow(/after 2 attempts/);
  });

  it('throws when the GitHub App has no credentials for github.com', async () => {
    const noCredsProvider: any = { getCredentials: jest.fn(async () => ({ token: undefined })) };
    const octokit: OctokitLike = { rest: { repos: { getContent: jest.fn() } } };

    const action = createWaitForRepoContentAction({
      config: config(),
      githubCredentialsProvider: noCredsProvider,
      octokitFactory: () => octokit,
      sleep: async () => {},
    });

    const ctx = createMockActionContext({
      input: { repo: 'widgets', commitHash: 'abc123' },
    } as any);

    await expect(action.handler(ctx as any)).rejects.toThrow(/no GitHub credentials/);
  });
});
