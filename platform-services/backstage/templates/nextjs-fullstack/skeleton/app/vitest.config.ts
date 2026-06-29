import { defineConfig } from 'vitest/config';

// Unit tests run under Node (pure logic in src/lib + tests/). The platform CI
// `checks` job detects package.json -> runs `npm test` (= `vitest run`), BLOCKING.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
