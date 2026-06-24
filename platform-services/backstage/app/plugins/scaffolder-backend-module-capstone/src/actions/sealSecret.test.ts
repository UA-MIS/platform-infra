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
                  secretsDir: '.devops/secrets',
                  overlayRelPath: '../../secrets',
                  overlaysDir: '.devops/chart/overlays',
                  targetSecretName: 'app-secrets',
                  secretStoreName: 'vault-tenant',
                  secretStoreKind: 'SecretStore',
                } as Record<string, string>
              )[k],
            getOptionalConfig: (_vk: string) => undefined, // vault.* -> defaults
          }
        : undefined,
  };
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
    const action = createSealSecretAction(deps);
    const ctx = ctxFor({
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
      value: SECRET_VALUE,
      envs: ['dev', 'prod'],
    });

    await action.handler(ctx);

    // One Vault write per env, at the per-env path, under the KEY, with the value.
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

    // One PR per env.
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(2);

    // The ExternalSecret committed per env (names only); + overlay reference.
    const files = writtenFiles();
    expect(files['.devops/secrets/externalsecret-dev.yaml']).toBeDefined();
    expect(files['.devops/secrets/externalsecret-prod.yaml']).toBeDefined();
    expect(
      files['.devops/chart/overlays/dev/kustomization.yaml'],
    ).toBeDefined();

    // Output: two PR URLs.
    expect(ctx.output).toHaveBeenCalledWith(
      'pullRequestUrls',
      expect.arrayContaining([expect.stringContaining('/pull/')]),
    );
  });

  it('the committed ExternalSecret contains NO secret value — only names + Vault pointers', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    const action = createSealSecretAction(deps);
    await action.handler(
      ctxFor({
        entityRef: TARGET_REF,
        key: 'API_KEY',
        value: SECRET_VALUE,
        envs: ['dev'],
      }),
    );

    const es = writtenFiles()['.devops/secrets/externalsecret-dev.yaml'];
    expect(es).toContain('kind: ExternalSecret');
    expect(es).toContain('secretKey: "API_KEY"');
    expect(es).toContain('key: "tenants/team-alpha/dev/app"');
    expect(es).toContain('property: "API_KEY"');
    // The VALUE is never in git.
    expect(es).not.toContain(SECRET_VALUE);
  });

  it('NEVER logs the plaintext value', async () => {
    const { deps, loggerCalls } = makeDeps({ actorGroups: [OWNER_GROUP] });
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

  it('merges a second key into an existing env ExternalSecret (keeps the first)', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    // The dev ExternalSecret already declares EXISTING_KEY.
    const existingEs = [
      'apiVersion: external-secrets.io/v1',
      'kind: ExternalSecret',
      'spec:',
      '  data:',
      '    - secretKey: "EXISTING_KEY"',
      '      remoteRef:',
      '        key: "tenants/team-alpha/dev/app"',
      '        property: "EXISTING_KEY"',
      '',
    ].join('\n');
    octokitCalls.getContent.mockImplementation(async (opts: any) => {
      if (opts.path.endsWith('externalsecret-dev.yaml')) {
        return {
          data: {
            sha: 'essha',
            content: Buffer.from(existingEs, 'utf8').toString('base64'),
          },
        } as any;
      }
      const e = new Error('Not Found') as Error & { status: number };
      e.status = 404;
      throw e;
    });
    const action = createSealSecretAction(deps);
    await action.handler(
      ctxFor({
        entityRef: TARGET_REF,
        key: 'NEW_KEY',
        value: SECRET_VALUE,
        envs: ['dev'],
      }),
    );

    const es = writtenFiles()['.devops/secrets/externalsecret-dev.yaml'];
    expect(es).toContain('property: "EXISTING_KEY"');
    expect(es).toContain('property: "NEW_KEY"');
    // It overwrote the existing file (passed its sha).
    const esWrite = octokitCalls.createOrUpdateFileContents.mock.calls.find(
      (c: any) => c[0].path.endsWith('externalsecret-dev.yaml'),
    );
    expect(esWrite?.[0].sha).toBe('essha');
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
