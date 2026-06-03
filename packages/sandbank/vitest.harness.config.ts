import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname, '../..'),
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
    include: [
      'packages/sandbank/e2e/**/*.test.ts',
      'packages/sandbank/src/harness-api.test.ts',
      'packages/sandbank/src/cli/commands/harness-api.test.ts',
    ],
    testTimeout: 120_000,
    coverage: {
      include: [
        'packages/sandbank/src/harness-api.ts',
        'packages/sandbank/src/harness-node.ts',
        'packages/sandbank/src/harness-worker.ts',
        'packages/sandbank/src/cli/commands/harness-api.ts',
      ],
      reporter: ['text'],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
})
