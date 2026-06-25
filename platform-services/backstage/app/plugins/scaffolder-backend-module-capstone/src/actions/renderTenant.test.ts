/*
 * Tests for capstone:render-tenant.
 *
 * Strategy: hand-mock UrlReaderService.readTree to return a small in-memory tree that
 * mirrors the real tenants/_template/ shape (a tokenised AppProject + a namespaces
 * subdir), drive the handler through createMockActionContext, and assert:
 *   - both file CONTENTS and (where present) file PATHS have __TEAM__/__SEMESTER__
 *     substituted;
 *   - the tree lands under tenants/team-<team>/ inside the workspace targetPath;
 *   - the action reports repoPath + fileCount;
 *   - it fails closed on a bad slug, a bad semester, an empty tree, and a traversal path.
 */
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { createMockDirectory } from '@backstage/backend-test-utils';
import type { UrlReaderService } from '@backstage/backend-plugin-api';
import fs from 'fs-extra';
import path from 'path';
import { createRenderTenantAction, substituteTokens } from './renderTenant';

/** Build a minimal UrlReaderService whose readTree returns the given files. */
function mockReader(files: Array<{ path: string; content: string }>): UrlReaderService {
  return {
    readUrl: jest.fn(),
    read: jest.fn(),
    search: jest.fn(),
    readTree: jest.fn().mockResolvedValue({
      files: async () =>
        files.map(f => ({
          path: f.path,
          content: async () => Buffer.from(f.content, 'utf8'),
        })),
      dir: jest.fn(),
      archive: jest.fn(),
      etag: 'mock-etag',
    }),
  } as unknown as UrlReaderService;
}

const TEMPLATE_URL =
  'https://github.com/UA-MIS/platform-infra/tree/main/tenants/_template';

describe('substituteTokens', () => {
  it('replaces every __TEAM__ and __SEMESTER__ occurrence', () => {
    const out = substituteTokens(
      'name: __TEAM__\nsemester: __SEMESTER__\nns: __TEAM__-dev',
      'acme',
      '2026-fall',
    );
    expect(out).toBe('name: acme\nsemester: 2026-fall\nns: acme-dev');
  });

  it('leaves text without tokens unchanged', () => {
    expect(substituteTokens('kind: AppProject', 'acme', '2026-fall')).toBe(
      'kind: AppProject',
    );
  });

  it('substitutes __PRNUM__ to the Phase-1 stand-in (1) — preview namespace bundle', () => {
    const out = substituteTokens('name: __TEAM__-pr-__PRNUM__', 'acme', '2026-fall');
    expect(out).toBe('name: acme-pr-1');
  });

  it('leaves NO raw __*__ token behind for the three known tokens', () => {
    const out = substituteTokens(
      'name: __TEAM__-pr-__PRNUM__\nsemester: __SEMESTER__',
      'acme',
      '2026-fall',
    );
    expect(out).not.toMatch(/__[A-Z0-9_]+__/);
  });
});

