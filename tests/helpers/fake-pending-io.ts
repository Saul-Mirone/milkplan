import type { PendingIO } from '../../src/cli/pending'
import type { DeepReadonly } from '../../src/shared/readonly'

export const HOME = '/Users/dev'

/** A fixed "now" so startedAt assertions are exact rather than range checks. */
export const FAKE_NOW = 1_700_000_000_000

export interface Written {
  path: string
  content: string
}

export interface FakePendingState {
  writes: Written[]
  mkdirs: string[]
  renames: { from: string; to: string }[]
  removed: string[]
  logs: string[]
}

export interface FakePendingOptions {
  home?: string
  /** Initial file contents by absolute path; writes land here too. */
  files?: Record<string, string>
  now?: number
  /** Throw from mkdir, as a read-only HOME would. */
  mkdirFails?: boolean
  /** Throw from writeFile, as ENOSPC would. */
  writeFails?: boolean
  /** Return null from listDir, as an unreadable directory would. */
  listDirFails?: boolean
  /** Pids to report as gone; anything else is alive. */
  deadPids?: number[]
}

export interface FakePending {
  io: PendingIO
  state: FakePendingState
  files: Map<string, string>
}

/**
 * A PendingIO backed by an in-memory filesystem — never let a test fall back to
 * the real one, which reads, writes and prunes the developer's real
 * ~/.claude/milkplan/pending.
 */
export function fakePendingIO(
  options: DeepReadonly<FakePendingOptions> = {},
): FakePending {
  const state: FakePendingState = {
    writes: [],
    mkdirs: [],
    renames: [],
    removed: [],
    logs: [],
  }
  const files = new Map(Object.entries(options.files ?? {}))
  return { io: buildIO(state, files, options), state, files }
}

function buildIO(
  // The fake's own mutable recording state.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  state: FakePendingState,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  files: Map<string, string>,
  options: DeepReadonly<FakePendingOptions>,
): PendingIO {
  const home = options.home ?? HOME
  return {
    readFile: (path) => files.get(path) ?? null,
    mkdir(path) {
      if (options.mkdirFails === true) throw new Error('EROFS')
      state.mkdirs.push(path)
    },
    writeFile(path, content) {
      if (options.writeFails === true) throw new Error('ENOSPC')
      state.writes.push({ path, content })
      files.set(path, content)
    },
    rename(from, to) {
      state.renames.push({ from, to })
      const content = files.get(from)
      if (content === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, content)
    },
    listDir(path) {
      if (options.listDirFails === true) return null
      const prefix = `${path}/`
      const names = [...files.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
      return names
    },
    removeFile(path) {
      state.removed.push(path)
      files.delete(path)
    },
    isProcessAlive: (pid) => !(options.deadPids ?? []).includes(pid),
    homedir: () => home,
    now: () => options.now ?? FAKE_NOW,
    log(message) {
      state.logs.push(message)
    },
  }
}
