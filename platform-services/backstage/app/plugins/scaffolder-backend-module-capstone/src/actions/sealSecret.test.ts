/*
 * Unit tests for the capstone:seal-secret action (M3 behavior + authz), reworked for the
 * ESO+Vault v1 model (ADR-030 B1).
 *
 * SECURITY-CRITICAL ASSERTIONS (plan §7 / R2 / R1):
 *  - the plaintext value is WRITTEN TO VAULT (VaultClient.setKey) at the per-env path
 *    tenants/<team>/<env>/app under the KEY — and the value NEVER appears in any committed
 *    file, in any ctx.logger call, or in a thrown error,
 *  - the PR commits an ExternalSecret declaration (key NAMES + remoteRef pointers, NO values)
 *    at .devops/secrets/externalsecret-<env>.yaml + references it from the env overlay,
 *  - one PR per selected env; a second key for the same env MERGES into the ExternalSecret,
 *  - authz: owner -> ALLOW + write; non-owner -> DENY (no Vault write, no Octokit); admin
 *    (labmx) -> override ALLOW; policy DENY -> fail closed.
 */
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { NotAllowedError } from '@backstage/errors';

// ── Mock the VaultClient: record setKey calls, never a real network/TLS call ──────────────
type VaultSetCall = { path: string; key: string; value: string };
const vaultSetCalls: VaultSetCall[] = [];
let vaultShouldFail = false;
jest.mock('../vaultClient', () => ({
  VaultClient: jest.fn().mockImplementation(() => ({
    setKey: jest.fn(async (path: string, key: string, value: string) => {
      vaultSetCalls.push({ path, key, value });
      if (vaultShouldFail) throw new Error('vault boom (HTTP 500)');
    }),
    deleteKey: jest.fn(async () => {}),
  })),
}));

// ── Mock @backstage/integration credentials provider (App token, no PAT) ─────────────────
jest.mock('@backstage/integration', () => ({
  ScmIntegrations: { fromConfig: jest.fn(() => ({})) },
  DefaultGithubCredentialsProvider: {
    fromIntegrations: jest.fn(() => ({
      getCredentials: jest.fn(async () => ({ token: 'ghs_apptoken' })),
    })),
  },
}));

// ── Mock @octokit/rest: record the PR/file calls ─────────────────────────────────────────
const octokitCalls = {
  reposGet: jest.fn<Promise<any>, any[]>(async () => ({
    data: { default_branch: 'main' },
  })),
  getRef: jest.fn<Promise<any>, any[]>(async () => ({
    data: { object: { sha: 'basesha' } },
  })),
  createRef: jest.fn<Promise<any>, any[]>(async () => ({})),
  updateRef: jest.fn<Promise<any>, any[]>(async () => ({})),
  getContent: jest.fn<Promise<any>, any[]>(async () => {
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  }),
  createOrUpdateFileContents: jest.fn<Promise<any>, any[]>(async () => ({})),
  pullsList: jest.fn<Promise<any>, any[]>(async () => ({ data: [] })),
  pullsCreate: jest.fn<Promise<any>, any[]>(async (opts: { head: string }) => ({
    data: { html_url: `https://github.com/UA-MIS/my-app/pull/${opts.head}` },
  })),
};
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: {
      get: octokitCalls.reposGet,
      getContent: octokitCalls.getContent,
      createOrUpdateFileContents: octokitCalls.createOrUpdateFileContents,
    },
    git: {
      getRef: octokitCalls.getRef,
      createRef: octokitCalls.createRef,
      updateRef: octokitCalls.updateRef,
    },
    pulls: { create: octokitCalls.pullsCreate, list: octokitCalls.pullsList },
  })),
}));

// eslint-disable-next-line import/first
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
// eslint-disable-next-line import/first
import { createSealSecretAction, ADMIN_GROUP_REF } from './sealSecret';

// ── Test fixtures ────────────────────────────────────────────────────────────────────────
const SECRET_VALUE = 'super-secret-PLAINTEXT-value-9f3a';
const TARGET_REF = 'component:default/my-app';
const OWNER_GROUP = 'group:default/team-alpha';

