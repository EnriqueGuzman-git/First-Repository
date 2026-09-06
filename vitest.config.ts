import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    reporter: ['verbose'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],

    /* Integration tests spin up real servers — give them more time */
    testTimeout: 15_000,
    hookTimeout: 10_000,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: [
        'src/server/game/**',
        'src/server/app/**',
        'src/server/ws/**',
        'src/server/http/**',
        'src/server/utils/**',
        'src/shared/**',
      ],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        lines:      80,
        functions:  80,
        branches:   75,
        statements: 80,
      },
    },

    alias: {
      '@ttt/shared/protocol': new URL(
        './src/shared/protocol/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
});
