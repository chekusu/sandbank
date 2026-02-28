import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 300_000,
    include: ['**/e2e/**/*.test.ts'],
  },
})
