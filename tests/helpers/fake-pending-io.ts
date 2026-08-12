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
    removed: [],
    logs: [],
  }
  const files = new Map(Object.entries(options.files ?? {}))
  const home = options.home ?? HOME

  const io: PendingIO = {
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
    homedir: () => home,
    now: () => options.now ?? FAKE_NOW,
    log(message) {
      state.logs.push(message)
    },
  }

  return { io, state, files }
}
