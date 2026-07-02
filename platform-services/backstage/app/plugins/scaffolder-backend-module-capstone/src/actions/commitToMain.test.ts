/*
 * Tests for capstone:commit-to-main.
 *
 * Strategy: inject a mock Octokit (no live GitHub App) + a mock GithubCredentialsProvider +
 * a ConfigReader with an integrations.github entry, drive commitFileToBranch / the action
 * handler, and assert:
 *   - the file is PUT to the target branch (default `main`) with the content base64-encoded
 *     and the right owner/repo/path/message;
 *   - CREATE vs UPDATE: a 404 on getContent omits `sha` (create); an existing file carries
 *     its blob `sha` (update); the `created` output/return reflects which;
 *   - it reads content from EITHER inline `content` OR a workspace `sourcePath` (exactly one);
 *   - it FAILS CLOSED on an unsafe path (absolute / `..` traversal) WITHOUT any GitHub call;
 *   - auth comes from the credentials provider (App token), passed to Octokit — no token input.
 */
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { ConfigReader } from '@backstage/config';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  commitFileToBranch,
  createCommitToMainAction,
  type OctokitLike,
} from './commitToMain';

const REPO_URL = 'github.com?owner=UA-MIS&repo=platform-infra';
const CLAIM_PATH = 'tenants/_claims/team-acme-widgets.yaml';
const CLAIM_CONTENT = 'apiVersion: platform.capstone.uamishub.com/v1alpha1\nkind: CapstoneTenant\n';

type PutParams = {
  owner: string;
  repo: string;
  path: string;
  message: string;
  content: string;
  branch: string;
  sha?: string;
};
type GetParams = { owner: string; repo: string; path: string; ref?: string };

/**
 * Mock Octokit. `existingSha === undefined` makes getContent throw a 404 (file absent →
 * create); a string makes it return that blob sha (update). Records every call.
 */
function mockOctokit(opts: { existingSha?: string; getContentError?: unknown } = {}): {
  octokit: OctokitLike;
  getCalls: GetParams[];
  putCalls: PutParams[];
} {
  const getCalls: GetParams[] = [];
  const putCalls: PutParams[] = [];
  const octokit: OctokitLike = {
    rest: {
      repos: {
        getContent: async (params: GetParams) => {
          getCalls.push(params);
          if (opts.getContentError) throw opts.getContentError;
          if (opts.existingSha === undefined) {
            const e: any = new Error('Not Found');
            e.status = 404;
            throw e;
          }
          return { data: { sha: opts.existingSha } };
        },
        createOrUpdateFileContents: async (params: PutParams) => {
          putCalls.push(params);
          return {
            data: {
              commit: {
                sha: 'commit-sha-123',
                html_url: 'https://github.com/UA-MIS/platform-infra/commit/commit-sha-123',
              },
            },
          };
        },
      },
    },
  };
  return { octokit, getCalls, putCalls };
}

function captureLogger() {
  const lines: string[] = [];
  const logger: any = {
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
    debug: (m: string) => lines.push(m),
  };
  logger.child = () => logger;
  return { logger, lines };
}

describe('commitFileToBranch', () => {
  it('CREATES a new file (404 on getContent) — PUT to main, base64 content, NO sha', async () => {
    const { octokit, getCalls, putCalls } = mockOctokit({ existingSha: undefined });
    const { logger } = captureLogger();

    const res = await commitFileToBranch({
      octokit,
      owner: 'UA-MIS',
      repo: 'platform-infra',
      branch: 'main',
      path: CLAIM_PATH,
      content: CLAIM_CONTENT,
      message: 'onboard tenant',
      logger,
    });

    expect(res).toEqual({
      commitSha: 'commit-sha-123',
      commitUrl: 'https://github.com/UA-MIS/platform-infra/commit/commit-sha-123',
      created: true,
    });

    // getContent probed the target branch for the existing blob sha.
    expect(getCalls).toEqual([
      { owner: 'UA-MIS', repo: 'platform-infra', path: CLAIM_PATH, ref: 'main' },
    ]);

    // PUT: correct target, base64 content, branch main, and NO sha (create).
    expect(putCalls).toHaveLength(1);
    const put = putCalls[0];
    expect(put.owner).toBe('UA-MIS');
    expect(put.repo).toBe('platform-infra');
    expect(put.path).toBe(CLAIM_PATH);
    expect(put.branch).toBe('main');
    expect(put.message).toBe('onboard tenant');
    expect(put.sha).toBeUndefined();
    expect(Buffer.from(put.content, 'base64').toString('utf8')).toBe(CLAIM_CONTENT);
  });

  it('UPDATES an existing file — carries the current blob sha', async () => {
    const { octokit, putCalls } = mockOctokit({ existingSha: 'old-blob-sha' });
    const { logger } = captureLogger();

    const res = await commitFileToBranch({
      octokit,
      owner: 'UA-MIS',
      repo: 'platform-infra',
      branch: 'main',
      path: CLAIM_PATH,
      content: CLAIM_CONTENT,
      message: 'update tenant',
      logger,
    });

    expect(res.created).toBe(false);
    expect(putCalls[0].sha).toBe('old-blob-sha');
  });

  it('refuses to commit when the path is a directory', async () => {
    const octokit: OctokitLike = {
      rest: {
        repos: {
          getContent: async () => ({ data: [{ name: 'a' }, { name: 'b' }] }),
          createOrUpdateFileContents: async () => ({ data: {} }),
        },
      },
    };
    const { logger } = captureLogger();
    await expect(
      commitFileToBranch({
        octokit,
        owner: 'UA-MIS',
        repo: 'platform-infra',
        branch: 'main',
        path: 'tenants/_claims',
        content: 'x',
        message: 'm',
        logger,
      }),
    ).rejects.toThrow(/is a directory/i);
  });

  it('rethrows a non-404 getContent error (e.g. 500) — does not treat it as create', async () => {
    const boom: any = new Error('server error');
    boom.status = 500;
    const { octokit, putCalls } = mockOctokit({ getContentError: boom });
    const { logger } = captureLogger();
    await expect(
      commitFileToBranch({
        octokit,
        owner: 'UA-MIS',
        repo: 'platform-infra',
        branch: 'main',
        path: CLAIM_PATH,
        content: CLAIM_CONTENT,
        message: 'm',
        logger,
      }),
    ).rejects.toThrow(/server error/i);
    expect(putCalls).toHaveLength(0);
  });
});

