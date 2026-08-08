import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { recordRound, type HistoryIO, type RecordRoundInput } from './history'
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
import type { HookPayload, PlanVersion, ResolvedPlan } from '../shared/protocol'
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
  /**
   * Total and fail-open (recordRound's contract): never throws, and on any
   * failure still returns at least the current round, so history can never
   * block a review.
   */
  recordHistory(input: DeepReadonly<RecordRoundInput>): PlanVersion[]
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

function debugLog(message: string): void {
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
}

export const realHistoryIO: HistoryIO = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  mkdir(path) {
    mkdirSync(path, { recursive: true })
  },
  appendFile(path, content) {
    appendFileSync(path, content)
  },
  listDir(path) {
    try {
      return readdirSync(path)
    } catch {
      return null
    }
  },
  mtimeMs(path) {
    try {
      return statSync(path).mtimeMs
    } catch {
      return null
    }
  },
  removeFile(path) {
    try {
      rmSync(path)
    } catch {
      // Pruning is best-effort; a file that will not go must not break the hook.
    }
  },
  homedir,
  now: () => Date.now(),
  log: debugLog,
}

export const realHookIO: HookIO = {
  resolve: (payload) => resolvePlan(payload, realResolveIO),
  recordHistory: (input) => recordRound(input, realHistoryIO),
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
  log: debugLog,
  onSignal(handler) {
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
  },
}
