import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // cell/src is the investigator cell's pure logic (event mapping,
    // protocol) — same runner, so `npm test` covers both sides of
    // the wire contract.
    include: [
      'src/**/__tests__/**/*.test.ts',
      'cell/src/**/__tests__/**/*.test.ts',
    ],
    exclude: ['tests/**', 'eval/**'],
  },
});