describe('capstone:commit-to-main action', () => {
  function config(): ConfigReader {
    return new ConfigReader({
      integrations: { github: [{ host: 'github.com' }] },
    });
  }

  const credsProvider: any = {
    getCredentials: jest.fn(async () => ({ token: 'ghs_installtoken' })),
  };

  function ctxFor(input: Record<string, unknown>, workspacePath?: string): any {
    return createMockActionContext({
      input,
      ...(workspacePath ? { workspacePath } : {}),
    } as any);
  }

  beforeEach(() => {
    credsProvider.getCredentials.mockClear();
  });

  it('commits inline content to main via the App token, emitting commitSha/commitUrl/created', async () => {
    const { octokit, putCalls } = mockOctokit({ existingSha: undefined });
    const octokitFactory = jest.fn(() => octokit);
    const action = createCommitToMainAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory,
    });

    const ctx = ctxFor({
      repoUrl: REPO_URL,
      path: CLAIM_PATH,
      content: CLAIM_CONTENT,
      commitMessage: 'onboard tenant (zero-touch)',
    });
    await action.handler(ctx);

    // Auth: App token resolved for the repo URL, passed to Octokit with the github apiBaseUrl.
    expect(credsProvider.getCredentials).toHaveBeenCalledWith({
      url: 'https://github.com/UA-MIS/platform-infra',
    });
    expect(octokitFactory).toHaveBeenCalledWith({
      auth: 'ghs_installtoken',
      baseUrl: 'https://api.github.com',
    });

    // Committed to main.
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].branch).toBe('main');
    expect(putCalls[0].path).toBe(CLAIM_PATH);
    expect(putCalls[0].message).toBe('onboard tenant (zero-touch)');

    expect(ctx.output).toHaveBeenCalledWith('commitSha', 'commit-sha-123');
    expect(ctx.output).toHaveBeenCalledWith(
      'commitUrl',
      'https://github.com/UA-MIS/platform-infra/commit/commit-sha-123',
    );
    expect(ctx.output).toHaveBeenCalledWith('created', true);
  });

  it('reads content from a workspace sourcePath when content is not given', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-to-main-'));
    const rel = 'claim/tenants/_claims/team-acme-widgets.yaml';
    await fs.outputFile(path.join(workspace, rel), CLAIM_CONTENT);

    const { octokit, putCalls } = mockOctokit({ existingSha: undefined });
    const action = createCommitToMainAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
    });

    const ctx = ctxFor(
      { repoUrl: REPO_URL, path: CLAIM_PATH, sourcePath: rel, branch: 'main' },
      workspace,
    );
    await action.handler(ctx);

    expect(Buffer.from(putCalls[0].content, 'base64').toString('utf8')).toBe(CLAIM_CONTENT);
    await fs.remove(workspace);
  });

  it('FAILS CLOSED on an absolute path — no credentials + no GitHub call', async () => {
    const octokitFactory = jest.fn();
    const action = createCommitToMainAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory,
    });
    const ctx = ctxFor({ repoUrl: REPO_URL, path: '/etc/passwd', content: 'x' });
    await expect(action.handler(ctx)).rejects.toThrow(/repo-relative/i);
    expect(credsProvider.getCredentials).not.toHaveBeenCalled();
    expect(octokitFactory).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED on a `..` traversal path — no GitHub call', async () => {
    const octokitFactory = jest.fn();
    const action = createCommitToMainAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory,
    });
    const ctx = ctxFor({ repoUrl: REPO_URL, path: 'tenants/../../secrets.yaml', content: 'x' });
    await expect(action.handler(ctx)).rejects.toThrow(/traversal/i);
    expect(octokitFactory).not.toHaveBeenCalled();
  });

  it('rejects providing BOTH content and sourcePath', async () => {
    const action = createCommitToMainAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => mockOctokit().octokit,
    });
    const ctx = ctxFor({ repoUrl: REPO_URL, path: CLAIM_PATH, content: 'x', sourcePath: 'y' });
    await expect(action.handler(ctx)).rejects.toThrow(/exactly ONE/i);
  });

  it('rejects providing NEITHER content nor sourcePath', async () => {
    const action = createCommitToMainAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => mockOctokit().octokit,
    });
    const ctx = ctxFor({ repoUrl: REPO_URL, path: CLAIM_PATH });
    await expect(action.handler(ctx)).rejects.toThrow(/exactly ONE/i);
  });
});
