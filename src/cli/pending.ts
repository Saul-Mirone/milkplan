import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { debugLog } from './debug-log'
import type { DeepReadonly } from '../shared/readonly'

/** What the hook knows about a review it is serving. */
export interface PendingInput {
  url: string
  sessionId: string
  cwd: string
  planPath: string | null
}

/** A registered review: the input plus what the registry stamps on it. */
export interface PendingEntry extends PendingInput {
  pid: number
  startedAt: number
}

/** Injectable IO so the registry stays pure and testable. */
export interface PendingIO {
  /** Returns null on any read error. */
  readFile(path: string): string | null
  /** Recursive, owner-only; throws on failure. */
  mkdir(path: string): void
  /** Owner-only on creation; throws on failure. */
  writeFile(path: string, content: string): void
  /** Atomic within the directory; throws on failure. */
  rename(from: string, to: string): void
  /** Returns null when the directory is missing or unreadable. */
  listDir(path: string): string[] | null
  /** Best-effort: swallows every error. */
  removeFile(path: string): void
  /**
   * False only when the process is provably gone. One-directional by design:
   * a reused pid may report alive, which costs a corpse the probe will clear,
   * but a live review is never reported dead.
   */
  isProcessAlive(pid: number): boolean
  homedir(): string
  now(): number
  /** Never throws. */
  log(message: string): void
}

/**
 * The real filesystem, kept beside its interface the way realLaunchIO is.
 *
 * The permission bits are the one place this differs from realHistoryIO, and
 * they matter: a history file holds plan text, but a pending entry holds the
 * review URL, and the review URL carries the token that approves the plan. Any
 * local user who could read it could decide on your behalf. POSIX-only and
 * creation-time only — on win32 Node ignores the mode entirely and privacy
 * falls to the user-profile ACL.
 */
export const realPendingIO: PendingIO = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  mkdir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  },
  writeFile(path, content) {
    writeFileSync(path, content, { mode: 0o600 })
  },
  rename(from, to) {
    renameSync(from, to)
  },
  listDir(path) {
    try {
      return readdirSync(path)
    } catch {
      return null
    }
  },
  isProcessAlive(pid) {
    try {
      // Signal 0 runs every permission check but delivers nothing.
      process.kill(pid, 0)
      return true
    } catch (error) {
      // ESRCH is the only proof of death. EPERM means it exists and belongs to
      // someone else, which for this purpose is alive.
      return !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ESRCH'
      )
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

/**
 * The one URL shape startReviewServer generates. Anything else is refused
 * rather than repaired: this string is handed to a process launcher, and the
 * registry should never be the thing that widens what that can be told to open.
 */
export const PENDING_URL_PATTERN =
  /^http:\/\/127\.0\.0\.1:\d{1,5}\/#token=[0-9a-f]{32}$/u

/** A pid is the file name, so only a pid-shaped name is ever joined to a path. */
const PENDING_FILE_PATTERN = /^\d{1,10}\.json$/u

export function pendingDirFor(home: string): string {
  return join(home, '.claude', 'milkplan', 'pending')
}

export function pendingFileFor(home: string, pid: number): string {
  return join(pendingDirFor(home), `${pid}.json`)
}

function isPendingEntry(value: unknown): value is PendingEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    Number.isInteger(value.pid) &&
    'url' in value &&
    typeof value.url === 'string' &&
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'cwd' in value &&
    typeof value.cwd === 'string' &&
    'planPath' in value &&
    (value.planPath === null || typeof value.planPath === 'string') &&
    'startedAt' in value &&
    typeof value.startedAt === 'number' &&
    Number.isFinite(value.startedAt)
  )
}

/**
 * Parses one entry file. Unknown extra fields are kept out of the result but
 * do not disqualify it: `npx -y @enorim/milkplan open` may be a different
 * version than the hook that wrote the file, so the format is a cross-version
 * contract and a reader must tolerate a writer from the future.
 */
function parseEntry(raw: string | null): PendingEntry | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // Publishing is atomic, so this is genuine corruption rather than a write
    // in flight — and it costs only its own entry either way.
    return null
  }
  if (!isPendingEntry(value)) return null
  return {
    pid: value.pid,
    url: value.url,
    sessionId: value.sessionId,
    cwd: value.cwd,
    planPath: value.planPath,
    startedAt: value.startedAt,
  }
}

