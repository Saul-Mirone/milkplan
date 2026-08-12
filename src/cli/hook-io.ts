import { writeFileSync } from 'node:fs'

import { realBrowserSupport, type BrowserSupport } from './browser-support'
import { debugLog } from './debug-log'
import { realHistoryIO, recordRound, type RecordRoundInput } from './history'
import { openBrowser, realLaunchIO } from './open-browser'
import {
  realPendingIO,
  removePending,
  writePending,
  type PendingInput,
} from './pending'
import { realResolveIO, resolvePlan } from './resolve-plan'
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
  /**
   * Records this review so `milkplan open` can find it, and arranges for the
   * entry to be removed when the process ends — every exit path at once,
   * rather than one removal per decision/skip/signal branch.
   *
   * Total and fail-open, like recordHistory: never throws. A registry that
   * cannot be written must never cost the user a review.
   */
  registerPending(input: DeepReadonly<PendingInput>): void
  startServer(session: DeepReadonly<ReviewSession>): Promise<RunningServer>
  /** Throws on failure; the caller degrades to context-only delivery. */
  writePlanFile(path: string, content: string): void
  /** `onFlushed` fires once the bytes have actually left the process. */
  writeStdout(line: string, onFlushed: () => void): void
  exit(code: number): never
  log(message: string): void
  onSignal(handler: () => void): void
}

export const realHookIO: HookIO = {
  resolve: (payload) => resolvePlan(payload, realResolveIO),
  recordHistory: (input) => recordRound(input, realHistoryIO),
  browserSupport: () => realBrowserSupport(debugLog),
  launch(url, support, onExhausted) {
    openBrowser(url, support, realLaunchIO, onExhausted)
  },
  registerPending(input) {
    const { pid } = process
    writePending(input, pid, realPendingIO)
    // One listener covers every ending: a decision (stdout flushes first, then
    // 'exit' handlers run), a skip, a signal, and the launch-failure
    // passthrough. It lives here rather than in hook.ts because fakeHookIO
    // deliberately registers no real process listeners, and the suite calls
    // runHook a dozen times in one worker. removePending is total, and an
    // 'exit' handler must be synchronous — async work there never runs.
    process.on('exit', () => {
      removePending(pid, realPendingIO)
    })
  },
  startServer: (session) => startReviewServer(session),
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
    // SIGHUP is the one this feature made load-bearing: closing the terminal
    // that runs a backgrounded Claude Code sends it, and Node's default for an
    // unhandled SIGHUP terminates without running 'exit' handlers — which
    // would strand the pending entry, token and all, until the age backstop.
    process.on('SIGHUP', handler)
  },
}
