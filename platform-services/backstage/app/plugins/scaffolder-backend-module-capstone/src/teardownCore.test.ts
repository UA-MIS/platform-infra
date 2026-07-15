/*
 * Unit tests for teardownCore — the admin tenant-teardown capability.
 *  - requireAdmin fails closed: a non-admin (or a policy DENY) can neither list nor tear down,
 *  - listTenants returns the LIVE claims (excludes `_*` samples + README + non-yaml),
 *  - teardownTenant opens a PR that REMOVES the one claim file (deleteFile with its sha),
 *  - the type-to-confirm guard is re-enforced server-side (confirmName mismatch -> InputError),
 *  - a non-existent claim -> NotFoundError (never an empty PR),
 *  - archiveRepo optionally archives the app repo (non-fatal if it fails).
 *  - VM tenants (ADR-032a §D5/§D6): listTenants also scans `_vm-claims/`, tagging rows
 *    `layout: 'vm'`; teardownTenant removes the marker + the whole `tenants/team-<team>/` tree
 *    via the Git Trees API (one commit, both changes) instead of deleteFile.
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
  getAllTopics: jest.fn<Promise<any>, any[]>(async () => ({
    data: { names: ['capstone-tenant', 'nodejs'] },
  })),
  replaceAllTopics: jest.fn<Promise<any>, any[]>(async () => ({
    data: { names: ['nodejs'] },
  })),
  pullsCreate: jest.fn<Promise<any>, any[]>(async (opts: { head: string }) => ({
    data: { html_url: `https://github.com/UA-MIS/platform-infra/pull/${opts.head}` },
  })),
  // VM teardown (Git Trees API) — getCommit/getTree/createTree/createCommit.
  getCommit: jest.fn<Promise<any>, any[]>(async () => ({
    data: { tree: { sha: 'basetreesha' } },
  })),
  getTree: jest.fn<Promise<any>, any[]>(async () => ({
    data: { truncated: false, tree: VM_TEAM_TREE_ENTRIES },
  })),
  createTree: jest.fn<Promise<any>, any[]>(async () => ({
    data: { sha: 'newtreesha' },
  })),
  createCommit: jest.fn<Promise<any>, any[]>(async () => ({
    data: { sha: 'newcommitsha' },
  })),
};
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: {
      get: octokitCalls.reposGet,
      getContent: octokitCalls.getContent,
      deleteFile: octokitCalls.deleteFile,
      update: octokitCalls.update,
      getAllTopics: octokitCalls.getAllTopics,
      replaceAllTopics: octokitCalls.replaceAllTopics,
    },
    git: {
      getRef: octokitCalls.getRef,
      createRef: octokitCalls.createRef,
      getCommit: octokitCalls.getCommit,
      getTree: octokitCalls.getTree,
      createTree: octokitCalls.createTree,
      createCommit: octokitCalls.createCommit,
    },
    pulls: { create: octokitCalls.pullsCreate },
  })),
}));

// eslint-disable-next-line import/first
import { listTenants, teardownTenant } from './teardownCore';

const ADMIN_GROUP = 'group:default/labmx';
const CLAIMS_DIR = 'tenants/_claims';
const VM_CLAIMS_DIR = 'tenants/_vm-claims';
const VM_TEAM_TREE = 'tenants/team-teamx';

/**
 * The recursive base-tree listing `git.getTree` returns for VM teardown — files under the VM
 * team's tree (mirrors the real teardown/tenantvm removal: README.md + vm/{README,
 * applicationset-vm,appproject-vm}.yaml + vm/namespaces/vm-prod.yaml), PLUS an unrelated
 * sibling team's file (must survive filtering) and the marker blob itself (present in the base
 * tree, confirming the filter doesn't double-count it).
 */
const VM_TEAM_TREE_ENTRIES = [
  { path: `${VM_TEAM_TREE}/README.md`, type: 'blob', sha: 'sha-readme' },
  { path: `${VM_TEAM_TREE}/vm/README.md`, type: 'blob', sha: 'sha-vm-readme' },
  { path: `${VM_TEAM_TREE}/vm/applicationset-vm.yaml`, type: 'blob', sha: 'sha-appset' },
  { path: `${VM_TEAM_TREE}/vm/appproject-vm.yaml`, type: 'blob', sha: 'sha-appproj' },
  { path: `${VM_TEAM_TREE}/vm/namespaces/vm-prod.yaml`, type: 'blob', sha: 'sha-ns' },
  { path: 'tenants/team-otherteam/README.md', type: 'blob', sha: 'sha-other' },
  { path: `${VM_CLAIMS_DIR}/teamx-vmapp.yaml`, type: 'blob', sha: 'sha-marker' },
  { path: 'tenants', type: 'tree', sha: 'sha-tenants-tree' },
];

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

