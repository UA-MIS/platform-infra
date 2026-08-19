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
import { listSecrets, deleteSecret, listMyProjects } from './sealCore';

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
