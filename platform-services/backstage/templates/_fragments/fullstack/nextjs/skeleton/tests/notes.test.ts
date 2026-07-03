import { describe, expect, it } from 'vitest';
import { isValidTitle, normalizeTitle, MAX_TITLE_LENGTH } from '../src/lib/notes';

describe('normalizeTitle', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeTitle('  hello  ')).toBe('hello');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeTitle('a\t  b\n c')).toBe('a b c');
  });
});

describe('isValidTitle', () => {
  it('accepts a normal title', () => {
    expect(isValidTitle('My first note')).toBe(true);
  });

  it('rejects an empty or whitespace-only title', () => {
    expect(isValidTitle('')).toBe(false);
    expect(isValidTitle('    ')).toBe(false);
  });

  it('rejects a title longer than the limit', () => {
    expect(isValidTitle('x'.repeat(MAX_TITLE_LENGTH + 1))).toBe(false);
  });

  it('accepts a title exactly at the limit', () => {
    expect(isValidTitle('x'.repeat(MAX_TITLE_LENGTH))).toBe(true);
  });
});
