/*
 * Tests for capstone:ensure-argocd-webhook.
 *
 * Strategy: inject a mock OctokitLike (no live GitHub) + a hand-mocked credentials
 * provider/config (the repo's idiom, see commitToMain.test.ts), drive ensureArgocdWebhook /
 * the action handler, and assert:
 *   - a repo with NO matching hook gets one CREATED with the exact config (url, json,
 *     secret, insecure_ssl "0", events ["push"], active true);
 *   - IDEMPOTENCY: a repo that already has a hook targeting the configured URL gets NO
 *     second createWebhook call — re-running never duplicates;
 *   - it FAILS CLOSED when `capstone.argocd.webhookUrl`/`webhookSecret` config is missing
 *     (no GitHub call at all);
 *   - the webhook secret NEVER appears in any log line.
 */
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { ConfigReader } from '@backstage/config';
import {
  createEnsureArgocdWebhookAction,
  ensureArgocdWebhook,
  readArgocdWebhookConfig,
  type ArgocdWebhookConfig,
  type OctokitLike,
} from './ensureArgocdWebhook';

const WEBHOOK_URL = 'https://argocd.capstone.uamishub.com/api/webhook';
const WEBHOOK_SECRET = 'sup3r-s3cr3t-hmac-value';
const CFG: ArgocdWebhookConfig = { webhookUrl: WEBHOOK_URL, webhookSecret: WEBHOOK_SECRET };
const REPO_URL = 'github.com?owner=UA-MIS&repo=widgets';

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

function mockOctokit(existingHooks: Array<{ id: number; active: boolean; config: { url?: string } }>) {
  const createCalls: any[] = [];
  const octokit: OctokitLike = {
    rest: {
      repos: {
        listWebhooks: async () => ({ data: existingHooks }),
        createWebhook: async params => {
          createCalls.push(params);
          return { data: { id: 999 } };
        },
      },
    },
  };
  return { octokit, createCalls };
}

describe('ensureArgocdWebhook', () => {
  it('CREATES a webhook when none targets the configured URL', async () => {
    const { octokit, createCalls } = mockOctokit([]);
    const { logger, lines } = captureLogger();

    const res = await ensureArgocdWebhook({
      octokit,
      cfg: CFG,
      owner: 'UA-MIS',
      repo: 'widgets',
      logger,
    });

    expect(res).toEqual({ created: true, hookId: 999 });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({
      owner: 'UA-MIS',
      repo: 'widgets',
      config: {
        url: WEBHOOK_URL,
        content_type: 'json',
        secret: WEBHOOK_SECRET,
        insecure_ssl: '0',
      },
      events: ['push'],
      active: true,
    });

    // The secret must never be logged.
    expect(lines.join('\n')).not.toContain(WEBHOOK_SECRET);
  });

  it('IDEMPOTENT: skips creation when a hook already targets the configured URL', async () => {
    const { octokit, createCalls } = mockOctokit([
      { id: 42, active: true, config: { url: WEBHOOK_URL } },
    ]);
    const { logger } = captureLogger();

    const res = await ensureArgocdWebhook({
      octokit,
      cfg: CFG,
      owner: 'UA-MIS',
      repo: 'widgets',
      logger,
    });

    expect(res).toEqual({ created: false, hookId: 42 });
    expect(createCalls).toHaveLength(0);
  });

  it('does not match a DIFFERENT hook (e.g. some other CI webhook) and still creates', async () => {
    const { octokit, createCalls } = mockOctokit([
      { id: 7, active: true, config: { url: 'https://example.com/other-hook' } },
    ]);
    const { logger } = captureLogger();

    const res = await ensureArgocdWebhook({
      octokit,
      cfg: CFG,
      owner: 'UA-MIS',
      repo: 'widgets',
      logger,
    });

    expect(res.created).toBe(true);
    expect(createCalls).toHaveLength(1);
  });
});

describe('readArgocdWebhookConfig', () => {
  it('FAILS CLOSED when capstone.argocd is entirely missing', () => {
    const config = new ConfigReader({});
    expect(() => readArgocdWebhookConfig(config)).toThrow(/missing config section/i);
  });

  it('FAILS CLOSED when webhookSecret is missing', () => {
    const config = new ConfigReader({ capstone: { argocd: { webhookUrl: WEBHOOK_URL } } });
    expect(() => readArgocdWebhookConfig(config)).toThrow(/webhookUrl.*webhookSecret/i);
  });

  it('reads both values when present', () => {
    const config = new ConfigReader({
      capstone: { argocd: { webhookUrl: WEBHOOK_URL, webhookSecret: WEBHOOK_SECRET } },
    });
    expect(readArgocdWebhookConfig(config)).toEqual(CFG);
  });
});

describe('capstone:ensure-argocd-webhook action', () => {
  function config(): ConfigReader {
    return new ConfigReader({
      integrations: { github: [{ host: 'github.com' }] },
      capstone: { argocd: { webhookUrl: WEBHOOK_URL, webhookSecret: WEBHOOK_SECRET } },
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
  });

  it('resolves owner/repo from repoUrl, authenticates via the App token, and creates the hook', async () => {
    const { octokit, createCalls } = mockOctokit([]);
    const octokitFactory = jest.fn(() => octokit);
    const action = createEnsureArgocdWebhookAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory,
    });

    const ctx = ctxFor({ repoUrl: REPO_URL });
    await action.handler(ctx);

    expect(credsProvider.getCredentials).toHaveBeenCalledWith({
      url: 'https://github.com/UA-MIS/widgets',
    });
    expect(octokitFactory).toHaveBeenCalledWith({
      auth: 'ghs_installtoken',
      baseUrl: 'https://api.github.com',
    });
    expect(createCalls).toHaveLength(1);
    expect(ctx.output).toHaveBeenCalledWith('created', true);
    expect(ctx.output).toHaveBeenCalledWith('hookId', 999);
  });

  it('is idempotent end-to-end: a second run against a repo that already has the hook creates nothing', async () => {
    const { octokit, createCalls } = mockOctokit([
      { id: 42, active: true, config: { url: WEBHOOK_URL } },
    ]);
    const action = createEnsureArgocdWebhookAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory: () => octokit,
    });

    const ctx = ctxFor({ repoUrl: REPO_URL });
    await action.handler(ctx);

    expect(createCalls).toHaveLength(0);
    expect(ctx.output).toHaveBeenCalledWith('created', false);
    expect(ctx.output).toHaveBeenCalledWith('hookId', 42);
  });

  it('FAILS CLOSED before any GitHub call when capstone.argocd config is missing', async () => {
    const octokitFactory = jest.fn();
    const action = createEnsureArgocdWebhookAction({
      config: new ConfigReader({ integrations: { github: [{ host: 'github.com' }] } }),
      githubCredentialsProvider: credsProvider,
      octokitFactory,
    });

    const ctx = ctxFor({ repoUrl: REPO_URL });
    await expect(action.handler(ctx)).rejects.toThrow(/missing config section/i);
    expect(credsProvider.getCredentials).not.toHaveBeenCalled();
    expect(octokitFactory).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when repoUrl has no owner', async () => {
    const octokitFactory = jest.fn();
    const action = createEnsureArgocdWebhookAction({
      config: config(),
      githubCredentialsProvider: credsProvider,
      octokitFactory,
    });

    const ctx = ctxFor({ repoUrl: 'github.com' });
    await expect(action.handler(ctx)).rejects.toThrow();
    expect(octokitFactory).not.toHaveBeenCalled();
  });
});