function mockConfig(): any {
  return {
    getOptionalConfig: (key: string) =>
      key === 'capstone.secrets'
        ? {
            getOptionalString: (k: string) =>
              (
                {
                  defaultBranchPrefix: 'secrets/',
                  overlaysDir: '.devops/chart/overlays',
                  overlayEsFile: 'app-secret.externalsecret.yaml',
                } as Record<string, string>
              )[k],
            getOptionalConfig: (_vk: string) => undefined, // vault.* -> defaults
          }
        : undefined,
  };
}

/** The per-env overlay ExternalSecret path the scaffolder ships (what the Secrets tab edits). */
function overlayEs(env: string): string {
  return `.devops/chart/overlays/${env}/app-secret.externalsecret.yaml`;
}

/**
 * A realistic RENDERED (placeholders already substituted) overlay ExternalSecret like the M4
 * scaffolder ships (#106) — shipped with the demo `app-secret` <- APP_SECRET entry. Tests mount
 * this via getContent so the upsert/remove operate on the real shape.
 */
function shippedEs(env: string, extraKeys: string[] = []): string {
  const lines = [
    '# App secret — ESO ExternalSecret (ADR-030 B1).',
    'apiVersion: external-secrets.io/v1',
    'kind: ExternalSecret',
    'metadata:',
    '  name: my-app-secret',
    `  namespace: team-alpha-${env}`,
    'spec:',
    '  refreshInterval: "1h"',
    '  secretStoreRef:',
    '    name: vault-tenant',
    '    kind: SecretStore',
    '  target:',
    '    name: my-app-secret',
    '    creationPolicy: Owner',
    '    deletionPolicy: Delete',
    '  data:',
    '    - secretKey: app-secret',
    '      remoteRef:',
    `        key: tenants/team-alpha/${env}/app`,
    '        property: APP_SECRET',
  ];
  for (const k of extraKeys) {
    lines.push(
      `    - secretKey: ${k}`,
      '      remoteRef:',
      `        key: tenants/team-alpha/${env}/app`,
      `        property: ${k}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** A getContent mock that serves the shipped overlay ES for the given envs, 404 elsewhere. */
function serveShippedEs(envs: string[], extraKeys: Record<string, string[]> = {}) {
  octokitCalls.getContent.mockImplementation(async (opts: any) => {
    for (const env of envs) {
      if (opts.path === overlayEs(env)) {
        return {
          data: {
            sha: `sha-${env}`,
            content: Buffer.from(
              shippedEs(env, extraKeys[env] ?? []),
              'utf8',
            ).toString('base64'),
          },
        } as any;
      }
    }
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  });
}

// The target Component: owned by team-alpha, source repo UA-MIS/my-app.
const TARGET_ENTITY = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'my-app',
    namespace: 'default',
    annotations: {
      'backstage.io/source-location':
        'url:https://github.com/UA-MIS/my-app/tree/main/',
    },
  },
  spec: { owner: 'team-alpha' },
  relations: [{ type: 'ownedBy', targetRef: OWNER_GROUP }],
};

/**
 * Build deps. `actorGroups` are the Groups the catalog reports the actor belongs to (drives
 * the belt-and-suspenders owner re-check). `policyResult` is what the permission framework
 * returns (drives the primary authz gate).
 */
function makeDeps(opts: {
  actorGroups: string[];
  policyResult?: AuthorizeResult;
  entity?: unknown;
}) {
  const loggerCalls: string[] = [];
  const logger: any = {
    info: (m: string) => loggerCalls.push(m),
    warn: (m: string) => loggerCalls.push(m),
    error: (m: string) => loggerCalls.push(m),
    debug: (m: string) => loggerCalls.push(m),
  };
  logger.child = () => logger;

  const deps: any = {
    config: mockConfig(),
    logger,
    catalog: {
      getEntityByRef: jest.fn(async () =>
        opts.entity === undefined ? TARGET_ENTITY : opts.entity,
      ),
      getEntities: jest.fn(async () => ({
        items: opts.actorGroups.map(ref => {
          const nameNs = ref.split(':')[1];
          const [ns, name] = nameNs.split('/');
          return { kind: 'Group', metadata: { name, namespace: ns } };
        }),
      })),
    },
    permissions: {
      authorize: jest.fn(async () => [
        { result: opts.policyResult ?? AuthorizeResult.ALLOW },
      ]),
    },
    auth: {
      getOwnServiceCredentials: jest.fn(async () => ({ token: 'svc' })),
    },
  };
  return { deps, loggerCalls };
}

function ctxFor(input: {
  entityRef: string;
  key: string;
  value: string;
  envs: string[];
}): any {
  return createMockActionContext({
    input,
    getInitiatorCredentials: (async () => ({
      $$type: '@backstage/BackstageCredentials',
      principal: { type: 'user', userEntityRef: 'user:default/alice' },
    })) as any,
  } as any);
}

/** All file contents written (path -> decoded utf8) across createOrUpdateFileContents calls. */
function writtenFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of octokitCalls.createOrUpdateFileContents.mock.calls as any[]) {
    out[c[0].path] = Buffer.from(c[0].content, 'base64').toString('utf8');
  }
  return out;
}

beforeEach(() => {
  vaultSetCalls.length = 0;
  vaultShouldFail = false;
  Object.values(octokitCalls).forEach(m => (m as jest.Mock).mockClear());
  octokitCalls.reposGet.mockImplementation(async () => ({
    data: { default_branch: 'main' },
  }));
  octokitCalls.getRef.mockImplementation(async () => ({
    data: { object: { sha: 'basesha' } },
  }));
  // Reset to plain no-op-safe stubs: mockClear() above only clears call history, NOT whatever
  // mockImplementation a PRIOR test's mockGithubRepo/mockRollingPrLifecycle helper installed —
  // without this, a later test using the simpler static (serveShippedEs) mocks can inherit a
  // stateful CAS-conflict-checking createOrUpdateFileContents from an earlier concurrency test
  // and spuriously 409/422 (this bit us once — see git history / PR #500 review round 2).
  octokitCalls.createRef.mockImplementation(async () => ({}));
  octokitCalls.updateRef.mockImplementation(async () => ({}));
  octokitCalls.createOrUpdateFileContents.mockImplementation(async () => ({}));
  octokitCalls.getContent.mockImplementation(async () => {
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  });
  octokitCalls.pullsList.mockImplementation(async () => ({ data: [] }));
  octokitCalls.pullsCreate.mockImplementation(async (opts: { head: string }) => ({
    data: { html_url: `https://github.com/UA-MIS/my-app/pull/${opts.head}` },
  }));
});

