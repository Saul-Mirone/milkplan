import type { GitResult, InitIO } from '../../src/cli/init-io'
import type { DeepReadonly } from '../../src/shared/readonly'

export { at } from './json'

export const HOME = '/Users/dev'
export const PROJECT = '/Users/dev/Code/widget'
export const NODE = '/usr/local/bin/node'
/** milkplan running from a source checkout (src/cli/*). */
export const SELF_CHECKOUT = '/Users/dev/Code/milkplan/src/cli/init.ts'
/** milkplan running from its own build output. */
export const SELF_DIST = '/Users/dev/Code/milkplan/dist/cli.mjs'
/** milkplan installed from npm. */
export const SELF_NPM = '/usr/lib/node_modules/milkplan/dist/cli.mjs'

export interface Written {
  path: string
  content: string
}

export interface GitCall {
  args: readonly string[]
  cwd: string
}

export interface FakeState {
  /** Current contents, including anything written during the run. */
  files: Map<string, string>
  writes: Written[]
  mkdirs: string[]
  appends: Written[]
  gitCalls: GitCall[]
  logs: string[]
  failed: boolean
}

export interface FakeInitIOOptions {
  files?: Record<string, string>
  home?: string
  cwd?: string
  selfPath?: string
  nodePath?: string
  git?: (args: readonly string[], cwd: string) => GitResult
}

export interface FakeInit {
  io: InitIO
  state: FakeState
  /** Convenience: the single file written, failing loudly if there is not one. */
  onlyWrite: () => Written
  /** Parsed JSON of the settings file at `path`, or null when absent. */
  settingsAt: (path: string) => unknown
}

/**
 * An InitIO backed by an in-memory filesystem.
 *
 * Never let a test fall back to realInitIO: this checkout's own
 * .claude/settings.local.json holds a live milkplan hook, and a defaulted cwd
 * would delete it.
 */
export function fakeInitIO(
  options: DeepReadonly<FakeInitIOOptions> = {},
): FakeInit {
  const state: FakeState = {
    files: new Map(Object.entries(options.files ?? {})),
    writes: [],
    mkdirs: [],
    appends: [],
    gitCalls: [],
    logs: [],
    failed: false,
  }
  // Default: git could not be started at all, so init leaves ignores alone.
  const git = options.git ?? (() => ({ status: null, stdout: '' }))
  const io = buildIO(state, options, git)

  return {
    io,
    state,
    onlyWrite() {
      const [write, ...rest] = state.writes
      if (write === undefined || rest.length > 0)
        throw new Error(
          `expected exactly one write, got ${state.writes.length}`,
        )
      return write
    },
    settingsAt(path) {
      const raw = state.files.get(path)
      if (raw === undefined) return null
      const parsed: unknown = JSON.parse(raw)
      return parsed
    },
  }
}

function buildIO(
  // The fake's own mutable recording state.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  state: FakeState,
  options: DeepReadonly<FakeInitIOOptions>,
  git: (args: readonly string[], cwd: string) => GitResult,
): InitIO {
  return {
    exists: (path) => state.files.has(path),
    readFile: (path) => state.files.get(path) ?? null,
    writeFile(path, content) {
      state.writes.push({ path, content })
      state.files.set(path, content)
    },
    mkdir(path) {
      state.mkdirs.push(path)
    },
    appendFile(path, content) {
      state.appends.push({ path, content })
      state.files.set(path, (state.files.get(path) ?? '') + content)
    },
    homedir: () => options.home ?? HOME,
    cwd: () => options.cwd ?? PROJECT,
    selfPath: () => options.selfPath ?? SELF_CHECKOUT,
    nodePath: () => options.nodePath ?? NODE,
    git(args, cwd) {
      state.gitCalls.push({ args, cwd })
      return git(args, cwd)
    },
    log(message) {
      state.logs.push(message)
    },
    fail() {
      state.failed = true
    },
  }
}

/** True when any log line contains `needle`. */
export function logged(
  state: DeepReadonly<FakeState>,
  needle: string,
): boolean {
  return state.logs.some((line) => line.includes(needle))
}
