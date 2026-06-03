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
      '@sandbank.dev/cloudflare/dynamic-worker-capsule': resolve(__dirname, 'packages/cloudflare/src/dynamic-worker-capsule.ts'),
      '@sandbank.dev/cloudflare': resolve(__dirname, 'packages/cloudflare/src/index.ts'),
      '@sandbank.dev/db9': resolve(__dirname, 'packages/db9/src/index.ts'),
      '@sandbank.dev/e2b': resolve(__dirname, 'packages/e2b/src/index.ts'),
      '@sandbank.dev/workspace': resolve(__dirname, 'packages/workspace/src/index.ts'),
      'cloudflare:workers': resolve(__dirname, 'test/stubs/cloudflare-workers.ts'),
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
