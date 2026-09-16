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

// ── Mock VaultClient: record setKey + deleteKey calls ─────────────────────────────────────
const vaultDeleteCalls: Array<{ path: string; key: string }> = [];
const vaultSetCalls: Array<{ path: string; key: string }> = [];
jest.mock('./vaultClient', () => ({
  VaultClient: jest.fn().mockImplementation(() => ({
    setKey: jest.fn(async (path: string, key: string) => {
      vaultSetCalls.push({ path, key });
    }),
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
  updateRef: jest.fn<Promise<any>, any[]>(async () => ({})),
  getContent: jest.fn<Promise<any>, any[]>(async () => {
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  }),
  createOrUpdateFileContents: jest.fn<Promise<any>, any[]>(async () => ({})),
  listCommits: jest.fn<Promise<any>, any[]>(async () => ({
    data: [{ commit: { committer: { date: '2026-06-24T00:00:00Z' } } }],
  })),
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
      listCommits: octokitCalls.listCommits,
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
import {
  listSecrets,
  deleteSecret,
  listMyProjects,
  sealAndPublish,
} from './sealCore';

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

/**
 * The SEC-057 attack file: a repo-owned overlay ExternalSecret whose remoteRef.key has been
 * edited to aim at ANOTHER team's Vault object. Byte-for-byte the shipped shape otherwise —
 * the only difference is the one line a student can change in their own repository.
 */
function tamperedEs(env: string, victimKey: string): string {
  return shippedEs(env).replace(
    `key: tenants/team-alpha/${env}/app`,
    `key: ${victimKey}`,
  );
}

function serveTamperedEs(env: string, victimKey: string) {
  octokitCalls.getContent.mockImplementation(async (opts: any) => {
    if (opts.path === overlayEs(env)) {
      return {
        data: {
          sha: `sha-${env}`,
          content: Buffer.from(tamperedEs(env, victimKey), 'utf8').toString(
            'base64',
          ),
        },
      } as any;
    }
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  });
}

/**
 * The SAFE overlay shape the templates ship after the 2026-09 ESO incident: `dataFrom: extract`
 * (no per-property atomic failure) plus the inert `platform.capstone/declared-keys` annotation
 * that carries the key NAMES for display. `annKeys: undefined` omits the annotation entirely.
 */
function dataFromEs(
  env: string,
  annKeys?: string[],
  opts: { annotationsBlock?: boolean } = {},
): string {
  const lines = [
    'apiVersion: external-secrets.io/v1',
    'kind: ExternalSecret',
    'metadata:',
    '  name: my-app-secret',
    `  namespace: team-alpha-${env}`,
  ];
  if (annKeys !== undefined || opts.annotationsBlock) {
    lines.push('  annotations:');
    if (annKeys !== undefined) {
      lines.push(
        `    platform.capstone/declared-keys: ${JSON.stringify(annKeys.join(','))}`,
      );
    }
  }
  lines.push(
    '  labels:',
    '    app.kubernetes.io/name: my-app',
    'spec:',
    '  refreshInterval: "1h"',
    '  target:',
    '    name: my-app-secret',
    '    deletionPolicy: Delete',
    '  dataFrom:',
    '    - extract:',
    `        key: tenants/team-alpha/${env}/app`,
    '',
  );
  return lines.join('\n');
}

/** getContent serving an EXACT yaml body per env (for shapes serveEs cannot express). */
function serveRawEs(perEnvYaml: Record<string, string>) {
  octokitCalls.getContent.mockImplementation(async (opts: any) => {
    for (const [env, body] of Object.entries(perEnvYaml)) {
      if (opts.path === overlayEs(env)) {
        return {
          data: {
            sha: `sha-${env}`,
            content: Buffer.from(body, 'utf8').toString('base64'),
          },
        } as any;
      }
    }
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  });
}

/** The declared-keys annotation value written to `path`, or undefined if there is none. */
function annotationOf(yaml: string): string | undefined {
  const m = yaml.match(
    /^\s*platform\.capstone\/declared-keys:\s*(.*)$/m,
  );
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

beforeEach(() => {
  vaultDeleteCalls.length = 0;
  vaultSetCalls.length = 0;
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
  octokitCalls.pullsList.mockImplementation(async () => ({ data: [] }));
  octokitCalls.pullsCreate.mockImplementation(async (opts: { head: string }) => ({
    data: { html_url: `https://github.com/UA-MIS/my-app/pull/${opts.head}` },
  }));
  octokitCalls.getContent.mockImplementation(async () => {
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  });
});

/*
 * SEC-057 (#183) — the destination, not the identity.
 *
 * The caller here is a LEGITIMATE, fully-authorized owner of my-app: the permission check
 * passes and the owner intersection passes. That is the whole point — this is not an authz
 * bypass, and no authz test would have caught it. The attack is that the WRITE TARGET was read
 * verbatim out of a file in the caller's own repository, so owning one app granted write access
 * to every other team's Vault object under the `secret/data/tenants/*` policy glob.
 */
describe('SEC-057: the Vault destination is checked against the derived team', () => {
  const VICTIM = 'tenants/wizarddress/prod/app';

  it('SEAL: refuses a repo file aiming at another team, and writes NOTHING to Vault', async () => {
    serveTamperedEs('prod', VICTIM);
    await expect(
      sealAndPublish(makeDeps([OWNER_GROUP]), {
        credentials: CREDS,
        entityRef: TARGET_REF,
        key: 'APP_SECRET',
        value: 'pwned',
        envs: ['prod'],
      }),
    ).rejects.toThrow(NotAllowedError);

    // The security assertion: the victim's object was never touched.
    expect(vaultSetCalls).toEqual([]);
    // ...and no git side effect either (fails closed BEFORE the branch/PR machinery).
    expect(octokitCalls.createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(octokitCalls.pullsCreate).not.toHaveBeenCalled();
  });

  it('DELETE: refuses the same tampered file, and deletes NOTHING from Vault', async () => {
    serveTamperedEs('prod', VICTIM);
    await expect(
      deleteSecret(makeDeps([OWNER_GROUP]), {
        credentials: CREDS,
        entityRef: TARGET_REF,
        key: 'app-secret',
      }),
    ).rejects.toThrow(NotAllowedError);
    expect(vaultDeleteCalls).toEqual([]);
  });

  it('the refusal NAMES the file, the bad value and the fix (no TA — the message is the support experience)', async () => {
    serveTamperedEs('prod', VICTIM);
    const err = await sealAndPublish(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'APP_SECRET',
      value: 'pwned',
      envs: ['prod'],
    }).catch((e: unknown) => e);

    // Narrow deliberately rather than casting. `.catch()` widens the result to
    // `Error | <success shape>`, and the assertions below are only meaningful against a
    // rejection: if this call ever RESOLVES, the seal went through against the victim's
    // path, which is precisely the regression this test exists to catch. Fail loudly here
    // instead of letting a wrong-shaped value make the assertions vacuous.
    if (!(err instanceof Error)) {
      throw new Error(
        `expected sealAndPublish to reject with an Error, but it resolved with: ${JSON.stringify(
          err,
        )}`,
      );
    }

    expect(err.message).toContain('.devops/chart/overlays/prod/app-secret.externalsecret.yaml');
    expect(err.message).toContain(VICTIM); // what it found
    expect(err.message).toContain('tenants/team-alpha/prod/app'); // what it should be
    expect(err.message).toContain('Nothing was written'); // the reassurance
  });

  it('REGRESSION GUARD: the legitimate, untampered path still seals normally', async () => {
    serveEs({ prod: [] });
    await sealAndPublish(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'NEW_KEY',
      value: 'v',
      envs: ['prod'],
    });
    // The whole cohort uses this path every time they save a secret. If this test ever fails,
    // the constraint is too tight and the Secrets tab is broken for everyone.
    expect(vaultSetCalls).toEqual([
      { path: 'tenants/team-alpha/prod/app', key: 'NEW_KEY' },
    ]);
  });

  it('a file that declares NO key at all still falls back to the derived path (unchanged)', async () => {
    const noKey = shippedEs('prod')
      .split('\n')
      .filter(l => !l.trim().startsWith('key: '))
      .join('\n');
    octokitCalls.getContent.mockImplementation(async (opts: any) => {
      if (opts.path === overlayEs('prod')) {
        return {
          data: {
            sha: 'sha-prod',
            content: Buffer.from(noKey, 'utf8').toString('base64'),
          },
        } as any;
      }
      const e = new Error('Not Found') as Error & { status: number };
      e.status = 404;
      throw e;
    });
    await sealAndPublish(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'K',
      value: 'v',
      envs: ['prod'],
    });
    expect(vaultSetCalls).toEqual([
      { path: 'tenants/team-alpha/prod/app', key: 'K' },
    ]);
  });
});

describe('listSecrets', () => {
  it('reports the secretKey NAMES per env from the overlay ES (names only, no Vault)', async () => {
    serveEs({ dev: ['DATABASE_URL'], prod: [] });
    const { secrets } = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    // dev: app-secret (shipped) + DATABASE_URL; prod: app-secret only.
    expect(secrets.filter(s => s.env === 'dev').map(s => s.key).sort()).toEqual([
      'DATABASE_URL',
      'app-secret',
    ]);
    expect(secrets.filter(s => s.env === 'prod').map(s => s.key)).toEqual([
      'app-secret',
    ]);
    // last-updated populated from the commit date.
    expect(secrets[0].lastUpdated).toBe('2026-06-24T00:00:00Z');
  });

  it('returns no secrets when no overlay ES exists (non-tenant repo)', async () => {
    const { secrets, environments } = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    expect(secrets).toEqual([]);
    // No overlay at all -> the env is not reported as configured.
    expect(environments).toEqual([]);
  });

  // ── THE BUG (#secrets-tab invisible envs) ───────────────────────────────────────────────
  // An overlay on the SAFE `dataFrom: extract` shape has no `secretKey:` lines at all, so the
  // old scrape returned [] and the `continue` dropped the whole env from the response.
  it('reports keys declared ONLY by the annotation (dataFrom overlay, no secretKey lines)', async () => {
    serveRawEs({ prod: dataFromEs('prod', ['beta_emails', 'watch_mode_key']) });
    const { secrets } = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    expect(secrets.filter(s => s.env === 'prod').map(s => s.key)).toEqual([
      'beta_emails',
      'watch_mode_key',
    ]);
  });

  it('still reports a legacy explicit data[] overlay with no annotation (curb-web shape)', async () => {
    serveEs({ prod: ['TICKETMASTER_API_KEY', 'MAPS_KEY'] });
    const { secrets } = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    expect(secrets.filter(s => s.env === 'prod').map(s => s.key).sort()).toEqual([
      'MAPS_KEY',
      'TICKETMASTER_API_KEY',
      'app-secret',
    ]);
  });

  it('de-duplicates a key that is BOTH annotated and in data[], and sorts stably', async () => {
    // shippedEs declares `app-secret` in data[]; annotate an overlapping + a new key.
    const yaml = shippedEs('dev', ['ZEBRA']).replace(
      '  name: my-app-secret',
      '  name: my-app-secret\n  annotations:\n    platform.capstone/declared-keys: "ZEBRA,alpha,app-secret"',
    );
    serveRawEs({ dev: yaml });
    const { secrets } = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    const keys = secrets.filter(s => s.env === 'dev').map(s => s.key);
    expect(keys).toEqual(['ZEBRA', 'alpha', 'app-secret']); // deduped + stably sorted
  });

  it('reports an env that exists but declares NOTHING, instead of dropping it', async () => {
    serveRawEs({ staging: dataFromEs('staging', []) });
    const { secrets, environments } = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    expect(secrets).toEqual([]);
    expect(environments).toEqual([
      {
        env: 'staging',
        declaredKeyCount: 0,
        lastUpdated: '2026-06-24T00:00:00Z',
      },
    ]);
  });

  it('tolerates a malformed / absent annotation and falls back to the data[] scrape', async () => {
    const empties = [
      dataFromEs('dev', undefined, { annotationsBlock: true }), // annotations: block, no key
      dataFromEs('staging'), // no annotations block at all
    ];
    serveRawEs({ dev: empties[0], staging: empties[1] });
    const { secrets, environments } = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    expect(secrets).toEqual([]);
    expect(environments.map(e => e.env).sort()).toEqual(['dev', 'staging']);
  });

  it('ignores junk/empty entries in the annotation value rather than listing blank keys', async () => {
    serveRawEs({ dev: dataFromEs('dev', []).replace(
      'platform.capstone/declared-keys: ""',
      'platform.capstone/declared-keys: " , ,A_KEY,,  "',
    ) });
    const { secrets } = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    expect(secrets.map(s => s.key)).toEqual(['A_KEY']);
  });

  // The annotation is read from the ExternalSecret's OWN metadata only. A tenant may also set
  // spec.target.template.metadata.annotations (those land on the generated Secret) — reading
  // those as declared keys would report keys the Secrets tab does not manage.
  it('reads only the top-level metadata annotation, not spec.target.template annotations', async () => {
    const yaml = dataFromEs('dev', ['REAL_KEY']).replace(
      '    deletionPolicy: Delete',
      [
        '    deletionPolicy: Delete',
        '    template:',
        '      metadata:',
        '        annotations:',
        '          platform.capstone/declared-keys: "NOT_A_DECLARED_KEY"',
      ].join('\n'),
    );
    serveRawEs({ dev: yaml });
    const { secrets } = await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    expect(secrets.map(s => s.key)).toEqual(['REAL_KEY']);
  });

  it('never contacts Vault while listing (names come from git only)', async () => {
    serveRawEs({ prod: dataFromEs('prod', ['beta_emails']) });
    await listSecrets(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
    });
    expect(vaultSetCalls).toEqual([]);
    expect(vaultDeleteCalls).toEqual([]);
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

/**
 * A single cohesive in-memory GitHub repo simulator (D-118 review follow-up, PR #500) backing
 * ALL the octokit calls the rolling-PR lifecycle touches — branch refs, PR state
 * (open/closed/merged), and file content+sha — wired together with REAL GitHub semantics: a file
 * commit really does advance its branch's tip sha, a sha-mismatch on a file write really 409s,
 * and a duplicate ref/PR create really 422s. This is what makes the CONCURRENCY tests below
 * meaningful — a static happy-path stub (like serveEs, still used by the simpler non-racing
 * tests above) cannot exercise a real conflict or a real "no commits yet" 422.
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
    // A real commit landed on this branch — advance its tracked tip sha.
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

describe('deleteSecret rolling PR (D-118)', () => {
  it('reuses the SAME rolling PR across multiple deleted keys — one rolling PR, no new PR', async () => {
    mockGithubRepo({ [overlayEs('dev')]: shippedEs('dev', ['DATABASE_URL', 'API_KEY']) });

    const res1 = await deleteSecret(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
    });
    const res2 = await deleteSecret(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'API_KEY',
    });

    expect(res1.pullRequestUrl).toBe(res2.pullRequestUrl);
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(1);
    expect(octokitCalls.createRef).toHaveBeenCalledTimes(1);
    expect(octokitCalls.createRef.mock.calls[0][0]).toMatchObject({
      ref: 'refs/heads/secrets/pending',
    });
  });

  it('opens a NEW PR after the previous one merged (stale branch reset, fresh PR)', async () => {
    const repo = mockGithubRepo({
      [overlayEs('dev')]: shippedEs('dev', ['DATABASE_URL', 'API_KEY']),
    });

    const res1 = await deleteSecret(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
    });
    repo.mergePr(); // the PR merged — branch is now stale (no open PR references it)

    const res2 = await deleteSecret(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'API_KEY',
    });

    expect(res2.pullRequestUrl).not.toBe(res1.pullRequestUrl);
    expect(octokitCalls.pullsCreate).toHaveBeenCalledTimes(2); // a FRESH PR was opened
    expect(octokitCalls.createRef).toHaveBeenCalledTimes(1); // branch created ONCE, reused
    expect(octokitCalls.updateRef).toHaveBeenCalledTimes(1); // reset-to-base before the new PR
  });

  it('WARNS when resetting a rolling branch whose last PR was CLOSED WITHOUT MERGING (D-118 tradeoff)', async () => {
    const repo = mockGithubRepo({
      [overlayEs('dev')]: shippedEs('dev', ['DATABASE_URL', 'API_KEY']),
    });
    const loggerCalls: string[] = [];
    const deps = makeDeps([OWNER_GROUP]);
    deps.logger.warn = (m: string) => loggerCalls.push(m);

    await deleteSecret(deps, {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'DATABASE_URL',
    });
    repo.closePrWithoutMerging(); // a human closed it without merging

    await deleteSecret(deps, {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'API_KEY',
    });

    expect(loggerCalls.join('\n')).toMatch(/CLOSED WITHOUT MERGING/);
  });

  it('CONCURRENCY: two simultaneous deletes for DIFFERENT keys in the SAME env do not lose either removal (lost-update fix)', async () => {
    const repo = mockGithubRepo({
      [overlayEs('dev')]: shippedEs('dev', ['DATABASE_URL', 'API_KEY']),
    });

    // Real Promise.all — NOT sequential awaits — so the shared overlay file write genuinely
    // races through casUpdateFile's compare-and-swap retry (PR #500 review point 6).
    const [res1, res2] = await Promise.all([
      deleteSecret(makeDeps([OWNER_GROUP]), {
        credentials: CREDS,
        entityRef: TARGET_REF,
        key: 'DATABASE_URL',
      }),
      deleteSecret(makeDeps([OWNER_GROUP]), {
        credentials: CREDS,
        entityRef: TARGET_REF,
        key: 'API_KEY',
      }),
    ]);

    expect(res1.pullRequestUrl).toBe(res2.pullRequestUrl); // exactly ONE PR, both converged

    // BOTH removals survived — neither writer's change was silently clobbered by the other's.
    const es = repo.files.get(overlayEs('dev'))!.content;
    expect(es).not.toContain('secretKey: DATABASE_URL');
    expect(es).not.toContain('secretKey: API_KEY');
    expect(es).toContain('secretKey: app-secret'); // the shipped entry survived too
  });
});

// ── listMyProjects against a REALISTIC catalog (filter semantics actually evaluated) ──────
//
// Regression coverage for the live-data bug found while investigating "labmx sees an empty
// project picker": the GitHub-org provider writes Group.spec.members as `<namespace>/<login>`
// (e.g. "default/ccsmith33") — confirmed against the production catalog DB — NOT the bare
// login that resolveActorOwnership's `spec.members` clause used to check. That meant the
// `spec.members` fallback was silently dead code and admin recognition rode entirely on
// `relations.hasMember`. These tests implement a small real filter evaluator (OR across filter
// objects, AND within one) instead of the ignore-the-filter mock used above, so a regression
// to the old (broken) clause shape fails the test.
function matchesClause(entity: any, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(([key, val]) => {
    if (key === 'kind') return entity.kind === val;
    if (key === 'relations.hasMember') {
      return (entity.relations ?? []).some(
        (r: any) => r.type === 'hasMember' && r.targetRef === val,
      );
    }
    if (key === 'spec.members') {
      return (entity.spec?.members ?? []).includes(val);
    }
    return false;
  });
}

function realisticCatalog(entities: any[]) {
  return {
    getEntities: jest.fn(async (query: any) => {
      const clauses: any[] = Array.isArray(query.filter)
        ? query.filter
        : [query.filter];
      return {
        items: entities.filter(e => clauses.some(c => matchesClause(e, c))),
      };
    }),
  };
}

const CCSMITH33: any = {
  $$type: '@backstage/BackstageCredentials',
  principal: { type: 'user', userEntityRef: 'user:default/ccsmith33' },
};

/** Shaped exactly like the live labmx Group row: spec.members in `default/<login>` form. */
function labmxGroup(withRelation: boolean): any {
  return {
    kind: 'Group',
    metadata: { name: 'labmx', namespace: 'default' },
    spec: { members: ['default/ccsmith33'] },
    relations: withRelation
      ? [{ type: 'hasMember', targetRef: 'user:default/ccsmith33' }]
      : [],
  };
}

function component(name: string, ownerGroup: string): any {
  return {
    kind: 'Component',
    metadata: { name, namespace: 'default', title: name },
    spec: { owner: ownerGroup },
    relations: [{ type: 'ownedBy', targetRef: `group:default/${ownerGroup}` }],
  };
}

describe('listMyProjects (realistic catalog filter evaluation)', () => {
  it('admin (labmx) sees ALL Components, including ones they do not own', async () => {
    const catalog = realisticCatalog([
      labmxGroup(true),
      component('swami', 'swami'),
      component('acme-web', 'acme'),
    ]);
    const deps: any = {
      catalog,
      auth: { getOwnServiceCredentials: jest.fn(async () => ({ token: 'svc' })) },
    };
    const projects = await listMyProjects(deps, { credentials: CCSMITH33 });
    expect(projects.map(p => p.entityRef).sort()).toEqual([
      'component:default/acme-web',
      'component:default/swami',
    ]);
  });

  it('REGRESSION: admin is still recognized via spec.members alone when relations.hasMember has not stitched yet', async () => {
    // withRelation=false: the ONLY way to find labmx membership is the spec.members clause,
    // in its ACTUAL live shape ("default/ccsmith33"). This is exactly the relation-stitching-
    // lag window the F1 comment describes; before the fix this returned isAdmin=false here.
    const catalog = realisticCatalog([
      labmxGroup(false),
      component('swami', 'swami'),
    ]);
    const deps: any = {
      catalog,
      auth: { getOwnServiceCredentials: jest.fn(async () => ({ token: 'svc' })) },
    };
    const projects = await listMyProjects(deps, { credentials: CCSMITH33 });
    expect(projects.map(p => p.entityRef)).toEqual(['component:default/swami']);
  });

  it('non-admin sees only Components their groups own', async () => {
    const catalog = realisticCatalog([
      {
        kind: 'Group',
        metadata: { name: 'acme', namespace: 'default' },
        spec: { members: ['default/bob'] },
        relations: [{ type: 'hasMember', targetRef: 'user:default/bob' }],
      },
      component('swami', 'swami'),
      component('acme-web', 'acme'),
    ]);
    const deps: any = {
      catalog,
      auth: { getOwnServiceCredentials: jest.fn(async () => ({ token: 'svc' })) },
    };
    const bob: any = {
      $$type: '@backstage/BackstageCredentials',
      principal: { type: 'user', userEntityRef: 'user:default/bob' },
    };
    const projects = await listMyProjects(deps, { credentials: bob });
    expect(projects.map(p => p.entityRef)).toEqual(['component:default/acme-web']);
  });
});

// ── The declared-keys ANNOTATION contract (write + delete keep it accurate) ────────────────
describe('declared-keys annotation: write path', () => {
  it('records a new key in the annotation WITHOUT adding a fragile data[] entry (dataFrom overlay)', async () => {
    serveRawEs({ prod: dataFromEs('prod', ['beta_emails']) });
    await sealAndPublish(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'watch_mode_key',
      value: 'v',
      envs: ['prod'],
    });
    const written = writtenFiles()[overlayEs('prod')];
    expect(annotationOf(written)).toBe('beta_emails,watch_mode_key');
    // The whole point: ESO keeps syncing via dataFrom/extract. No explicit data[] entry is
    // introduced, so the all-or-nothing failure mode is not reintroduced.
    expect(written).not.toMatch(/secretKey:/);
    expect(written).toMatch(/dataFrom:/);
  });

  it('creates the annotations block when the overlay has none', async () => {
    serveRawEs({ dev: dataFromEs('dev') }); // no annotations: block at all
    await sealAndPublish(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'FIRST_KEY',
      value: 'v',
      envs: ['dev'],
    });
    const written = writtenFiles()[overlayEs('dev')];
    expect(annotationOf(written)).toBe('FIRST_KEY');
    // must sit inside metadata:, above spec:
    expect(written.indexOf('platform.capstone/declared-keys')).toBeLessThan(
      written.indexOf('spec:'),
    );
  });

  it('keeps the annotation list sorted and de-duplicated so diffs stay clean', async () => {
    serveRawEs({ dev: dataFromEs('dev', ['b_key', 'd_key']) });
    await sealAndPublish(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'c_key',
      value: 'v',
      envs: ['dev'],
    });
    expect(annotationOf(writtenFiles()[overlayEs('dev')])).toBe(
      'b_key,c_key,d_key',
    );
  });

  it('re-sealing an already-declared key changes nothing in git (Vault-only rotation)', async () => {
    serveRawEs({ dev: dataFromEs('dev', ['EXISTING']) });
    const res = await sealAndPublish(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'EXISTING',
      value: 'rotated',
      envs: ['dev'],
    });
    expect(vaultSetCalls).toEqual([
      { path: 'tenants/team-alpha/dev/app', key: 'EXISTING' },
    ]);
    expect(octokitCalls.createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(res.pullRequestUrls).toEqual([]);
  });

  it('BACKWARD COMPAT: a legacy data[] overlay still gets its data[] entry, plus the annotation', async () => {
    serveEs({ prod: [] }); // shippedEs: explicit data[], no dataFrom, no annotation
    await sealAndPublish(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'NEW_KEY',
      value: 'v',
      envs: ['prod'],
    });
    const written = writtenFiles()[overlayEs('prod')];
    // ESO on this shape can ONLY see the key via data[] — it must still be written.
    expect(written).toMatch(/- secretKey: "NEW_KEY"/);
    expect(annotationOf(written)).toBe('NEW_KEY,app-secret');
  });

  it('refuses a key name that cannot round-trip through the annotation list', async () => {
    serveRawEs({ dev: dataFromEs('dev', []) });
    await expect(
      sealAndPublish(makeDeps([OWNER_GROUP]), {
        credentials: CREDS,
        entityRef: TARGET_REF,
        key: 'bad,key',
        value: 'v',
        envs: ['dev'],
      }),
    ).rejects.toThrow(/key name/i);
    // fail CLOSED: nothing written to Vault either
    expect(vaultSetCalls).toEqual([]);
  });
});

describe('declared-keys annotation: delete path', () => {
  it('deletes a key that is declared ONLY by the annotation (dataFrom overlay)', async () => {
    serveRawEs({ prod: dataFromEs('prod', ['beta_emails', 'watch_mode_key']) });
    await deleteSecret(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'beta_emails',
    });
    // Vault value removed (that is what actually un-syncs it under dataFrom/extract)…
    expect(vaultDeleteCalls).toEqual([
      { path: 'tenants/team-alpha/prod/app', key: 'beta_emails' },
    ]);
    // …and the annotation no longer advertises a key nobody can use.
    expect(annotationOf(writtenFiles()[overlayEs('prod')])).toBe(
      'watch_mode_key',
    );
  });

  it('removes the key from BOTH the annotation and data[] when it is in both', async () => {
    const yaml = shippedEs('dev', ['DOOMED']).replace(
      '  name: my-app-secret',
      '  name: my-app-secret\n  annotations:\n    platform.capstone/declared-keys: "DOOMED,app-secret"',
    );
    serveRawEs({ dev: yaml });
    await deleteSecret(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'DOOMED',
    });
    const written = writtenFiles()[overlayEs('dev')];
    expect(written).not.toMatch(/secretKey: DOOMED/);
    expect(annotationOf(written)).toBe('app-secret');
    expect(written).toMatch(/secretKey: app-secret/); // shipped entry preserved
  });

  it('leaves an empty annotation behind rather than a stale one when the last key goes', async () => {
    serveRawEs({ dev: dataFromEs('dev', ['ONLY']) });
    await deleteSecret(makeDeps([OWNER_GROUP]), {
      credentials: CREDS,
      entityRef: TARGET_REF,
      key: 'ONLY',
    });
    expect(annotationOf(writtenFiles()[overlayEs('dev')])).toBe('');
  });

  it('still 404s for a key declared nowhere', async () => {
    serveRawEs({ dev: dataFromEs('dev', ['SOMETHING_ELSE']) });
    await expect(
      deleteSecret(makeDeps([OWNER_GROUP]), {
        credentials: CREDS,
        entityRef: TARGET_REF,
        key: 'GHOST',
      }),
    ).rejects.toThrow(NotFoundError);
    expect(vaultDeleteCalls).toEqual([]);
  });
});
