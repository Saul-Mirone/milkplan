import { defineConfig } from 'vitest/config'

// Standalone vitest config: keeps tests away from vite.config.ts, whose
// root/plugins settings exist solely for the UI bundle and dev middleware.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
