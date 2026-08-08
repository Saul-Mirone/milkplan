import type { HookIO } from '../../src/cli/hook-io'
import type { BrowserSupport } from '../../src/cli/open-browser'
import type { RunningServer } from '../../src/cli/server'
import type { HookPayload, ResolvedPlan } from '../../src/shared/protocol'
import type { DeepReadonly } from '../../src/shared/readonly'

/**
 * Stands in for `process.exit`, which the real hook calls on every path.
 *
 * Thrown rather than returned so the `never` return type stays honest and
 * control really does stop there — a fake that returned would let the code
 * under test run on past an exit it should not have survived.
 */
export class ExitSignal extends Error {
  readonly code: number

  constructor(code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitSignal'
    this.code = code
  }
}

export interface Written {
  path: string
  content: string
}

export interface FakeHookState {
  logs: string[]
  /** Everything written to stdout, verbatim, including newlines. */
  stdout: string[]
  exits: number[]
  planWrites: Written[]
  serverStarts: number
  launches: string[]
  closes: number
  /** Ordered trace of the observable steps, for the ordering guarantees. */
  events: string[]
  /** Pending flush callbacks when the fake is configured to defer them. */
  flushes: (() => void)[]
}

export interface FakeHookIOOptions {
  plan?: ResolvedPlan
  support?: BrowserSupport
  /** Reject from startServer, as an occupied port would. */
  serverFails?: boolean
  /** Throw from writePlanFile, as EACCES would. */
  planWriteFails?: boolean
  /**
   * Hold the stdout flush callback in `state.flushes` instead of running it,
   * so a test can assert nothing exited before the bytes left the process.
   */
  deferFlush?: boolean
}

export interface FakeHook {
  io: HookIO
  state: FakeHookState
  /** The single stdout line, failing loudly when there is not exactly one. */
  onlyLine: () => string
}

const DEFAULT_PLAN: ResolvedPlan = {
  source: 'file',
  path: '/Users/dev/.claude/plans/sunny-rolling-otter.md',
  markdown: '# Plan under review',
}

export const FAKE_URL = 'http://127.0.0.1:54321/#token=deadbeef'

export function fakeHookIO(
  options: DeepReadonly<FakeHookIOOptions> = {},
): FakeHook {
  const state: FakeHookState = {
    logs: [],
    stdout: [],
    exits: [],
    planWrites: [],
    serverStarts: 0,
    launches: [],
    closes: 0,
    events: [],
    flushes: [],
  }

  const running: RunningServer = {
    url: FAKE_URL,
    close() {
      state.closes += 1
      state.events.push('close')
    },
  }

  return {
    io: buildIO(state, running, options),
    state,
    onlyLine() {
      const [line, ...rest] = state.stdout
      if (line === undefined || rest.length > 0)
        throw new Error(
          `expected exactly one stdout write, got ${state.stdout.length}`,
        )
      return line
    },
  }
}

function buildIO(
  // The fake's own mutable recording state.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  state: FakeHookState,
  running: DeepReadonly<RunningServer>,
  options: DeepReadonly<FakeHookIOOptions>,
): HookIO {
  return {
    resolve: () => options.plan ?? DEFAULT_PLAN,
    browserSupport: () =>
      options.support ?? { kind: 'available', launchers: ['macos-open'] },
    launch(url) {
      state.launches.push(url)
    },
    startServer() {
      state.serverStarts += 1
      if (options.serverFails === true)
        return Promise.reject(new Error('EADDRINUSE'))
      return Promise.resolve(running)
    },
    writePlanFile(path, content) {
      if (options.planWriteFails === true) throw new Error('EACCES')
      state.planWrites.push({ path, content })
      state.events.push('write-plan')
    },
    writeStdout(line, onFlushed) {
      state.stdout.push(line)
      state.events.push('stdout')
      if (options.deferFlush === true) state.flushes.push(onFlushed)
      else onFlushed()
    },
    exit(code) {
      state.exits.push(code)
      state.events.push('exit')
      throw new ExitSignal(code)
    },
    log(message) {
      state.logs.push(message)
    },
    onSignal() {
      // Registering real signal handlers from a suite would leak listeners.
    },
  }
}

/** Runs `fn`, asserting it exits, and returns the exit code. */
export function captureExit(fn: () => void): number {
  try {
    fn()
  } catch (cause) {
    if (cause instanceof ExitSignal) return cause.code
    throw cause
  }
  throw new Error('expected the call to exit, but it returned normally')
}

/** Awaits `promise`, asserting it exits, and returns the exit code. */
export async function captureExitAsync(
  promise: DeepReadonly<PromiseLike<unknown>>,
): Promise<number> {
  try {
    await promise
  } catch (cause) {
    if (cause instanceof ExitSignal) return cause.code
    throw cause
  }
  throw new Error('expected the call to exit, but it resolved normally')
}

export function payload(
  overrides: DeepReadonly<Partial<HookPayload>> = {},
): HookPayload {
  return {
    session_id: 'test-session',
    transcript_path: '/Users/dev/.claude/projects/session.jsonl',
    cwd: '/Users/dev/Code/widget',
    hook_event_name: 'PermissionRequest',
    tool_name: 'ExitPlanMode',
    ...overrides,
  }
}