describe('capstone:seal-secret action shape', () => {
  const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
  const action = createSealSecretAction(deps);

  it('registers under the capstone:seal-secret id', () => {
    expect(action.id).toBe('capstone:seal-secret');
  });

  it('flags write-only semantics in the description', () => {
    expect(action.description).toMatch(/write-only|cannot be read back/i);
  });

  it('declares the documented input fields', () => {
    const serialized = JSON.stringify(action.schema?.input);
    expect(serialized).toContain('entityRef');
    expect(serialized).toContain('key');
    expect(serialized).toContain('value');
    expect(serialized).toContain('envs');
  });
});

describe('capstone:seal-secret write + publish (owner)', () => {
  it('writes the value to Vault per env and opens ONE rolling PR covering ALL envs', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    serveShippedEs(['dev', 'prod']);
    const action = createSealSecretAction(deps);
    const ctx = ctxFor({
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
      value: SECRET_VALUE,
      envs: ['dev', 'prod'],
    });

    await action.handler(ctx);

    // One Vault write per env, at the per-env path (reused from the shipped ES remoteRef.key),
    // under the KEY, with the value.
    expect(vaultSetCalls).toEqual([
      {
        path: 'tenants/team-alpha/dev/app',
        key: 'DATABASE_URL',
        value: SECRET_VALUE,
      },
      {
        path: 'tenants/team-alpha/prod/app',
        key: 'DATABASE_URL',
        value: SECRET_VALUE,
      },
    ]);

    // ONE PR covers BOTH envs (D-118 rolling PR — no more one-PR-per-env), each upserting its
    // own overlay ES (NOT a new file, NOT a kustomization edit) as separate commits on the
    // SAME branch.
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(1);
    expect(octokitCalls.pullsCreate.mock.calls[0][0]).toMatchObject({
      head: 'secrets/pending',
      title: expect.stringMatching(/pending secret changes/i),
    });
    const files = writtenFiles();
    expect(files[overlayEs('dev')]).toBeDefined();
    expect(files[overlayEs('prod')]).toBeDefined();
    // No file outside the overlay (no .devops/secrets/, no kustomization.yaml edit).
    for (const p of Object.keys(files)) {
      expect(p).toMatch(/overlays\/(dev|prod)\/app-secret\.externalsecret\.yaml$/);
    }
    // Every write onto the rolling branch, not a per-env timestamped branch.
    for (const c of octokitCalls.createOrUpdateFileContents.mock.calls as any[]) {
      expect(c[0].branch).toBe('secrets/pending');
    }

    expect(ctx.output).toHaveBeenCalledWith(
      'pullRequestUrls',
      [expect.stringContaining('/pull/')],
    );
  });

  it('upserts a data[] entry (names only) + PRESERVES the shipped app-secret entry', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    serveShippedEs(['dev']);
    const action = createSealSecretAction(deps);
    await action.handler(
      ctxFor({
        entityRef: TARGET_REF,
        key: 'API_KEY',
        value: SECRET_VALUE,
        envs: ['dev'],
      }),
    );

    const es = writtenFiles()[overlayEs('dev')];
    // The new entry — names + Vault pointer only.
    expect(es).toContain('- secretKey: "API_KEY"');
    expect(es).toContain('key: "tenants/team-alpha/dev/app"');
    expect(es).toContain('property: "API_KEY"');
    // The shipped demo entry is preserved (not clobbered).
    expect(es).toContain('secretKey: app-secret');
    expect(es).toContain('property: APP_SECRET');
    // Document scaffolding preserved + the VALUE never in git.
    expect(es).toContain('kind: ExternalSecret');
    expect(es).toContain('deletionPolicy: Delete');
    expect(es).not.toContain(SECRET_VALUE);
  });

  it('is idempotent — re-setting an existing key rewrites no git (only Vault), and does NOT attempt a zero-diff PR', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    // The dev overlay already declares API_KEY.
    serveShippedEs(['dev'], { dev: ['API_KEY'] });
    const action = createSealSecretAction(deps);
    const ctx = ctxFor({
      entityRef: TARGET_REF,
      key: 'API_KEY',
      value: 'new-rotated-value',
      envs: ['dev'],
    });
    await action.handler(ctx);

    // Vault is still written (rotation), but no file is committed (the declaration is unchanged).
    expect(vaultSetCalls).toHaveLength(1);
    expect(octokitCalls.createOrUpdateFileContents).not.toHaveBeenCalled();
    // NO PR is opened: with no open PR already covering this repo and nothing to commit, calling
    // pulls.create would hit GitHub's real "No commits between X and Y" 422 (reproduced against a
    // live repo — PR #500 review Finding A). The rotation is fully live via Vault regardless.
    expect(octokitCalls.pullsCreate).not.toHaveBeenCalled();
    expect(ctx.output).toHaveBeenCalledWith('pullRequestUrls', []);
  });

  it('NEVER logs the plaintext value', async () => {
    const { deps, loggerCalls } = makeDeps({ actorGroups: [OWNER_GROUP] });
    serveShippedEs(['dev', 'prod']);
    const action = createSealSecretAction(deps);
    await action.handler(
      ctxFor({
        entityRef: TARGET_REF,
        key: 'TOKEN',
        value: SECRET_VALUE,
        envs: ['dev', 'prod'],
      }),
    );
    for (const line of loggerCalls) {
      expect(line).not.toContain(SECRET_VALUE);
    }
    // The key IS logged (operational visibility), proving logging happened at all.
    expect(loggerCalls.join('\n')).toMatch(/TOKEN/);
  });

  /**
   * A single cohesive in-memory GitHub repo simulator (D-118 review follow-up, PR #500) backing
   * ALL the octokit calls the rolling-PR lifecycle touches — branch refs, PR state
   * (open/closed/merged), and file content+sha — wired together with REAL GitHub semantics: a
   * file commit really does advance its branch's tip sha, a sha-mismatch on a file write really
   * 409s, and a duplicate ref/PR create really 422s. This is what makes the CONCURRENCY tests
   * below meaningful — a static happy-path stub (like serveShippedEs, still used by the simpler
   * non-racing tests above) cannot exercise a real conflict or a real "no commits yet" 422.
   */
  function mockGithubRepo(initialFiles: Record<string, string> = {}) {
    const refs = new Map<string, string>([['heads/main', 'sha-main']]);
    const files = new Map<string, { content: string; sha: string }>();
    let shaCounter = 0;
    let prCounter = 0;
    let pr:
      | { html_url: string; number: number; state: 'open' | 'closed'; merged_at: string | null }
      | undefined;

    for (const [path, content] of Object.entries(initialFiles)) {
      files.set(path, { content, sha: `sha-${shaCounter++}` });
    }

    octokitCalls.getRef.mockImplementation(async (opts: any) => {
      const sha = refs.get(opts.ref);
      if (sha === undefined) {
        const e = new Error('Not Found') as Error & { status: number };
        e.status = 404;
        throw e;
      }
      return { data: { object: { sha } } };
    });
    octokitCalls.createRef.mockImplementation(async (opts: any) => {
      const ref = opts.ref.replace(/^refs\//, '');
      if (refs.has(ref)) {
        const e = new Error('Reference already exists') as Error & { status: number };
        e.status = 422;
        throw e;
      }
      refs.set(ref, opts.sha);
      return {};
    });
    octokitCalls.updateRef.mockImplementation(async (opts: any) => {
      refs.set(opts.ref, opts.sha);
      return {};
    });
    octokitCalls.pullsList.mockImplementation(async (opts: any) => {
      if (!pr) return { data: [] };
      if (opts.state && opts.state !== 'all' && opts.state !== pr.state) {
        return { data: [] };
      }
      return { data: [pr] };
    });
    octokitCalls.pullsCreate.mockImplementation(async () => {
      if (pr && pr.state === 'open') {
        const e = new Error('A pull request already exists') as Error & { status: number };
        e.status = 422;
        throw e;
      }
      prCounter += 1;
      pr = {
        html_url: `https://github.com/UA-MIS/my-app/pull/${prCounter}`,
        number: prCounter,
        state: 'open',
        merged_at: null,
      };
      return { data: pr };
    });
    octokitCalls.getContent.mockImplementation(async (opts: any) => {
      const f = files.get(opts.path);
      if (!f) {
        const e = new Error('Not Found') as Error & { status: number };
        e.status = 404;
        throw e;
      }
      return {
        data: { sha: f.sha, content: Buffer.from(f.content, 'utf8').toString('base64') },
      } as any;
    });
    octokitCalls.createOrUpdateFileContents.mockImplementation(async (opts: any) => {
      const existing = files.get(opts.path);
      if ((existing?.sha ?? undefined) !== opts.sha) {
        const e = new Error('Conflict: sha mismatch') as Error & { status: number };
        e.status = 409;
        throw e;
      }
      const newSha = `sha-${shaCounter++}`;
      files.set(opts.path, {
        content: Buffer.from(opts.content, 'base64').toString('utf8'),
        sha: newSha,
      });
      // A real commit landed on this branch — advance its tracked tip sha (so a later
      // ensurePendingBranch call correctly sees this branch as "has commits ahead of base").
      refs.set(`heads/${opts.branch}`, `sha-commit-${newSha}`);
      return { data: { content: { sha: newSha } } };
    });

    return {
      files,
      /** Simulate the pending PR merging — no longer OPEN, branch is safely stale. */
      mergePr: () => {
        if (pr) pr = { ...pr, state: 'closed', merged_at: new Date().toISOString() };
      },
      /** Simulate a human closing the pending PR WITHOUT merging it. */
      closePrWithoutMerging: () => {
        if (pr) pr = { ...pr, state: 'closed', merged_at: null };
      },
    };
  }

  it('reuses the SAME rolling PR across two separate seal calls (different keys/envs)', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    mockGithubRepo({
      [overlayEs('dev')]: shippedEs('dev'),
      [overlayEs('prod')]: shippedEs('prod'),
    });
    const action = createSealSecretAction(deps);

    const ctx1 = ctxFor({
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
      value: SECRET_VALUE,
      envs: ['dev'],
    });
    await action.handler(ctx1);
    const ctx2 = ctxFor({
      entityRef: TARGET_REF,
      key: 'API_KEY',
      value: 'other-value',
      envs: ['dev', 'prod'],
    });
    await action.handler(ctx2);

    // Both calls' output points at the SAME PR — no new PR for the second call.
    const url1 = (ctx1.output as jest.Mock).mock.calls[0][1][0];
    const url2 = (ctx2.output as jest.Mock).mock.calls[0][1][0];
    expect(url2).toBe(url1);
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(1);
    expect(octokitCalls.createRef).toHaveBeenCalledTimes(1);
  });

  it('opens a NEW PR after the previous rolling PR merged (stale branch reset, fresh PR)', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    const repo = mockGithubRepo({
      [overlayEs('dev')]: shippedEs('dev'),
      [overlayEs('prod')]: shippedEs('prod'),
    });
    const action = createSealSecretAction(deps);

    const ctx1 = ctxFor({
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
      value: SECRET_VALUE,
      envs: ['dev'],
    });
    await action.handler(ctx1);
    repo.mergePr(); // the PR merged — the branch is now stale

    const ctx2 = ctxFor({
      entityRef: TARGET_REF,
      key: 'API_KEY',
      value: 'other-value',
      envs: ['dev'],
    });
    await action.handler(ctx2);

    const url1 = (ctx1.output as jest.Mock).mock.calls[0][1][0];
    const url2 = (ctx2.output as jest.Mock).mock.calls[0][1][0];
    expect(url2).not.toBe(url1);
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(2); // a FRESH PR was opened
    expect(octokitCalls.createRef).toHaveBeenCalledTimes(1); // branch created ONCE, reused
    expect(octokitCalls.updateRef).toHaveBeenCalledTimes(1); // reset-to-base before the new PR
  });

  it('WARNS when resetting a rolling branch whose last PR was CLOSED WITHOUT MERGING (D-118 tradeoff)', async () => {
    const { deps, loggerCalls } = makeDeps({ actorGroups: [OWNER_GROUP] });
    const repo = mockGithubRepo({ [overlayEs('dev')]: shippedEs('dev') });
    const action = createSealSecretAction(deps);

    await action.handler(
      ctxFor({
        entityRef: TARGET_REF,
        key: 'DATABASE_URL',
        value: SECRET_VALUE,
        envs: ['dev'],
      }),
    );
    repo.closePrWithoutMerging(); // a human closed it without merging — DATABASE_URL's Vault
    // write is now orphaned (no ExternalSecret entry will ever declare it once reset)

    await action.handler(
      ctxFor({
        entityRef: TARGET_REF,
        key: 'API_KEY',
        value: 'other-value',
        envs: ['dev'],
      }),
    );

    expect(loggerCalls.join('\n')).toMatch(/CLOSED WITHOUT MERGING/);
  });

  it('CONCURRENCY: two simultaneous seals for the same repo race through branch/PR creation without either erroring', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    mockGithubRepo({ [overlayEs('dev')]: shippedEs('dev') });
    const action = createSealSecretAction(deps);

    const ctx1 = ctxFor({
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
      value: SECRET_VALUE,
      envs: ['dev'],
    });
    const ctx2 = ctxFor({
      entityRef: TARGET_REF,
      key: 'API_KEY',
      value: 'other-value',
      envs: ['dev'],
    });

    // Real Promise.all — NOT sequential awaits — so createRef/pulls.create genuinely race through
    // the 422-then-reread paths (PR #500 review point 4/point 6: this was previously untested).
    await Promise.all([action.handler(ctx1), action.handler(ctx2)]);

    const url1 = (ctx1.output as jest.Mock).mock.calls[0][1][0];
    const url2 = (ctx2.output as jest.Mock).mock.calls[0][1][0];
    // The real invariant: exactly ONE PR exists and BOTH callers converged on it. (NOT asserting
    // pullsCreate's call COUNT here — both callers legitimately ATTEMPT it when racing, and the
    // loser's attempt is expected to 422 and get caught; the mock still records that invocation.)
    expect(url1).toBe(url2);
    expect(url1).toMatch(/\/pull\/1$/); // only one PR was ever actually created (number 1)
  });

  it('CONCURRENCY: two simultaneous seals for DIFFERENT keys in the SAME env do not lose either declaration (lost-update fix)', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    const repo = mockGithubRepo({ [overlayEs('dev')]: shippedEs('dev') });
    const action = createSealSecretAction(deps);

    const ctx1 = ctxFor({
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
      value: SECRET_VALUE,
      envs: ['dev'],
    });
    const ctx2 = ctxFor({
      entityRef: TARGET_REF,
      key: 'API_KEY',
      value: 'other-value',
      envs: ['dev'],
    });

    await Promise.all([action.handler(ctx1), action.handler(ctx2)]);

    // Both keys survived — casUpdateFile's compare-and-swap retry recovers from the 409 instead
    // of one writer silently clobbering the other's precomputed payload (PR #500 review point 6).
    const es = repo.files.get(overlayEs('dev'))!.content;
    expect(es).toContain('secretKey: "DATABASE_URL"');
    expect(es).toContain('secretKey: "API_KEY"');
    expect(es).toContain('secretKey: app-secret'); // the shipped entry survived too
  });

  it('fails CLOSED (no Vault write, no PR) if the overlay ExternalSecret is missing', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    // getContent 404s for everything (default) -> not an M4 tenant repo.
    const action = createSealSecretAction(deps);
    await expect(
      action.handler(
        ctxFor({
          entityRef: TARGET_REF,
          key: 'K',
          value: SECRET_VALUE,
          envs: ['dev'],
        }),
      ),
    ).rejects.toThrow(/ExternalSecret/);
    expect(vaultSetCalls).toHaveLength(0);
    expect(octokitCalls.pullsCreate).not.toHaveBeenCalled();
  });

  it('fails CLOSED (no Vault write, no Octokit) if a Component has no source-location', async () => {
    const { deps } = makeDeps({
      actorGroups: [OWNER_GROUP],
      entity: {
        ...TARGET_ENTITY,
        metadata: { ...TARGET_ENTITY.metadata, annotations: {} },
      },
    });
    const action = createSealSecretAction(deps);
    await expect(
      action.handler(
        ctxFor({
          entityRef: TARGET_REF,
          key: 'K',
          value: SECRET_VALUE,
          envs: ['dev'],
        }),
      ),
    ).rejects.toThrow(/source-location/);
    expect(octokitCalls.pullsCreate).not.toHaveBeenCalled();
  });
});

