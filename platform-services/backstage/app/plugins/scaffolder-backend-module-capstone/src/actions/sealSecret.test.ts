/*
 * Skeleton-level tests for the capstone:seal-secret action (M3-T2).
 *
 * These assert the action's SHAPE — id, description, input/output schema — so the module
 * wiring + the public contract M4 and the frontend depend on are locked before the handler
 * lands (M3-T4 adds seal/PR behavior tests; M3-T5 adds the authz allow/deny tests).
 */
import { createSealSecretAction } from './sealSecret';
import type { SealSecretActionDeps } from './sealSecret';

// Minimal stub deps — the skeleton tests never invoke the handler, so the services are
// untyped stubs cast to the dep shape. The handler-behavior tests (T4/T5) supply real mocks.
const stubDeps = {
  config: {} as SealSecretActionDeps['config'],
  logger: {} as SealSecretActionDeps['logger'],
  catalog: {} as SealSecretActionDeps['catalog'],
  permissions: {} as SealSecretActionDeps['permissions'],
  auth: {} as SealSecretActionDeps['auth'],
};

describe('createSealSecretAction', () => {
  const action = createSealSecretAction(stubDeps);

  it('registers under the capstone:seal-secret id', () => {
    expect(action.id).toBe('capstone:seal-secret');
  });

  it('has a description that flags write-only semantics', () => {
    expect(action.description).toMatch(/write-only|cannot be read back/i);
  });

  it('declares the documented input fields (entityRef, key, value, envs)', () => {
    // The action stores its parsed schema; the input shape is the contract the frontend +
    // any template invoking the action must satisfy.
    const inputSchema = action.schema?.input as unknown;
    expect(inputSchema).toBeDefined();
    const serialized = JSON.stringify(inputSchema);
    expect(serialized).toContain('entityRef');
    expect(serialized).toContain('key');
    expect(serialized).toContain('value');
    expect(serialized).toContain('envs');
  });

  it('throws (not yet implemented) until the handler lands in M3-T4/T5', async () => {
    await expect(
      (action.handler as (ctx: unknown) => Promise<void>)({}),
    ).rejects.toThrow(/not yet implemented/i);
  });
});
