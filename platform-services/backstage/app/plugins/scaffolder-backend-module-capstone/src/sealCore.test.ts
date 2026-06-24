/*
 * Unit tests for sealCore's LIST + DELETE paths (ESO+Vault model) — the action test covers
 * the SET path. These exercise the overlay-ExternalSecret data[] upsert/remove against a
 * realistic rendered ES (the shape the M4 scaffolder ships, #106):
 *  - listSecrets reports the secretKey NAMES per env from the overlay ES (names only, no Vault),
 *  - deleteSecret removes the Vault key AND drops just that data[] entry (file never deleted,
 *    the shipped app-secret entry preserved), opening a PR; 404 when the key is absent,
 *  - authz fail-closed (non-owner -> NotAllowedError, no Vault delete).
 */
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { NotAllowedError, NotFoundError } from '@backstage/errors';

// ── Mock VaultClient: record deleteKey calls ──────────────────────────────────────────────
const vaultDeleteCalls: Array<{ path: string; key: string }> = [];
jest.mock('./vaultClient', () => ({
  VaultClient: jest.fn().mockImplementation(() => ({
    setKey: jest.fn(async () => {}),
    deleteKey: jest.fn(async (path: string, key: string) => {
      vaultDeleteCalls.push({ path, key });
    }),
  })),
}));

// ── Mock integration creds + Octokit ──────────────────────────────────────────────────────
jest.mock('@backstage/integration', () => ({
  ScmIntegrations: { fromConfig: jest.fn(() => ({})) },
  DefaultGithubCredentialsProvider: {
    fromIntegrations: jest.fn(() => ({
      getCredentials: jest.fn(async () => ({ token: 'ghs_apptoken' })),
    })),
  },
}));

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
  listCommits: jest.fn<Promise<any>, any[]>(async () => ({
    data: [{ commit: { committer: { date: '2026-06-24T00:00:00Z' } } }],
  })),
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
      listCommits: octokitCalls.listCommits,
    },
    git: { getRef: octokitCalls.getRef, createRef: octokitCalls.createRef },
    pulls: { create: octokitCalls.pullsCreate },
  })),
}));

// eslint-disable-next-line import/first
import { listSecrets, deleteSecret } from './sealCore';

const TARGET_REF = 'component:default/my-app';
const OWNER_GROUP = 'group:default/team-alpha';

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
            getOptionalConfig: () => undefined,
          }
        : undefined,
  };
}

function makeDeps(actorGroups: string[], policy = AuthorizeResult.ALLOW): any {
  const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
  logger.child = () => logger;
  return {
    config: mockConfig(),
    logger,
    catalog: {
      getEntityByRef: jest.fn(async () => TARGET_ENTITY),
      getEntities: jest.fn(async () => ({
        items: actorGroups.map(ref => {
          const [ns, name] = ref.split(':')[1].split('/');
          return { kind: 'Group', metadata: { name, namespace: ns } };
        }),
      })),
    },
    permissions: { authorize: jest.fn(async () => [{ result: policy }]) },
    auth: { getOwnServiceCredentials: jest.fn(async () => ({ token: 'svc' })) },
  };
}

const CREDS: any = {
  $$type: '@backstage/BackstageCredentials',
  principal: { type: 'user', userEntityRef: 'user:default/alice' },
};

function overlayEs(env: string): string {
  return `.devops/chart/overlays/${env}/app-secret.externalsecret.yaml`;
}

function shippedEs(env: string, extraKeys: string[] = []): string {
  const lines = [
    'apiVersion: external-secrets.io/v1',
    'kind: ExternalSecret',
    'metadata:',
    '  name: my-app-secret',
    `  namespace: team-alpha-${env}`,
    'spec:',
    '  refreshInterval: "1h"',
    '  target:',
    '    name: my-app-secret',
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

/** getContent serving the shipped overlay ES for the given envs (with extra keys), 404 else. */
function serveEs(perEnvKeys: Record<string, string[]>) {
  octokitCalls.getContent.mockImplementation(async (opts: any) => {
    for (const [env, keys] of Object.entries(perEnvKeys)) {
      if (opts.path === overlayEs(env)) {
        return {
          data: {
            sha: `sha-${env}`,
            content: Buffer.from(shippedEs(env, keys), 'utf8').toString('base64'),
          },
        } as any;
      }
    }
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  });
}

function writtenFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of octokitCalls.createOrUpdateFileContents.mock.calls as any[]) {
    out[c[0].path] = Buffer.from(c[0].content, 'base64').toString('utf8');
  }
  return out;
}

