/*
 * Unit tests for teardownCore — the admin tenant-teardown capability.
 *  - requireAdmin fails closed: a non-admin (or a policy DENY) can neither list nor tear down,
 *  - listTenants returns the LIVE claims (excludes `_*` samples + README + non-yaml),
 *  - teardownTenant opens a PR that REMOVES the one claim file (deleteFile with its sha),
 *  - the type-to-confirm guard is re-enforced server-side (confirmName mismatch -> InputError),
 *  - a non-existent claim -> NotFoundError (never an empty PR),
 *  - archiveRepo optionally archives the app repo (non-fatal if it fails).
 */
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { InputError, NotAllowedError, NotFoundError } from '@backstage/errors';

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
  getContent: jest.fn<Promise<any>, any[]>(async () => ({ data: [] })),
  getRef: jest.fn<Promise<any>, any[]>(async () => ({
    data: { object: { sha: 'basesha' } },
  })),
  createRef: jest.fn<Promise<any>, any[]>(async () => ({})),
  deleteFile: jest.fn<Promise<any>, any[]>(async () => ({})),
  update: jest.fn<Promise<any>, any[]>(async () => ({})),
  pullsCreate: jest.fn<Promise<any>, any[]>(async (opts: { head: string }) => ({
    data: { html_url: `https://github.com/UA-MIS/platform-infra/pull/${opts.head}` },
  })),
};
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: {
      get: octokitCalls.reposGet,
      getContent: octokitCalls.getContent,
      deleteFile: octokitCalls.deleteFile,
      update: octokitCalls.update,
    },
    git: { getRef: octokitCalls.getRef, createRef: octokitCalls.createRef },
    pulls: { create: octokitCalls.pullsCreate },
  })),
}));

// eslint-disable-next-line import/first
import { listTenants, teardownTenant } from './teardownCore';

const ADMIN_GROUP = 'group:default/labmx';
const CLAIMS_DIR = 'tenants/_claims';

const CREDS: any = {
  $$type: '@backstage/BackstageCredentials',
  principal: { type: 'user', userEntityRef: 'user:default/alice' },
};

function claimYaml(team: string, app: string, semester: string, db = 'none'): string {
  return [
    'apiVersion: platform.capstone.uamishub.com/v1alpha1',
    'kind: CapstoneTenant',
    'metadata:',
    `  name: ${team}-${app}`,
    'spec:',
    `  team: "${team}"`,
    `  appName: "${app}"`,
    `  semester: "${semester}"`,
    `  database: "${db}"`,
    '',
  ].join('\n');
}

const DIR_ENTRIES = [
  { name: 'swami-swamiapp.yaml', type: 'file', path: `${CLAIMS_DIR}/swami-swamiapp.yaml` },
  { name: 'acme-web.yaml', type: 'file', path: `${CLAIMS_DIR}/acme-web.yaml` },
  { name: '_example-acme-app.yaml', type: 'file', path: `${CLAIMS_DIR}/_example-acme-app.yaml` },
  { name: 'README.md', type: 'file', path: `${CLAIMS_DIR}/README.md` },
];

const FILE_BODIES: Record<string, string> = {
  [`${CLAIMS_DIR}/swami-swamiapp.yaml`]: claimYaml('swami', 'swamiapp', '2026-summer', 'mysql'),
  [`${CLAIMS_DIR}/acme-web.yaml`]: claimYaml('acme', 'web', '2026-fall'),
};

/** getContent serving the claims dir listing + each file body; 404 for anything else. */
function serveLedger() {
  octokitCalls.getContent.mockImplementation(async (opts: any) => {
    if (opts.path === CLAIMS_DIR) {
      return { data: DIR_ENTRIES } as any;
    }
    const body = FILE_BODIES[opts.path];
    if (body !== undefined) {
      return {
        data: {
          sha: `sha-${opts.path}`,
          content: Buffer.from(body, 'utf8').toString('base64'),
        },
      } as any;
    }
    const e = new Error('Not Found') as Error & { status: number };
    e.status = 404;
    throw e;
  });
}