/**
 * Drops sibling entries that cannot be a live review. Never touches `keepPid`,
 * whose file the caller has just written.
 *
 * Deliberately not age-based. The hook timeout that actually bounds a review
 * lives in user-editable settings, so *no* age proves one is dead — a manual
 * review left waiting under a raised timeout would be deleted out from under
 * the user, destroying their only way to find it. Only two things are proof:
 * the process is gone, or the file could never have been openable anyway
 * (`listPending` skips those, so removing one costs no discoverability).
 *
 * Everything else is left for `probeReview` on the read path, which can afford
 * a network round trip; this runs in front of a review and cannot.
 */
function pruneUnusable(
  dir: string,
  entries: readonly string[],
  keepPid: number,
  io: DeepReadonly<PendingIO>,
): void {
  for (const name of entries) {
    if (!PENDING_FILE_PATTERN.test(name)) continue
    const path = join(dir, name)
    const entry = parseEntry(io.readFile(path))
    if (entry !== null && entry.pid === keepPid) continue
    if (entry === null || !PENDING_URL_PATTERN.test(entry.url)) {
      io.removeFile(path)
      continue
    }
    if (!io.isProcessAlive(entry.pid)) io.removeFile(path)
  }
}

/**
 * Records a review so `milkplan open` can find it. Total and fail-open: a
 * registry that cannot be written must never cost the user a review.
 */
export function writePending(
  input: DeepReadonly<PendingInput>,
  pid: number,
  io: DeepReadonly<PendingIO>,
): void {
  try {
    const home = io.homedir()
    const dir = pendingDirFor(home)
    const entry: PendingEntry = {
      pid,
      url: input.url,
      sessionId: input.sessionId,
      cwd: input.cwd,
      planPath: input.planPath,
      startedAt: io.now(),
    }
    io.mkdir(dir)
    // Published by rename, which is atomic within the directory. Writing
    // straight to the final path would leave a window where the file is
    // truncated but not yet written, and a concurrently registering hook that
    // read it there would classify a live review as corrupt and unlink it —
    // the writer would then finish into an unlinked inode and vanish from
    // `milkplan open`. It also keeps `listPending` from ever missing a review
    // mid-write. The .tmp suffix is outside PENDING_FILE_PATTERN, so a reader
    // racing the write skips it rather than parsing a partial file.
    const finalPath = pendingFileFor(home, pid)
    io.writeFile(`${finalPath}.tmp`, `${JSON.stringify(entry)}\n`)
    io.rename(`${finalPath}.tmp`, finalPath)
    // Pruning on every write, like history's pruneStale: a user who never runs
    // `milkplan open` would otherwise accumulate one token-bearing file per
    // unclean death forever.
    const listed = io.listDir(dir)
    if (listed !== null) pruneUnusable(dir, listed, pid, io)
  } catch {
    io.log(
      'could not record the pending review; `milkplan open` will not see it',
    )
  }
}

/** Removes one entry. Best-effort — this runs from a process exit handler. */
export function removePending(pid: number, io: DeepReadonly<PendingIO>): void {
  try {
    io.removeFile(pendingFileFor(io.homedir(), pid))
  } catch {
    // A leftover is cleared by the next `milkplan open` (its probe finds
    // nothing serving) or the next registration (which sees this pid gone).
  }
}

/**
 * Every parseable, pattern-valid entry, newest first. Not probed — liveness
 * costs a network round trip, so the caller decides when to pay for it.
 */
export function listPending(io: DeepReadonly<PendingIO>): PendingEntry[] {
  try {
    const dir = pendingDirFor(io.homedir())
    const names = io.listDir(dir)
    if (names === null) return []
    const entries: PendingEntry[] = []
    for (const name of names) {
      if (!PENDING_FILE_PATTERN.test(name)) continue
      const entry = parseEntry(io.readFile(join(dir, name)))
      if (entry === null || !PENDING_URL_PATTERN.test(entry.url)) continue
      entries.push(entry)
    }
    return entries.sort(byNewestFirst)
  } catch {
    io.log('could not read pending reviews')
    return []
  }
}

function byNewestFirst(
  a: DeepReadonly<PendingEntry>,
  b: DeepReadonly<PendingEntry>,
): number {
  return b.startedAt - a.startedAt
}
