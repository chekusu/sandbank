import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 120_000,
    coverage: {
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/dist/**', '**/test/**', '**/*.test.ts'],
    },
  },
})