describe('capstone:render-tenant', () => {
  const mockDir = createMockDirectory();

  afterEach(() => {
    mockDir.clear();
    jest.clearAllMocks();
  });

  it('renders the blueprint into tenants/team-<team>/ with tokens substituted', async () => {
    const reader = mockReader([
      {
        path: 'appproject.yaml',
        content:
          'metadata:\n  name: __TEAM__\n  labels:\n    semester: __SEMESTER__\n',
      },
      {
        path: 'namespaces/dev.yaml',
        content: 'metadata:\n  name: __TEAM__-dev\n',
      },
      {
        // The ephemeral preview bundle carries __PRNUM__ (the regression that broke
        // tenant sync when it was left raw -> invalid Namespace/<team>-pr-__PRNUM__).
        path: 'namespaces/preview.yaml',
        content: 'metadata:\n  name: __TEAM__-pr-__PRNUM__\n',
      },
      { path: 'README.md', content: 'team __TEAM__ (__SEMESTER__)\n' },
    ]);
    const action = createRenderTenantAction({ reader });
    const workspacePath = mockDir.resolve('ws');
    await fs.ensureDir(workspacePath);

    const ctx = createMockActionContext({
      input: {
        templateUrl: TEMPLATE_URL,
        team: 'acme',
        semester: '2026-fall',
        targetPath: './tenant-pr',
      },
      workspacePath,
    });

    await action.handler(ctx);

    const base = path.join(workspacePath, 'tenant-pr', 'tenants', 'team-acme');
    const appproject = await fs.readFile(
      path.join(base, 'appproject.yaml'),
      'utf8',
    );
    const devNs = await fs.readFile(
      path.join(base, 'namespaces', 'dev.yaml'),
      'utf8',
    );
    const previewNs = await fs.readFile(
      path.join(base, 'namespaces', 'preview.yaml'),
      'utf8',
    );

    expect(appproject).toContain('name: acme');
    expect(appproject).toContain('semester: 2026-fall');
    expect(appproject).not.toContain('__TEAM__');
    expect(devNs).toContain('name: acme-dev');
    // __PRNUM__ -> 1 (Phase-1 stand-in); no raw token survives anywhere.
    expect(previewNs).toContain('name: acme-pr-1');
    expect(previewNs).not.toMatch(/__[A-Z0-9_]+__/);

    expect(ctx.output).toHaveBeenCalledWith('repoPath', 'tenants/team-acme');
    expect(ctx.output).toHaveBeenCalledWith('fileCount', 4);
  });

  it('substitutes tokens in file PATHS, not just contents', async () => {
    const reader = mockReader([
      { path: '__TEAM__-notes.md', content: 'for __TEAM__' },
    ]);
    const action = createRenderTenantAction({ reader });
    const workspacePath = mockDir.resolve('ws2');
    await fs.ensureDir(workspacePath);

    await action.handler(
      createMockActionContext({
        input: {
          templateUrl: TEMPLATE_URL,
          team: 'acme',
          semester: '2026-fall',
        },
        workspacePath,
      }),
    );

    const dest = path.join(
      workspacePath,
      'tenants',
      'team-acme',
      'acme-notes.md',
    );
    expect(await fs.pathExists(dest)).toBe(true);
    expect(await fs.readFile(dest, 'utf8')).toBe('for acme');
  });

  it('defaults targetPath to the workspace root when omitted', async () => {
    const reader = mockReader([{ path: 'appproject.yaml', content: 'x: __TEAM__' }]);
    const action = createRenderTenantAction({ reader });
    const workspacePath = mockDir.resolve('ws3');
    await fs.ensureDir(workspacePath);

    await action.handler(
      createMockActionContext({
        input: {
          templateUrl: TEMPLATE_URL,
          team: 'acme',
          semester: '2026-fall',
        },
        workspacePath,
      }),
    );

    expect(
      await fs.pathExists(
        path.join(workspacePath, 'tenants', 'team-acme', 'appproject.yaml'),
      ),
    ).toBe(true);
  });

  it('fails closed on an invalid team slug', async () => {
    const action = createRenderTenantAction({ reader: mockReader([]) });
    await expect(
      action.handler(
        createMockActionContext({
          input: {
            templateUrl: TEMPLATE_URL,
            team: 'Acme_Bad', // uppercase + underscore — not a DNS label
            semester: '2026-fall',
          },
          workspacePath: mockDir.resolve('wsbad1'),
        }),
      ),
    ).rejects.toThrow(/invalid team slug/);
  });

  it('fails closed on an invalid semester', async () => {
    const action = createRenderTenantAction({ reader: mockReader([]) });
    await expect(
      action.handler(
        createMockActionContext({
          input: {
            templateUrl: TEMPLATE_URL,
            team: 'acme',
            semester: 'fall-2026', // wrong order
          },
          workspacePath: mockDir.resolve('wsbad2'),
        }),
      ),
    ).rejects.toThrow(/invalid semester/);
  });

  it('fails closed when the template tree is empty', async () => {
    const action = createRenderTenantAction({ reader: mockReader([]) });
    await expect(
      action.handler(
        createMockActionContext({
          input: {
            templateUrl: TEMPLATE_URL,
            team: 'acme',
            semester: '2026-fall',
          },
          workspacePath: mockDir.resolve('wsempty'),
        }),
      ),
    ).rejects.toThrow(/no files found/);
  });

  it('rejects a path-traversal entry in the read tree', async () => {
    const reader = mockReader([
      { path: '../../../etc/evil.yaml', content: 'pwned' },
    ]);
    const action = createRenderTenantAction({ reader });
    const workspacePath = mockDir.resolve('wstrav');
    await fs.ensureDir(workspacePath);

    await expect(
      action.handler(
        createMockActionContext({
          input: {
            templateUrl: TEMPLATE_URL,
            team: 'acme',
            semester: '2026-fall',
          },
          workspacePath,
        }),
      ),
    ).rejects.toThrow();
  });
});
