import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@sandbank.dev/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@sandbank.dev/relay': resolve(__dirname, 'packages/relay/src/index.ts'),
      '@sandbank.dev/agent': resolve(__dirname, 'packages/agent/src/index.ts'),
      '@sandbank.dev/boxlite': resolve(__dirname, 'packages/boxlite/src/index.ts'),
      '@sandbank.dev/cloud': resolve(__dirname, 'packages/cloud/src/index.ts'),
    },
  },
  test: {
    testTimeout: 120_000,
    exclude: ['**/e2e/**', '**/conformance/**', '**/node_modules/**', '**/dist/**'],
    coverage: {
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/dist/**', '**/test/**', '**/*.test.ts'],
    },
  },
})