describe('capstone:seal-secret authorization (fails closed)', () => {
  it('admin (labmx) override: writes even without owning the Component', async () => {
    const { deps } = makeDeps({ actorGroups: [ADMIN_GROUP_REF] });
    serveShippedEs(['dev']);
    const action = createSealSecretAction(deps);
    await action.handler(
      ctxFor({
        entityRef: TARGET_REF,
        key: 'K',
        value: SECRET_VALUE,
        envs: ['dev'],
      }),
    );
    expect(vaultSetCalls).toHaveLength(1);
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(1);
  });

  it('non-owner: DENIED by the owner re-check — no Vault write, no Octokit', async () => {
    const { deps } = makeDeps({
      actorGroups: ['group:default/some-other-team'],
    });
    const action = createSealSecretAction(deps);
    await expect(
      action.handler(
        ctxFor({
          entityRef: TARGET_REF,
          key: 'K',
          value: SECRET_VALUE,
          envs: ['dev'],
        }),
      ),
    ).rejects.toThrow(NotAllowedError);
    expect(vaultSetCalls).toHaveLength(0);
    expect(octokitCalls.pullsCreate).not.toHaveBeenCalled();
  });

  it('policy DENY: fails closed even before the owner re-check', async () => {
    const { deps } = makeDeps({
      actorGroups: [OWNER_GROUP],
      policyResult: AuthorizeResult.DENY,
    });
    const action = createSealSecretAction(deps);
    await expect(
      action.handler(
        ctxFor({
          entityRef: TARGET_REF,
          key: 'K',
          value: SECRET_VALUE,
          envs: ['dev'],
        }),
      ),
    ).rejects.toThrow(NotAllowedError);
    expect(vaultSetCalls).toHaveLength(0);
  });
});
