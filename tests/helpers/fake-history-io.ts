import { dirname } from 'node:path'

import type { HistoryIO } from '../../src/cli/history'
import type { DeepReadonly } from '../../src/shared/readonly'

export const HOME = '/Users/dev'

/** A fixed "now" so ts assertions are exact rather than range checks. */
export const FAKE_NOW = 1_700_000_000_000

export interface Appended {
  path: string
  content: string
}

export interface FakeHistoryState {
  appends: Appended[]
  mkdirs: string[]
  removed: string[]
  logs: string[]
}

export interface FakeHistoryOptions {
  home?: string
  /** Initial file contents by absolute path; appends land here too. */
  files?: Record<string, string>
  /** mtimeMs by absolute path; paths without one stat as null. */
  mtimes?: Record<string, number>
  now?: number
  /** Throw from mkdir, as a read-only HOME would. */
  mkdirFails?: boolean
  /** Throw from appendFile, as ENOSPC would. */
  appendFails?: boolean
  /** Return null from listDir, as an unreadable directory would. */
  listDirFails?: boolean
}

export interface FakeHistory {
  io: HistoryIO
  state: FakeHistoryState
}

/**
 * A HistoryIO backed by an in-memory filesystem — never let a test fall back
 * to realHistoryIO, which reads and prunes the developer's real
 * ~/.claude/milkplan/history.
 */
export function fakeHistoryIO(
  options: DeepReadonly<FakeHistoryOptions> = {},
): FakeHistory {
  const state: FakeHistoryState = {
    appends: [],
    mkdirs: [],
    removed: [],
    logs: [],
  }
  const files = new Map(Object.entries(options.files ?? {}))
  const mtimes = new Map(Object.entries(options.mtimes ?? {}))

  return { io: buildIO(state, files, mtimes, options), state }
}

function buildIO(
  // The fake's own mutable recording state.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  state: FakeHistoryState,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  files: Map<string, string>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  mtimes: Map<string, number>,
  options: DeepReadonly<FakeHistoryOptions>,
): HistoryIO {
  return {
    readFile: (path) => files.get(path) ?? null,
    mkdir(path) {
      if (options.mkdirFails === true) throw new Error('EACCES')
      state.mkdirs.push(path)
    },
    appendFile(path, content) {
      if (options.appendFails === true) throw new Error('ENOSPC')
      state.appends.push({ path, content })
      files.set(path, (files.get(path) ?? '') + content)
    },
    listDir(path) {
      if (options.listDirFails === true) return null
      const names = new Set<string>()
      for (const file of [...files.keys(), ...mtimes.keys()])
        if (dirname(file) === path) names.add(file.slice(path.length + 1))
      return [...names]
    },
    mtimeMs: (path) => mtimes.get(path) ?? null,
    removeFile(path) {
      state.removed.push(path)
      files.delete(path)
      mtimes.delete(path)
    },
    homedir: () => options.home ?? HOME,
    now: () => options.now ?? FAKE_NOW,
    log(message) {
      state.logs.push(message)
    },
  }
}
