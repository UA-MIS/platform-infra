/*
 * Unit tests for capstone:seed-vault-app-objects.
 *
 * THE POINT OF THIS ACTION is that it can never destroy a secret, so that is what these
 * assert hardest: the only Vault call it makes is ensureObject (cas:0 create-if-absent),
 * it never calls setKey/deleteKey, and a path that already holds live secrets is left alone.
 */
const ensureCalls: string[] = [];
const setCalls: Array<{ path: string; key: string }> = [];
const deleteCalls: Array<{ path: string; key: string }> = [];
let ensureImpl: (p: string) => Promise<void> = async () => {};

jest.mock('../vaultClient', () => ({
  VaultClient: jest.fn().mockImplementation(() => ({
    ensureObject: jest.fn(async (p: string) => {
      ensureCalls.push(p);
      return ensureImpl(p);
    }),
    setKey: jest.fn(async (path: string, key: string) => {
      setCalls.push({ path, key });
    }),
    deleteKey: jest.fn(async (path: string, key: string) => {
      deleteCalls.push({ path, key });
    }),
  })),
}));

jest.mock('../sealCore', () => ({
  readVaultConfig: jest.fn(() => ({ addr: 'https://vault', mount: 'secret' })),
}));

// eslint-disable-next-line import/first
import { createSeedVaultObjectsAction } from './seedVaultObjects';

function mockConfig(): any {
  return { getOptionalConfig: () => undefined };
}
const logs: string[] = [];
const logger: any = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: () => {}, debug: () => {} };

function ctx(input: any): any {
  return { input, logger, output: jest.fn() };
}

beforeEach(() => {
  ensureCalls.length = 0;
  setCalls.length = 0;
  deleteCalls.length = 0;
  logs.length = 0;
  ensureImpl = async () => {};
});

describe('capstone:seed-vault-app-objects', () => {
  it('seeds one empty object per environment for the team', async () => {
    const action = createSeedVaultObjectsAction({ config: mockConfig(), logger } as any);
    await action.handler(ctx({ team: 'team-alpha' }));
    expect(ensureCalls).toEqual([
      'tenants/team-alpha/dev/app',
      'tenants/team-alpha/staging/app',
      'tenants/team-alpha/prod/app',
    ]);
  });

  // The safety property. If this action can ever write a VALUE or remove one, it is a
  // fleet-wide secret-destruction vector — it runs automatically against every tenant path.
  it('NEVER writes or deletes a key — ensureObject is the only Vault call it can make', async () => {
    const action = createSeedVaultObjectsAction({ config: mockConfig(), logger } as any);
    await action.handler(ctx({ team: 'team-alpha' }));
    expect(setCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
  });

  it('is a no-op on a path that already holds live secrets (re-run onboarding)', async () => {
    // ensureObject resolves silently on the cas conflict; the action must not react to it.
    ensureImpl = async () => {};
    const action = createSeedVaultObjectsAction({ config: mockConfig(), logger } as any);
    await action.handler(ctx({ team: 'team-alpha' }));
    await action.handler(ctx({ team: 'team-alpha' }));
    expect(setCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
    expect(ensureCalls).toHaveLength(6);
  });

  it('rejects a team slug that could escape the tenants/ subtree', async () => {
    const action = createSeedVaultObjectsAction({ config: mockConfig(), logger } as any);
    for (const bad of ['../other', 'a/b', 'UPPER', '', 'has space']) {
      await expect(action.handler(ctx({ team: bad }))).rejects.toThrow(/team/i);
    }
    expect(ensureCalls).toEqual([]);
  });

  it('honours an explicit envs list when given', async () => {
    const action = createSeedVaultObjectsAction({ config: mockConfig(), logger } as any);
    await action.handler(ctx({ team: 'team-alpha', envs: ['dev', 'prod'] }));
    expect(ensureCalls).toEqual([
      'tenants/team-alpha/dev/app',
      'tenants/team-alpha/prod/app',
    ]);
  });

  // B-2: every template's preview overlay points at tenants/<team>/pr-1/app, NOT
  // .../preview/app — preview namespaces are per-PR. Seeding "preview" would create a
  // permanently dead object and still miss the path actually used.
  it('does NOT seed a preview env (the templates use a per-PR path, not preview/)', async () => {
    const action = createSeedVaultObjectsAction({ config: mockConfig(), logger } as any);
    await action.handler(ctx({ team: 'team-alpha' }));
    expect(ensureCalls.some(p => p.includes('/preview/'))).toBe(false);
  });

  // A-3: `envs` is interpolated into the same Vault path that `team` is validated for.
  it('rejects an env name that could escape the tenant path', async () => {
    const action = createSeedVaultObjectsAction({ config: mockConfig(), logger } as any);
    for (const bad of [['../../other'], ['a/b'], [''], ['has space']]) {
      await expect(
        action.handler(ctx({ team: 'team-alpha', envs: bad })),
      ).rejects.toThrow(/environment/i);
    }
    expect(ensureCalls).toEqual([]);
  });

  // A-1: #658 makes Retain correct ONLY where seeding succeeded. A silent seed failure then
  // has a consequence it does not have today, so the log has to name the eventual symptom.
  it('names the eventual symptom when seeding fails, not just the error', async () => {
    ensureImpl = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const action = createSeedVaultObjectsAction({ config: mockConfig(), logger } as any);
    await action.handler(ctx({ team: 'team-alpha' }));
    const msg = logs.join(' ');
    expect(msg).toMatch(/ExternalSecretSyncError|Ready=False|alert/i);
  });

  it('does not fail the scaffold when Vault is unreachable — seeding is best-effort', async () => {
    // A tenant whose object is not seeded is exactly the status quo (it gets created on first
    // write). Failing onboarding over it would be a worse outcome than the noise it prevents.
    ensureImpl = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const action = createSeedVaultObjectsAction({ config: mockConfig(), logger } as any);
    await expect(action.handler(ctx({ team: 'team-alpha' }))).resolves.toBeUndefined();
    expect(logs.some(l => /could not seed/i.test(l))).toBe(true);
  });
});