function mockConfig(): any {
  // getOptionalConfig('capstone.teardown') -> undefined => readTeardownConfig uses defaults
  // (owner UA-MIS, repo platform-infra, claimsDir tenants/_claims).
  return { getOptionalConfig: () => undefined };
}

function makeDeps(
  actorGroups: string[],
  policy: AuthorizeResult = AuthorizeResult.ALLOW,
): any {
  const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
  logger.child = () => logger;
  return {
    config: mockConfig(),
    logger,
    catalog: {
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

beforeEach(() => {
  Object.values(octokitCalls).forEach(m => (m as jest.Mock).mockReset());
  octokitCalls.reposGet.mockImplementation(async () => ({
    data: { default_branch: 'main' },
  }));
  octokitCalls.getRef.mockImplementation(async () => ({
    data: { object: { sha: 'basesha' } },
  }));
  octokitCalls.pullsCreate.mockImplementation(async (opts: { head: string }) => ({
    data: { html_url: `https://github.com/UA-MIS/platform-infra/pull/${opts.head}` },
  }));
});

describe('teardownCore authz (admin-only, fails closed)', () => {
  it('DENIES listTenants for a non-admin even if the policy ALLOWs (belt-and-suspenders)', async () => {
    serveLedger();
    const deps = makeDeps(['group:default/team-a'], AuthorizeResult.ALLOW);
    await expect(listTenants(deps, { credentials: CREDS })).rejects.toThrow(
      NotAllowedError,
    );
    // No repo read happened (failed before any Octokit call).
    expect(octokitCalls.getContent).not.toHaveBeenCalled();
  });

  it('DENIES when the permission policy returns DENY', async () => {
    const deps = makeDeps([ADMIN_GROUP], AuthorizeResult.DENY);
    await expect(listTenants(deps, { credentials: CREDS })).rejects.toThrow(
      NotAllowedError,
    );
  });

  it('DENIES a service principal (no user identity)', async () => {
    const deps = makeDeps([ADMIN_GROUP]);
    const svcCreds: any = {
      $$type: '@backstage/BackstageCredentials',
      principal: { type: 'service' },
    };
    await expect(
      listTenants(deps, { credentials: svcCreds }),
    ).rejects.toThrow(NotAllowedError);
  });
});

describe('listTenants (admin)', () => {
  it('lists only live claims — excludes _* samples, README, and non-yaml', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    const tenants = await listTenants(deps, { credentials: CREDS });
    expect(tenants.map(t => t.name).sort()).toEqual(['acme-web', 'swami-swamiapp']);
    const swami = tenants.find(t => t.name === 'swami-swamiapp')!;
    expect(swami).toMatchObject({
      team: 'swami',
      appName: 'swamiapp',
      semester: '2026-summer',
      database: 'mysql',
      claimPath: `${CLAIMS_DIR}/swami-swamiapp.yaml`,
    });
  });

  it('returns [] when the ledger dir does not exist (404)', async () => {
    octokitCalls.getContent.mockImplementation(async () => {
      const e = new Error('Not Found') as Error & { status: number };
      e.status = 404;
      throw e;
    });
    const deps = makeDeps([ADMIN_GROUP]);
    expect(await listTenants(deps, { credentials: CREDS })).toEqual([]);
  });
});

describe('teardownTenant (admin)', () => {
  it('opens a PR that removes the claim file and returns the PR URL', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    const res = await teardownTenant(deps, {
      credentials: CREDS,
      name: 'swami-swamiapp',
      confirmName: 'swami-swamiapp',
    });

    expect(octokitCalls.deleteFile).toHaveBeenCalledTimes(1);
    const del = octokitCalls.deleteFile.mock.calls[0][0];
    expect(del).toMatchObject({
      path: `${CLAIMS_DIR}/swami-swamiapp.yaml`,
      sha: `sha-${CLAIMS_DIR}/swami-swamiapp.yaml`,
      repo: 'platform-infra',
    });
    expect(res.pullRequestUrl).toContain('/pull/');
    expect(res.claimPath).toBe(`${CLAIMS_DIR}/swami-swamiapp.yaml`);
    expect(res.repoArchived).toBe(false);
    // No archive when not requested.
    expect(octokitCalls.update).not.toHaveBeenCalled();
  });

  it('re-enforces type-to-confirm server-side: mismatch -> InputError, no delete', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    await expect(
      teardownTenant(deps, {
        credentials: CREDS,
        name: 'swami-swamiapp',
        confirmName: 'wrong-name',
      }),
    ).rejects.toThrow(InputError);
    expect(octokitCalls.deleteFile).not.toHaveBeenCalled();
    expect(octokitCalls.pullsCreate).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for a non-existent claim (never opens an empty PR)', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    await expect(
      teardownTenant(deps, {
        credentials: CREDS,
        name: 'ghost-app',
        confirmName: 'ghost-app',
      }),
    ).rejects.toThrow(NotFoundError);
    expect(octokitCalls.deleteFile).not.toHaveBeenCalled();
  });

  it('archives the app repo when archiveRepo=true (repoArchived reflects it)', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    const res = await teardownTenant(deps, {
      credentials: CREDS,
      name: 'swami-swamiapp',
      confirmName: 'swami-swamiapp',
      archiveRepo: true,
    });
    expect(octokitCalls.update).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'swamiapp', archived: true }),
    );
    expect(res.repoArchived).toBe(true);
  });

  it('is non-fatal if the app-repo archive fails (teardown PR still succeeds)', async () => {
    serveLedger();
    octokitCalls.update.mockRejectedValue(new Error('archive boom'));
    const deps = makeDeps([ADMIN_GROUP]);
    const res = await teardownTenant(deps, {
      credentials: CREDS,
      name: 'swami-swamiapp',
      confirmName: 'swami-swamiapp',
      archiveRepo: true,
    });
    expect(res.pullRequestUrl).toContain('/pull/');
    expect(res.repoArchived).toBe(false);
  });
});

