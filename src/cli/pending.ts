import {
  mkdirSync,
  readdirSync,
  readFileSync,
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
  /** Returns null when the directory is missing or unreadable. */
  listDir(path: string): string[] | null
  /** Best-effort: swallows every error. */
  removeFile(path: string): void
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
  listDir(path) {
    try {
      return readdirSync(path)
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

/**
 * Entries this old are dropped without asking the network.
 *
 * A litter backstop, not a liveness proof: the hook timeout that actually
 * bounds a review lives in user-editable settings, so no age can prove a
 * review is dead. Liveness is what `probeReview` says — this only keeps a
 * machine that lost power from accumulating files forever.
 */
export const PENDING_STALE_AFTER_MS = 48 * 60 * 60 * 1000

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
    // writeFile is not atomic; a torn file costs only itself.
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
 * Drops entry files that are unreadable, malformed, refused by the URL pattern
 * or older than PENDING_STALE_AFTER_MS. Never touches `keepPid`, whose file the
 * caller has just written (or is about to).
 */
function pruneUnusable(
  dir: string,
  entries: readonly string[],
  keepPid: number | null,
  io: DeepReadonly<PendingIO>,
): void {
  const now = io.now()
  for (const name of entries) {
    if (!PENDING_FILE_PATTERN.test(name)) continue
    const path = join(dir, name)
    const entry = parseEntry(io.readFile(path))
    if (entry !== null && entry.pid === keepPid) continue
    if (
      entry === null ||
      !PENDING_URL_PATTERN.test(entry.url) ||
      now - entry.startedAt > PENDING_STALE_AFTER_MS
    )
      io.removeFile(path)
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
    io.writeFile(pendingFileFor(home, pid), `${JSON.stringify(entry)}\n`)
    // Pruning on every write, like history's pruneStale: a user who never runs
    // `milkplan open` would otherwise accumulate one token-bearing file per
    // unclean death forever. Age only — a 500ms probe budget does not belong
    // on the hook's path in front of a review.
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
    // A leftover entry is pruned by age, and by the probe before that.
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
