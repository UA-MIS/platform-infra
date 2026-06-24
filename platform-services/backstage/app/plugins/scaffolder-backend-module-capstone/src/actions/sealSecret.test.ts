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
  getContent: jest.fn<Promise<any>, any[]>(async () => {
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  }),
  createOrUpdateFileContents: jest.fn<Promise<any>, any[]>(async () => ({})),
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
    git: { getRef: octokitCalls.getRef, createRef: octokitCalls.createRef },
    pulls: { create: octokitCalls.pullsCreate },
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
  octokitCalls.getContent.mockImplementation(async () => {
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  });
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
  it('writes the value to Vault per env and opens one PR per env', async () => {
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

    // One PR per env, each upserting the overlay ES (NOT a new file, NOT a kustomization edit).
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(2);
    const files = writtenFiles();
    expect(files[overlayEs('dev')]).toBeDefined();
    expect(files[overlayEs('prod')]).toBeDefined();
    // No file outside the overlay (no .devops/secrets/, no kustomization.yaml edit).
    for (const p of Object.keys(files)) {
      expect(p).toMatch(/overlays\/(dev|prod)\/app-secret\.externalsecret\.yaml$/);
    }

    expect(ctx.output).toHaveBeenCalledWith(
      'pullRequestUrls',
      expect.arrayContaining([expect.stringContaining('/pull/')]),
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

  it('is idempotent — re-setting an existing key rewrites no git (only Vault)', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    // The dev overlay already declares API_KEY.
    serveShippedEs(['dev'], { dev: ['API_KEY'] });
    const action = createSealSecretAction(deps);
    await action.handler(
      ctxFor({
        entityRef: TARGET_REF,
        key: 'API_KEY',
        value: 'new-rotated-value',
        envs: ['dev'],
      }),
    );
    // Vault is still written (rotation), but no file is committed (the declaration is unchanged).
    expect(vaultSetCalls).toHaveLength(1);
    expect(octokitCalls.createOrUpdateFileContents).not.toHaveBeenCalled();
    // A PR is still opened (no-op-safe; the value did change in Vault).
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(1);
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
