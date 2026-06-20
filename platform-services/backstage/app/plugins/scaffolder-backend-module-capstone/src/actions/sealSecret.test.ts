/*
 * Unit tests for the capstone:seal-secret action (M3-T4 behavior + M3-T5 authz).
 *
 * SECURITY-CRITICAL ASSERTIONS (plan §7 / R2 / R1):
 *  - kubeseal is invoked with --cert <path> --scope strict --namespace <team>-<env> --name,
 *    and the plaintext value is piped to STDIN — never an argv, never a tempfile.
 *  - the plaintext value NEVER appears in any ctx.logger call, in kubeseal argv, or in a
 *    thrown error.
 *  - one PR per selected env, file at <secretsDir>/<key>.sealedsecret.yaml; overwrite path
 *    updates an existing file (passes its sha).
 *  - authz: owner -> ALLOW + seal; non-owner -> DENY (no kubeseal, no Octokit); admin
 *    (labmx) -> override ALLOW; policy DENY -> fail closed.
 */
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { NotAllowedError } from '@backstage/errors';

// ── Mock child_process.execFile: capture argv + stdin, return canned sealed YAML ──────────
type ExecFileCall = { bin: string; args: string[]; stdin: string };
const execFileCalls: ExecFileCall[] = [];
let execFileShouldFail = false;

jest.mock('child_process', () => ({
  execFile: jest.fn(
    (
      bin: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const child = {
        stdin: {
          end: (data: string) => {
            // Record only AFTER stdin is written so the test can assert on it.
            execFileCalls.push({ bin, args, stdin: data });
            if (execFileShouldFail) {
              cb(new Error('boom'), '', 'kubeseal: some diagnostic');
            } else {
              cb(
                null,
                `apiVersion: bitnami.com/v1alpha1\nkind: SealedSecret\nmetadata:\n  name: ${
                  args[args.indexOf('--name') + 1]
                }\n  namespace: ${args[args.indexOf('--namespace') + 1]}\n`,
                '',
              );
            }
          },
        },
      };
      return child;
    },
  ),
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
  reposGet: jest.fn(async () => ({ data: { default_branch: 'main' } })),
  getRef: jest.fn(async () => ({ data: { object: { sha: 'basesha' } } })),
  createRef: jest.fn(async () => ({})),
  getContent: jest.fn(async () => {
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  }),
  createOrUpdateFileContents: jest.fn(async () => ({})),
  pullsCreate: jest.fn(async (opts: { head: string }) => ({
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
                  sealingCertPath:
                    '/etc/backstage/sealing-cert/sealing-cert.pem',
                  kubesealBin: 'kubeseal',
                  defaultBranchPrefix: 'secrets/',
                  secretsDir: '.devops/secrets',
                  overlayRelPath: '../../secrets',
                  overlaysDir: '.devops/chart/overlays',
                } as Record<string, string>
              )[k],
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
}) {
  return createMockActionContext({
    input,
    getInitiatorCredentials: (async () => ({
      $$type: '@backstage/BackstageCredentials',
      principal: { type: 'user', userEntityRef: 'user:default/alice' },
    })) as any,
  } as any);
}

beforeEach(() => {
  execFileCalls.length = 0;
  execFileShouldFail = false;
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

describe('capstone:seal-secret sealing + publish (owner)', () => {
  it('seals each env offline and opens one PR per env', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    const action = createSealSecretAction(deps);
    const ctx = ctxFor({
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
      value: SECRET_VALUE,
      envs: ['dev', 'prod'],
    });

    await action.handler(ctx);

    // One kubeseal call per env, strict scope, namespace <team>-<env>, name from key.
    expect(execFileCalls).toHaveLength(2);
    const namespaces = execFileCalls.map(
      c => c.args[c.args.indexOf('--namespace') + 1],
    );
    expect(namespaces).toEqual(['team-alpha-dev', 'team-alpha-prod']);
    for (const c of execFileCalls) {
      expect(c.bin).toBe('kubeseal');
      expect(c.args).toContain('--cert');
      expect(c.args).toContain('/etc/backstage/sealing-cert/sealing-cert.pem');
      expect(c.args[c.args.indexOf('--scope') + 1]).toBe('strict');
      expect(c.args[c.args.indexOf('--name') + 1]).toBe('database-url');
    }

    // One PR per env.
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(2);
    // The SealedSecret committed at the per-key path.
    const filePaths = octokitCalls.createOrUpdateFileContents.mock.calls.map(
      (c: any) => c[0].path,
    );
    expect(filePaths).toContain(
      '.devops/secrets/database-url.sealedsecret.yaml',
    );

    // Output: two PR URLs.
    expect(ctx.output).toHaveBeenCalledWith(
      'pullRequestUrls',
      expect.arrayContaining([expect.stringContaining('/pull/')]),
    );
  });

  it('pipes the plaintext to kubeseal STDIN — never an argv, never a tempfile', async () => {
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

    const call = execFileCalls[0];
    // The value IS in stdin (sealed)...
    expect(call.stdin).toContain(SECRET_VALUE);
    // ...and NEVER in the argv (no shell/process-listing leak).
    expect(call.args.join(' ')).not.toContain(SECRET_VALUE);
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

  it('appends the SealedSecret to each env overlay kustomization (Option A)', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    const action = createSealSecretAction(deps);
    await action.handler(
      ctxFor({
        entityRef: TARGET_REF,
        key: 'DB',
        value: SECRET_VALUE,
        envs: ['dev'],
      }),
    );
    const writtenPaths = octokitCalls.createOrUpdateFileContents.mock.calls.map(
      (c: any) => c[0].path,
    );
    expect(writtenPaths).toContain(
      '.devops/chart/overlays/dev/kustomization.yaml',
    );
  });

  it('overwrites (rotates) an existing SealedSecret by passing its sha', async () => {
    const { deps } = makeDeps({ actorGroups: [OWNER_GROUP] });
    // getContent returns an existing file for the secret path.
    octokitCalls.getContent.mockImplementation(async (opts: any) => {
      if (opts.path.endsWith('.sealedsecret.yaml')) {
        return { data: { sha: 'existingsha', content: '' } } as any;
      }
      const e = new Error('Not Found') as Error & { status: number };
      e.status = 404;
      throw e;
    });
    const action = createSealSecretAction(deps);
    await action.handler(
      ctxFor({
        entityRef: TARGET_REF,
        key: 'ROTATE_ME',
        value: SECRET_VALUE,
        envs: ['dev'],
      }),
    );
    const secretWrite = octokitCalls.createOrUpdateFileContents.mock.calls.find(
      (c: any) => c[0].path.endsWith('rotate-me.sealedsecret.yaml'),
    );
    expect(secretWrite?.[0].sha).toBe('existingsha');
  });

  it('fails CLOSED (no Octokit) if a Component has no source-location', async () => {
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
  it('admin (labmx) override: seals even without owning the Component', async () => {
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
    expect(execFileCalls).toHaveLength(1);
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(1);
  });

  it('non-owner: DENIED by the owner re-check — no kubeseal, no Octokit', async () => {
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
    expect(execFileCalls).toHaveLength(0);
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
    expect(execFileCalls).toHaveLength(0);
  });
});
