import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { canonicalizeMarkdown } from './canonical'
import { debugLog } from './debug-log'
import { normalizeMarkdown } from '../shared/markdown'
import type { PlanVersion } from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'

/** Injectable IO so recordRound stays pure and testable. */
export interface HistoryIO {
  /** Returns null on any read error. */
  readFile(path: string): string | null
  /** Recursive; throws on failure. */
  mkdir(path: string): void
  /** Throws on failure. */
  appendFile(path: string, content: string): void
  /** Returns null when the directory is missing or unreadable. */
  listDir(path: string): string[] | null
  /** Returns null when stat fails. */
  mtimeMs(path: string): number | null
  /** Best-effort: swallows every error. */
  removeFile(path: string): void
  homedir(): string
  now(): number
  /** Never throws. */
  log(message: string): void
}

export interface RecordRoundInput {
  sessionId: string
  planPath: string | null
  /**
   * Expected canonical — the CLI runs every plan through canonicalizeMarkdown
   * when it resolves one. Rounds read back are canonicalized too, so passing
   * raw markdown here would only mis-compare against the dedupe baseline.
   */
  markdown: string
}

/** The real filesystem, kept beside its interface the way realLaunchIO is. */
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

/** Session files untouched this long are pruned on the next record. */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

/** Cap on the versions returned (a read-time slice; the file is never rewritten). */
export const MAX_ROUNDS = 20

/**
 * The session id becomes a file name, so anything but this shape is refused
 * outright — a hook input must never become a path outside the history dir.
 * Real ids are UUIDs; the branch is effectively unreachable.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u

export function historyDirFor(home: string): string {
  return join(home, '.claude', 'milkplan', 'history')
}

export function historyFileFor(home: string, sessionId: string): string {
  return join(historyDirFor(home), `${sessionId}.jsonl`)
}

function isPlanVersion(value: unknown): value is PlanVersion {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ts' in value &&
    typeof value.ts === 'number' &&
    Number.isFinite(value.ts) &&
    'round' in value &&
    typeof value.round === 'number' &&
    Number.isFinite(value.round) &&
    'planPath' in value &&
    (value.planPath === null || typeof value.planPath === 'string') &&
    'markdown' in value &&
    typeof value.markdown === 'string'
  )
}

/**
 * Parses a JSONL history file. Blank lines, broken JSON and wrong shapes are
 * skipped silently, line by line — a torn concurrent append must cost at most
 * the one line it tore, never the whole history.
 *
 * Stored markdown is canonicalized on the way out, which is what makes this
 * module's contract "every PlanVersion it returns is canonical" hold for rounds
 * it did not write. The file is append-only and never rewritten, so entries
 * recorded before canonicalization shipped keep their original style on disk;
 * without this they would diff against a canonical current round as style
 * changes to untouched sections, and dedupe would miss a style-only
 * resubmission and store it as a new round.
 */
export function parseHistory(raw: string): PlanVersion[] {
  const versions: PlanVersion[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isPlanVersion(value)) continue
    versions.push({
      ts: value.ts,
      round: value.round,
      planPath: value.planPath,
      markdown: canonicalizeMarkdown(value.markdown),
    })
  }
  return versions
}

/**
 * Removes sibling session files untouched for STALE_AFTER_MS. The current
 * session's file is never removed — a failed append would make it look stale.
 * Runs on every record, unthrottled: a marker would be one more piece of
 * corruptible state, and one readdir is microseconds.
 */
function pruneStale(
  dir: string,
  currentFile: string,
  io: DeepReadonly<HistoryIO>,
): void {
  try {
    const entries = io.listDir(dir)
    if (entries === null) return
    const now = io.now()
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const path = join(dir, entry)
      if (path === currentFile) continue
      const mtime = io.mtimeMs(path)
      if (mtime === null) continue
      if (now - mtime > STALE_AFTER_MS) io.removeFile(path)
    }
  } catch {
    io.log('could not prune stale plan history; leaving old files in place')
  }
}

/** A round as the sole in-memory history — the shape every degraded path
 *  returns when nothing earlier is available. */
function soleRound(
  input: DeepReadonly<RecordRoundInput>,
  ts: number,
): PlanVersion {
  return { ts, round: 1, planPath: input.planPath, markdown: input.markdown }
}

/** Appends the round as one complete line in a single call (O_APPEND
 *  atomicity); on failure logs and leaves the round in-memory only. */
function persistRound(
  dir: string,
  file: string,
  current: DeepReadonly<PlanVersion>,
  io: DeepReadonly<HistoryIO>,
): void {
  try {
    io.mkdir(dir)
    io.appendFile(file, `${JSON.stringify(current)}\n`)
  } catch {
    io.log('could not persist plan history; continuing with in-memory history')
  }
}

/**
 * Persists this round and returns the session's versions — oldest first, the
 * current round last, at most MAX_ROUNDS. Total: never throws. Any failure
 * degrades to in-memory history so the review itself is never blocked.
 */
export function recordRound(
  input: DeepReadonly<RecordRoundInput>,
  io: DeepReadonly<HistoryIO>,
): PlanVersion[] {
  try {
    if (!SESSION_ID_PATTERN.test(input.sessionId)) {
      io.log(
        'unusable session id for plan history; keeping this round in memory only',
      )
      return [soleRound(input, io.now())]
    }
    const home = io.homedir()
    const dir = historyDirFor(home)
    const file = historyFileFor(home, input.sessionId)
    const prior = parseHistory(io.readFile(file) ?? '')
    const last = prior.at(-1)
    if (
      last !== undefined &&
      normalizeMarkdown(last.markdown) === normalizeMarkdown(input.markdown)
    )
      // Only consecutive duplicates collapse (A→B→A records three rounds), and
      // the original ts survives — it names when the round first appeared.
      return prior.slice(-MAX_ROUNDS)
    const current: PlanVersion = {
      ts: io.now(),
      // Numbered off the last stored round, not the array length — corrupt
      // lines may have been skipped, but stored numbers stay authoritative.
      round: (last?.round ?? 0) + 1,
      planPath: input.planPath,
      markdown: input.markdown,
    }
    persistRound(dir, file, current, io)
    pruneStale(dir, file, io)
    // Returned regardless of whether the write landed: on a read-only HOME the
    // diff for this round must still work.
    return [...prior, current].slice(-MAX_ROUNDS)
  } catch {
    // Only reachable when an io member breaks its own contract; the review
    // still gets its current round.
    io.log('plan history failed; continuing with the current round only')
    return [soleRound(input, Date.now())]
  }
}