/** A `_vm-claims/<team>-<app>.yaml` marker, matching the vm-app template's emitted schema. */
function vmMarkerYaml(
  team: string,
  app: string,
  semester: string,
  teardownPath = `tenants/team-${team}`,
): string {
  return [
    'apiVersion: platform.capstone/v1',
    'kind: VmTenantLedger',
    'metadata:',
    `  name: ${team}-${app}`,
    `team: ${team}`,
    `appName: ${app}`,
    `semester: "${semester}"`,
    'layout: vm',
    `teardownPath: ${teardownPath}`,
    '',
  ].join('\n');
}

const DIR_ENTRIES_VM = [
  { name: 'teamx-vmapp.yaml', type: 'file', path: `${VM_CLAIMS_DIR}/teamx-vmapp.yaml` },
  { name: 'README.md', type: 'file', path: `${VM_CLAIMS_DIR}/README.md` },
];

const FILE_BODIES_VM: Record<string, string> = {
  [`${VM_CLAIMS_DIR}/teamx-vmapp.yaml`]: vmMarkerYaml('teamx', 'vmapp', '2026-fall'),
};

/** getContent serving BOTH ledger dir listings + every file body; 404 for anything else. */
function serveLedger() {
  octokitCalls.getContent.mockImplementation(async (opts: any) => {
    if (opts.path === CLAIMS_DIR) {
      return { data: DIR_ENTRIES } as any;
    }
    if (opts.path === VM_CLAIMS_DIR) {
      return { data: DIR_ENTRIES_VM } as any;
    }
    const body = FILE_BODIES[opts.path] ?? FILE_BODIES_VM[opts.path];
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
  // App repo carries the `capstone-tenant` topic by default (the state a live tenant is in).
  octokitCalls.getAllTopics.mockImplementation(async () => ({
    data: { names: ['capstone-tenant', 'nodejs'] },
  }));
  octokitCalls.replaceAllTopics.mockImplementation(async () => ({
    data: { names: ['nodejs'] },
  }));
  octokitCalls.getCommit.mockImplementation(async () => ({
    data: { tree: { sha: 'basetreesha' } },
  }));
  octokitCalls.getTree.mockImplementation(async () => ({
    data: { truncated: false, tree: VM_TEAM_TREE_ENTRIES },
  }));
  octokitCalls.createTree.mockImplementation(async () => ({
    data: { sha: 'newtreesha' },
  }));
  octokitCalls.createCommit.mockImplementation(async () => ({
    data: { sha: 'newcommitsha' },
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
  it('lists live CONTAINER claims — excludes _* samples, README, and non-yaml — tagged layout: container', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    const tenants = await listTenants(deps, { credentials: CREDS });
    const containerNames = tenants
      .filter(t => t.layout !== 'vm')
      .map(t => t.name)
      .sort();
    expect(containerNames).toEqual(['acme-web', 'swami-swamiapp']);
    const swami = tenants.find(t => t.name === 'swami-swamiapp')!;
    expect(swami).toMatchObject({
      team: 'swami',
      appName: 'swamiapp',
      semester: '2026-summer',
      database: 'mysql',
      claimPath: `${CLAIMS_DIR}/swami-swamiapp.yaml`,
      layout: 'container',
      teardownPaths: [`${CLAIMS_DIR}/swami-swamiapp.yaml`],
    });
  });

  it('ALSO lists live VM tenants from _vm-claims, tagged layout: vm with the marker + team tree in teardownPaths', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    const tenants = await listTenants(deps, { credentials: CREDS });
    expect(tenants.map(t => t.name).sort()).toEqual([
      'acme-web',
      'swami-swamiapp',
      'teamx-vmapp',
    ]);
    const vmTenant = tenants.find(t => t.name === 'teamx-vmapp')!;
    expect(vmTenant).toMatchObject({
      team: 'teamx',
      appName: 'vmapp',
      semester: '2026-fall',
      claimPath: `${VM_CLAIMS_DIR}/teamx-vmapp.yaml`,
      layout: 'vm',
      teardownPaths: [`${VM_CLAIMS_DIR}/teamx-vmapp.yaml`, VM_TEAM_TREE],
    });
    // VM markers don't declare a database — the field stays undefined (no 'none' placeholder).
    expect(vmTenant.database).toBeUndefined();
  });

  it('returns [] when neither ledger dir exists (404 on both)', async () => {
    octokitCalls.getContent.mockImplementation(async () => {
      const e = new Error('Not Found') as Error & { status: number };
      e.status = 404;
      throw e;
    });
    const deps = makeDeps([ADMIN_GROUP]);
    expect(await listTenants(deps, { credentials: CREDS })).toEqual([]);
  });

  it('still lists container tenants when only the VM ledger dir is missing (404 on _vm-claims)', async () => {
    octokitCalls.getContent.mockImplementation(async (opts: any) => {
      if (opts.path === CLAIMS_DIR) {
        return { data: DIR_ENTRIES } as any;
      }
      const body = FILE_BODIES[opts.path];
      if (body !== undefined) {
        return {
          data: { sha: `sha-${opts.path}`, content: Buffer.from(body, 'utf8').toString('base64') },
        } as any;
      }
      const e = new Error('Not Found') as Error & { status: number };
      e.status = 404;
      throw e;
    });
    const deps = makeDeps([ADMIN_GROUP]);
    const tenants = await listTenants(deps, { credentials: CREDS });
    expect(tenants.map(t => t.name).sort()).toEqual(['acme-web', 'swami-swamiapp']);
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
    // ...but the `capstone-tenant` topic is stripped UNCONDITIONALLY (ghost-tenant cure).
    expect(res.topicStripped).toBe(true);
    expect(octokitCalls.replaceAllTopics).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'swamiapp', names: ['nodejs'] }),
    );
  });

  it('ghost-tenant cure: strips the `capstone-tenant` topic from the app repo on every teardown', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    await teardownTenant(deps, {
      credentials: CREDS,
      name: 'swami-swamiapp',
      confirmName: 'swami-swamiapp',
    });
    expect(octokitCalls.getAllTopics).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'swamiapp' }),
    );
    // The remaining topics are preserved; only `capstone-tenant` is removed.
    expect(octokitCalls.replaceAllTopics).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'UA-MIS', repo: 'swamiapp', names: ['nodejs'] }),
    );
  });

  it('does NOT call replaceAllTopics when the repo never had the topic (nothing to strip)', async () => {
    serveLedger();
    octokitCalls.getAllTopics.mockResolvedValue({ data: { names: ['nodejs'] } });
    const deps = makeDeps([ADMIN_GROUP]);
    const res = await teardownTenant(deps, {
      credentials: CREDS,
      name: 'swami-swamiapp',
      confirmName: 'swami-swamiapp',
    });
    expect(octokitCalls.replaceAllTopics).not.toHaveBeenCalled();
    expect(res.topicStripped).toBe(false);
  });

  it('is non-fatal if the topic strip fails (teardown PR still succeeds)', async () => {
    serveLedger();
    octokitCalls.replaceAllTopics.mockRejectedValue(new Error('topic boom'));
    const deps = makeDeps([ADMIN_GROUP]);
    const res = await teardownTenant(deps, {
      credentials: CREDS,
      name: 'swami-swamiapp',
      confirmName: 'swami-swamiapp',
    });
    expect(res.pullRequestUrl).toContain('/pull/');
    expect(res.topicStripped).toBe(false);
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
    // The topic strip MUST happen BEFORE the archive (an archived repo is read-only and its
    // topics can no longer be changed). Assert call ordering via invocationCallOrder.
    const stripOrder = octokitCalls.replaceAllTopics.mock.invocationCallOrder[0];
    const archiveOrder = octokitCalls.update.mock.invocationCallOrder[0];
    expect(stripOrder).toBeLessThan(archiveOrder);
    expect(res.topicStripped).toBe(true);
  });

  it('is non-fatal if the app-repo archive fails (teardown PR still succeeds; topic still stripped)', async () => {
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
    // The strip runs before the archive, so it still succeeds even though archive threw.
    expect(res.topicStripped).toBe(true);
  });
});