beforeEach(() => {
  vaultDeleteCalls.length = 0;
  Object.values(octokitCalls).forEach(m => (m as jest.Mock).mockReset());
  octokitCalls.reposGet.mockImplementation(async () => ({
    data: { default_branch: 'main' },
  }));
  octokitCalls.getRef.mockImplementation(async () => ({
    data: { object: { sha: 'basesha' } },
  }));
  octokitCalls.listCommits.mockImplementation(async () => ({
    data: [{ commit: { committer: { date: '2026-06-24T00:00:00Z' } } }],
  }));
  octokitCalls.pullsCreate.mockImplementation(async (opts: { head: string }) => ({
    data: { html_url: `https://github.com/UA-MIS/my-app/pull/${opts.head}` },
  }));
  octokitCalls.getContent.mockImplementation(async () => {
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  });
});

describe('listSecrets', () => {
  it('reports the secretKey NAMES per env from the overlay ES (names only, no Vault)', async () => {
    serveEs({ dev: ['DATABASE_URL'], prod: [] });
    const out = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    // dev: app-secret (shipped) + DATABASE_URL; prod: app-secret only.
    expect(out.filter(s => s.env === 'dev').map(s => s.key).sort()).toEqual([
      'DATABASE_URL',
      'app-secret',
    ]);
    expect(out.filter(s => s.env === 'prod').map(s => s.key)).toEqual([
      'app-secret',
    ]);
    // last-updated populated from the commit date.
    expect(out[0].lastUpdated).toBe('2026-06-24T00:00:00Z');
  });

  it('returns [] when no overlay ES exists (non-tenant repo)', async () => {
    const out = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    expect(out).toEqual([]);
  });
});

describe('deleteSecret', () => {
  it('removes the Vault key + drops just that data[] entry, preserving the shipped entry', async () => {
    serveEs({ dev: ['DATABASE_URL'] });
    const res = await deleteSecret(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
    });

    // Vault key removed at the env path.
    expect(vaultDeleteCalls).toEqual([
      { path: 'tenants/team-alpha/dev/app', key: 'DATABASE_URL' },
    ]);
    // The overlay ES was rewritten: DATABASE_URL gone, the shipped app-secret entry kept.
    const es = writtenFiles()[overlayEs('dev')];
    expect(es).toBeDefined();
    expect(es).not.toContain('secretKey: DATABASE_URL');
    expect(es).not.toContain('property: DATABASE_URL');
    expect(es).toContain('secretKey: app-secret');
    expect(es).toContain('property: APP_SECRET');
    expect(es).toContain('kind: ExternalSecret');
    // A PR was opened.
    expect(res.pullRequestUrl).toContain('/pull/');
  });

  it('404s (no Vault delete, no PR) when the key is not declared anywhere', async () => {
    serveEs({ dev: [], prod: [] });
    await expect(
      deleteSecret(makeDeps([OWNER_GROUP]), {
        credentials: CREDS,
        entityRef: TARGET_REF,
        key: 'NONEXISTENT',
      }),
    ).rejects.toThrow(NotFoundError);
    expect(vaultDeleteCalls).toHaveLength(0);
    expect(octokitCalls.pullsCreate).not.toHaveBeenCalled();
  });

  it('non-owner: DENIED — no Vault delete, no PR', async () => {
    serveEs({ dev: ['DATABASE_URL'] });
    await expect(
      deleteSecret(makeDeps(['group:default/some-other-team']), {
        credentials: CREDS,
        entityRef: TARGET_REF,
        key: 'DATABASE_URL',
      }),
    ).rejects.toThrow(NotAllowedError);
    expect(vaultDeleteCalls).toHaveLength(0);
    expect(octokitCalls.pullsCreate).not.toHaveBeenCalled();
  });
});
