// Pure, framework-free helpers for note input. Kept separate from the route handler
// so they can be unit-tested without a database or an HTTP server (see
// tests/notes.test.ts).

export const MAX_TITLE_LENGTH = 200;

/** Collapse runs of whitespace and trim — the canonical form we store. */
export function normalizeTitle(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/** A title is valid when, normalized, it is 1..MAX_TITLE_LENGTH characters. */
export function isValidTitle(input: string): boolean {
  const title = normalizeTitle(input);
  return title.length >= 1 && title.length <= MAX_TITLE_LENGTH;
}
