import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  detectBrowserSupport,
  openBrowser,
  realLaunchIO,
  type BrowserSupport,
} from './open-browser'
import { resolvePlan, type ResolveIO } from './resolve-plan'
import {
  startReviewServer,
  type ReviewSession,
  type RunningServer,
} from './server'
import type { HookPayload, ResolvedPlan } from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'

/**
 * Everything the hook does to the outside world.
 *
 * Injected for two reasons. The obvious one is that `runHook` exits the
 * process on every path, so it is untestable otherwise. The other is `log`:
 * it appends to the developer's real ~/.claude/milkplan.log and truncates it
 * past 256 KiB, so an un-injected test suite would scribble on — and could
 * erase — the very file used to diagnose "nothing popped up".
 */
export interface HookIO {
  resolve(payload: DeepReadonly<HookPayload>): ResolvedPlan
  browserSupport(): BrowserSupport
  launch(
    url: string,
    support: DeepReadonly<BrowserSupport>,
    onExhausted: () => void,
  ): void
  startServer(session: DeepReadonly<ReviewSession>): Promise<RunningServer>
  /** Throws on failure; the caller degrades to context-only delivery. */
  writePlanFile(path: string, content: string): void
  /** `onFlushed` fires once the bytes have actually left the process. */
  writeStdout(line: string, onFlushed: () => void): void
  exit(code: number): never
  log(message: string): void
  onSignal(handler: () => void): void
}

const realResolveIO: ResolveIO = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  homedir,
}

const DEBUG_LOG = join(homedir(), '.claude', 'milkplan.log')

export const realHookIO: HookIO = {
  resolve: (payload) => resolvePlan(payload, realResolveIO),
  browserSupport: () =>
    detectBrowserSupport({
      platform: process.platform,
      release: release(),
      env: process.env,
    }),
  launch(url, support, onExhausted) {
    openBrowser(url, support, realLaunchIO, onExhausted)
  },
  startServer(session) {
    // dist/cli.mjs sits next to dist/ui after build.
    return startReviewServer(
      session,
      fileURLToPath(new URL('./ui', import.meta.url)),
    )
  },
  writePlanFile(path, content) {
    writeFileSync(path, content)
  },
  writeStdout(line, onFlushed) {
    process.stdout.write(line, onFlushed)
  },
  exit(code) {
    process.exit(code)
  },
  log(message) {
    const line = `[milkplan] ${message}\n`
    process.stderr.write(line)
    // Hooks run with stderr invisible to the user in interactive sessions;
    // keep a small on-disk trail so "nothing popped up" is diagnosable after
    // the fact.
    try {
      if (existsSync(DEBUG_LOG) && statSync(DEBUG_LOG).size > 256 * 1024)
        writeFileSync(DEBUG_LOG, '')
      appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}`)
    } catch {
      // Logging must never break the hook.
    }
  },
  onSignal(handler) {
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
  },
}
