import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@sandbank/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@sandbank/daytona': path.resolve(__dirname, 'packages/daytona/src/index.ts'),
      '@sandbank/flyio': path.resolve(__dirname, 'packages/flyio/src/index.ts'),
    },
  },
  test: {
    include: ['test/conformance/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
})
