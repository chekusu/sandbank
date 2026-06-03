import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@sandbank.dev/cloudflare/dynamic-worker-capsule': resolve(__dirname, '../cloudflare/src/dynamic-worker-capsule.ts'),
      '@sandbank.dev/cloudflare': resolve(__dirname, '../cloudflare/src/index.ts'),
      '@sandbank.dev/db9': resolve(__dirname, '../db9/src/index.ts'),
      '@sandbank.dev/workspace': resolve(__dirname, '../workspace/src/index.ts'),
      'cloudflare:workers': resolve(__dirname, '../../test/stubs/cloudflare-workers.ts'),
    },
  },
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 120_000,
  },
})
