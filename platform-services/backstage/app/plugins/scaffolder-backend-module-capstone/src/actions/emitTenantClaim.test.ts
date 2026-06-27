/*
 * Tests for capstone:emit-tenant-claim (ADR-031 zero-touch onboarding).
 *
 * Strategy: drive the handler through createMockActionContext writing into a mock
 * directory, and unit-test the pure renderer renderCapstoneTenant. Assert:
 *   - the emitted file lands at tenants/_claims/<team>-<app>.yaml under targetPath;
 *   - the XR carries the typed spec fields + defaults (githubTeam/port/previewEnabled/domain);
 *   - no leftover token/placeholder;
 *   - it fails closed on a bad team slug, appName, semester, and githubTeam.
 */
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { createMockDirectory } from '@backstage/backend-test-utils';
import fs from 'fs-extra';
import path from 'path';
import {
  createEmitTenantClaimAction,
  renderCapstoneTenant,
} from './emitTenantClaim';

describe('renderCapstoneTenant', () => {
  it('renders the typed XR with explicit fields', () => {
    const out = renderCapstoneTenant({
      team: 'acme',
      appName: 'acme-app',
      semester: '2026-fall',
      githubTeam: 'acme-gh',
      port: 3000,
      previewEnabled: true,
      domain: 'example.com',
    });
    expect(out).toContain('kind: CapstoneTenant');
    expect(out).toContain('name: acme-acme-app');
    expect(out).toContain('namespace: capstone-tenants');
    expect(out).toContain('team: "acme"');
    expect(out).toContain('appName: "acme-app"');
    expect(out).toContain('semester: "2026-fall"');
    expect(out).toContain('githubTeam: "acme-gh"');
    expect(out).toContain('port: 3000');
    expect(out).toContain('previewEnabled: true');
    expect(out).toContain('domain: "example.com"');
  });

  it('applies defaults (githubTeam=team, port=8080, previewEnabled=false, domain)', () => {
    const out = renderCapstoneTenant({
      team: 'acme',
      appName: 'acme-app',
      semester: '2026-fall',
    });
    expect(out).toContain('githubTeam: "acme"');
    expect(out).toContain('port: 8080');
    expect(out).toContain('previewEnabled: false');
    expect(out).toContain('domain: "capstone.uamishub.com"');
  });
});

describe('capstone:emit-tenant-claim', () => {
  const mockDir = createMockDirectory();

  afterEach(() => {
    mockDir.clear();
    jest.clearAllMocks();
  });

  it('writes tenants/_claims/<team>-<app>.yaml under targetPath', async () => {
    const action = createEmitTenantClaimAction();
    const workspacePath = mockDir.resolve('ws');
    await fs.ensureDir(workspacePath);

    const ctx = createMockActionContext({
      input: {
        team: 'acme',
        appName: 'acme-app',
        semester: '2026-fall',
        targetPath: './claim',
      },
      workspacePath,
    });

    await action.handler(ctx);

    const dest = path.join(
      workspacePath,
      'claim',
      'tenants',
      '_claims',
      'acme-acme-app.yaml',
    );
    expect(await fs.pathExists(dest)).toBe(true);
    const content = await fs.readFile(dest, 'utf8');
    expect(content).toContain('kind: CapstoneTenant');
    expect(content).toContain('team: "acme"');
    expect(content).not.toMatch(/__[A-Z0-9_]+__/);
    expect(ctx.output).toHaveBeenCalledWith(
      'claimPath',
      'tenants/_claims/acme-acme-app.yaml',
    );
  });

  it('defaults targetPath to the workspace root when omitted', async () => {
    const action = createEmitTenantClaimAction();
    const workspacePath = mockDir.resolve('ws2');
    await fs.ensureDir(workspacePath);

    await action.handler(
      createMockActionContext({
        input: { team: 'acme', appName: 'acme-app', semester: '2026-fall' },
        workspacePath,
      }),
    );

    expect(
      await fs.pathExists(
        path.join(workspacePath, 'tenants', '_claims', 'acme-acme-app.yaml'),
      ),
    ).toBe(true);
  });

  it('fails closed on an invalid team slug', async () => {
    const action = createEmitTenantClaimAction();
    await expect(
      action.handler(
        createMockActionContext({
          input: { team: 'Acme_Bad', appName: 'acme-app', semester: '2026-fall' },
          workspacePath: mockDir.resolve('wsbad1'),
        }),
      ),
    ).rejects.toThrow(/invalid team slug/);
  });

  it('fails closed on an invalid appName', async () => {
    const action = createEmitTenantClaimAction();
    await expect(
      action.handler(
        createMockActionContext({
          input: { team: 'acme', appName: '-bad-', semester: '2026-fall' },
          workspacePath: mockDir.resolve('wsbad2'),
        }),
      ),
    ).rejects.toThrow(/invalid appName/);
  });

  it('fails closed on an invalid semester', async () => {
    const action = createEmitTenantClaimAction();
    await expect(
      action.handler(
        createMockActionContext({
          input: { team: 'acme', appName: 'acme-app', semester: 'fall-2026' },
          workspacePath: mockDir.resolve('wsbad3'),
        }),
      ),
    ).rejects.toThrow(/invalid semester/);
  });

  it('fails closed on an invalid githubTeam', async () => {
    const action = createEmitTenantClaimAction();
    await expect(
      action.handler(
        createMockActionContext({
          input: {
            team: 'acme',
            appName: 'acme-app',
            semester: '2026-fall',
            githubTeam: 'Bad_Team',
          },
          workspacePath: mockDir.resolve('wsbad4'),
        }),
      ),
    ).rejects.toThrow(/invalid githubTeam/);
  });
});
