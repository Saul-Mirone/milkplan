import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import { handleApiRequest, type ReviewSession } from './src/cli/server'
import { DEV_TOKEN, type DecisionRequest } from './src/shared/protocol'
import type { DeepReadonly } from './src/shared/readonly'

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), devReviewApi()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
  },
  server: {
    port: 5180,
  },
  optimizeDeps: {
    // Pin these into the initial pre-bundle: shiki's language registry is
    // discovered at runtime, and a mid-session re-optimization would split
    // the app across two shiki module instances (grammars land in one
    // singleton while the editor highlights through the other).
    include: [
      'shiki',
      '@milkdown/plugin-highlight',
      '@milkdown/plugin-highlight/shiki',
    ],
  },
})

/**
 * Mounts the real /api handlers on the Vite dev server, backed by fixtures, so
 * the full UI can be developed without a live Claude Code session. Decisions are
 * pretty-printed to the terminal instead of a hook stdout.
 */
function devReviewApi(): Plugin {
  return {
    name: 'milkplan-dev-review-api',
    // server.middlewares.use mutates the dev-server middleware stack, so the
    // ViteDevServer parameter cannot be a readonly type.
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
    configureServer(server) {
      const planPath = resolve(process.cwd(), 'fixtures/sample-plan.md')
      const session: ReviewSession = {
        payload: {
          plan: readFileSync(planPath, 'utf8'),
          meta: {
            planPath,
            cwd: process.cwd(),
            sessionId: 'dev-session',
          },
        },
        token: DEV_TOKEN,
        onDecision: (decision: DeepReadonly<DecisionRequest>) => {
          console.log('\n[milkplan dev] decision received:')
          console.log(JSON.stringify(decision, null, 2))
        },
        onSkip: () => {
          console.log('\n[milkplan dev] review skipped (passthrough)')
        },
      }
      // req is consumed as a stream and res is written by handleApiRequest, so
      // neither Connect parameter can be a readonly type.
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
      server.middlewares.use((req, res, next) => {
        handleApiRequest(session, req, res)
          .then((handled) => {
            if (!handled) next()
          })
          .catch(next)
      })
    },
  }
}
