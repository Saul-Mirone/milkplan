import { defineConfig } from 'vitest/config'

// Standalone vitest config: keeps tests away from vite.config.ts, whose
// root/plugins settings exist solely for the UI bundle and dev middleware.
//
// Two projects rather than one DOM environment everywhere: the CLI and the
// annotation plugin are deliberately exercised with no DOM present, which is
// what proves they stay usable inside a hook process.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'dom',
          include: ['tests/dom/**/*.test.tsx'],
          environment: 'happy-dom',
          setupFiles: ['tests/dom/setup.ts'],
        },
      },
    ],
  },
})