describe('teardownTenant — VM tenants (ADR-032a §D5/§D6, Git Trees API)', () => {
  it('removes the marker + the whole team tree in ONE commit (not deleteFile) and returns the PR URL', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    const res = await teardownTenant(deps, {
      credentials: CREDS,
      name: 'teamx-vmapp',
      confirmName: 'teamx-vmapp',
    });

    // Never uses the single-file delete path.
    expect(octokitCalls.deleteFile).not.toHaveBeenCalled();

    // Reads the base commit's tree, then the full recursive tree off that sha.
    expect(octokitCalls.getCommit).toHaveBeenCalledWith(
      expect.objectContaining({ commit_sha: 'basesha' }),
    );
    expect(octokitCalls.getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: 'basetreesha', recursive: 'true' }),
    );

    // The new tree removes the marker + every blob under tenants/team-teamx/ — and NOTHING else
    // (the sibling tenants/team-otherteam/ file must survive).
    expect(octokitCalls.createTree).toHaveBeenCalledTimes(1);
    const treeCall = octokitCalls.createTree.mock.calls[0][0];
    expect(treeCall.base_tree).toBe('basetreesha');
    const removedPaths = treeCall.tree.map((e: any) => e.path).sort();
    expect(removedPaths).toEqual(
      [
        `${VM_CLAIMS_DIR}/teamx-vmapp.yaml`,
        `${VM_TEAM_TREE}/README.md`,
        `${VM_TEAM_TREE}/vm/README.md`,
        `${VM_TEAM_TREE}/vm/applicationset-vm.yaml`,
        `${VM_TEAM_TREE}/vm/appproject-vm.yaml`,
        `${VM_TEAM_TREE}/vm/namespaces/vm-prod.yaml`,
      ].sort(),
    );
    expect(removedPaths).not.toContain('tenants/team-otherteam/README.md');
    // Every entry deletes the blob (sha: null), never re-adds content.
    for (const entry of treeCall.tree) {
      expect(entry.sha).toBeNull();
      expect(entry.type).toBe('blob');
    }

    // One commit off the base sha, pointed at by a NEW branch ref (not deleteFile's own commit).
    expect(octokitCalls.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ tree: 'newtreesha', parents: ['basesha'] }),
    );
    expect(octokitCalls.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'newcommitsha' }),
    );

    expect(res.pullRequestUrl).toContain('/pull/');
    expect(res.claimPath).toBe(`${VM_CLAIMS_DIR}/teamx-vmapp.yaml`);
    expect(res.teardownPaths.sort()).toEqual(
      [
        `${VM_CLAIMS_DIR}/teamx-vmapp.yaml`,
        `${VM_TEAM_TREE}/README.md`,
        `${VM_TEAM_TREE}/vm/README.md`,
        `${VM_TEAM_TREE}/vm/applicationset-vm.yaml`,
        `${VM_TEAM_TREE}/vm/appproject-vm.yaml`,
        `${VM_TEAM_TREE}/vm/namespaces/vm-prod.yaml`,
      ].sort(),
    );
  });

  it('strips the capstone-tenant topic from the VM tenant app repo (same ghost-tenant cure)', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    const res = await teardownTenant(deps, {
      credentials: CREDS,
      name: 'teamx-vmapp',
      confirmName: 'teamx-vmapp',
    });
    expect(octokitCalls.getAllTopics).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'vmapp' }),
    );
    expect(res.topicStripped).toBe(true);
  });

  it('archives the VM tenant app repo when archiveRepo=true', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    const res = await teardownTenant(deps, {
      credentials: CREDS,
      name: 'teamx-vmapp',
      confirmName: 'teamx-vmapp',
      archiveRepo: true,
    });
    expect(octokitCalls.update).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'vmapp', archived: true }),
    );
    expect(res.repoArchived).toBe(true);
  });

  it('re-enforces type-to-confirm server-side for VM tenants too: mismatch -> InputError, no commit', async () => {
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    await expect(
      teardownTenant(deps, {
        credentials: CREDS,
        name: 'teamx-vmapp',
        confirmName: 'wrong-name',
      }),
    ).rejects.toThrow(InputError);
    expect(octokitCalls.createTree).not.toHaveBeenCalled();
    expect(octokitCalls.createCommit).not.toHaveBeenCalled();
  });

  it('fails CLOSED rather than removing a partial tree when GitHub truncates the recursive listing', async () => {
    serveLedger();
    octokitCalls.getTree.mockResolvedValue({
      data: { truncated: true, tree: VM_TEAM_TREE_ENTRIES },
    });
    const deps = makeDeps([ADMIN_GROUP]);
    await expect(
      teardownTenant(deps, {
        credentials: CREDS,
        name: 'teamx-vmapp',
        confirmName: 'teamx-vmapp',
      }),
    ).rejects.toThrow(/truncated/i);
    expect(octokitCalls.createTree).not.toHaveBeenCalled();
    expect(octokitCalls.pullsCreate).not.toHaveBeenCalled();
  });

  it('falls back to NotFoundError when neither a claim nor a VM marker exists for the name', async () => {
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
    expect(octokitCalls.createTree).not.toHaveBeenCalled();
  });

  it('prefers the CONTAINER claim over a same-named VM marker (container ledger checked first)', async () => {
    // Give 'swami-swamiapp' BOTH a container claim (from serveLedger) and — hypothetically — a
    // VM marker would never coexist in practice, but this locks in the dispatch order so a
    // future change can't silently flip priority.
    serveLedger();
    const deps = makeDeps([ADMIN_GROUP]);
    const res = await teardownTenant(deps, {
      credentials: CREDS,
      name: 'swami-swamiapp',
      confirmName: 'swami-swamiapp',
    });
    expect(octokitCalls.deleteFile).toHaveBeenCalledTimes(1);
    expect(octokitCalls.createTree).not.toHaveBeenCalled();
    expect(res.claimPath).toBe(`${CLAIMS_DIR}/swami-swamiapp.yaml`);
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
    expect(tenants.map(t => t.name).sort()).toEqual([
      'acme-web',
      'swami-swamiapp',
      'teamx-vmapp',
    ]);
  });
});
