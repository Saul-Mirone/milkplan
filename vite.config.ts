import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import { handleApiRequest, type ReviewSession } from './src/cli/server'
import {
  DEV_TOKEN,
  type DecisionRequest,
  type PlanVersion,
} from './src/shared/protocol'
import type { DeepReadonly } from './src/shared/readonly'

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), devReviewApi()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    // The whole theme layer is CSS `light-dark()` — the app palette, the
    // vendored Crepe palette and shiki's token colors — because that is the
    // only switch `color-scheme` (and so the theme toggle) can move. Under
    // Vite's default baseline target Lightning CSS helpfully downlevels it to
    // a prefers-color-scheme polyfill, which answers to the OS alone and would
    // leave the toggle doing nothing in the published bundle. These are the
    // versions that shipped `light-dark()`; tests/dist.test.ts pins the result.
    cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'],
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
 * Three static earlier rounds so `pnpm dev` demos the diff overlay: round1 →
 * current shows block-level adds/removes, round2 → current a single inline
 * value change, and round3 → current (the default comparison) one inserted
 * numbered step — the case where every later step is renumbered, and so the
 * one that regresses visibly if the diff ever counts list ordinals as node
 * identity again. Every fixture ends in a list, which is also what would
 * surface a phantom trailing-paragraph change.
 */
function fixtureHistory(planPath: string): PlanVersion[] {
  const fixture = (name: string): string =>
    readFileSync(resolve(process.cwd(), 'fixtures', name), 'utf8')
  return [
    {
      ts: Date.now() - 40 * 60_000,
      round: 1,
      planPath,
      markdown: fixture('sample-plan.round1.md'),
    },
    {
      ts: Date.now() - 12 * 60_000,
      round: 2,
      planPath,
      markdown: fixture('sample-plan.round2.md'),
    },
    {
      ts: Date.now() - 5 * 60_000,
      round: 3,
      planPath,
      markdown: fixture('sample-plan.round3.md'),
    },
  ]
}

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
          history: fixtureHistory(planPath),
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
