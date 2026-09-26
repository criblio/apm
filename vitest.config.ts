import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['tests/**', 'eval/**'],
    server: {
      deps: {
        // Let Vite transform the framework rather than leaving it to node's
        // ESM loader. `@criblio/app-utils/investigator` imports a stylesheet
        // (it is a React surface), and an externalised dep reaches node's
        // resolver, which has no loader for `.css` and throws "Unknown file
        // extension". Vite handles CSS natively, so inlining is what makes
        // the transcript reducer — and therefore the conclusion helper that
        // reads its entries — testable at all.
        inline: [/@criblio\/app-utils/],
      },
    },
  },
});
