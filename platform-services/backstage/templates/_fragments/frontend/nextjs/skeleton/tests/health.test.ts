import { describe, expect, it } from 'vitest';
import { describeHealth } from '../src/lib/health';

describe('describeHealth', () => {
  it('reports unreachable on a fetch error, regardless of stale health', () => {
    expect(describeHealth({ status: 'ok' }, 'boom')).toBe('unreachable');
  });

  it('reports checking before the first response arrives', () => {
    expect(describeHealth(null, null)).toBe('checking…');
  });

  it('passes through the backend status once healthy', () => {
    expect(describeHealth({ status: 'ok' }, null)).toBe('ok');
  });

  it('passes through a non-ok backend status verbatim', () => {
    expect(describeHealth({ status: 'degraded' }, null)).toBe('degraded');
  });
});