// ── resolveActorGroups against a REALISTIC catalog (filter semantics actually evaluated) ──
//
// Regression coverage for the live-data bug found investigating "labmx sees an empty secrets
// project picker": the GitHub-org provider writes Group.spec.members as `<namespace>/<login>`
// (e.g. "default/ccsmith33") — confirmed against the production catalog DB — NOT the bare
// login the old `spec.members` clause checked. `makeDeps` above ignores the filter argument
// entirely (it just echoes back `actorGroups`), so it can't catch this class of bug; these
// tests implement a small real filter evaluator instead.
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

describe('requireAdmin (realistic catalog filter evaluation)', () => {
  it('REGRESSION: recognizes admin via spec.members alone when relations.hasMember has not stitched yet', async () => {
    // withRelation=false: the ONLY way to find labmx membership is the spec.members clause,
    // in its ACTUAL live shape ("default/ccsmith33") — the relation-stitching-lag window F1
    // documents. Before the fix, resolveActorGroups only matched a bare login and this DENIED.
    serveLedger();
    const deps: any = {
      config: mockConfig(),
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
      catalog: realisticCatalog([labmxGroup(false)]),
      permissions: { authorize: jest.fn(async () => [{ result: AuthorizeResult.ALLOW }]) },
      auth: { getOwnServiceCredentials: jest.fn(async () => ({ token: 'svc' })) },
    };
    const tenants = await listTenants(deps, { credentials: CCSMITH33 });
    expect(tenants.map(t => t.name).sort()).toEqual(['acme-web', 'swami-swamiapp']);
  });
});
