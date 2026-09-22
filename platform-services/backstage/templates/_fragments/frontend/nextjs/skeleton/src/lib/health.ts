// health.ts — pure helper for rendering the backend health badge. Kept pure (no
// fetch/DOM) so it is unit-testable under plain Vitest/Node, same pattern as
// fullstack/nextjs's src/lib/notes.ts.

export type BackendHealth = { status: string } | null;

/** Human-readable summary of the backend health state for the page badge. */
export function describeHealth(health: BackendHealth, error: string | null): string {
  if (error) return 'unreachable';
  if (!health) return 'checking…';
  return health.status === 'ok' ? 'ok' : health.status;
}
