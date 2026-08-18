/**
 * localStorage persistence for the in-flight review draft.
 *
 * Everything the reviewer produces before a decision — annotations, editor
 * edits, overall feedback — otherwise lives only in memory and dies on a page
 * refresh. The draft is written per session under `milkplan:draft:<sessionId>`
 * and restored on load.
 *
 * Two invariants drive the shape:
 * - Annotation anchors are absolute ProseMirror positions, only meaningful
 *   against the exact markdown they were mapped through — so the draft carries
 *   the edited `markdown` and each record's live `savedExcerpt` for
 *   validation at restore time (`createdExcerpt` goes stale the moment the
 *   reviewer edits inside an annotated range).
 * - `isEdited()` compares against the post-parse baseline; restoring edited
 *   markdown as the editor's defaultValue would silently reset that baseline,
 *   so the draft carries the original `baseline` too.
 *
 * Every storage touch is fail-open: a review that cannot persist is worse to
 * break than one that forgets (same rule as theme.ts).
 */

import type { DeepReadonly } from '../shared/readonly'

export const DRAFT_VERSION = 1

const KEY_PREFIX = 'milkplan:draft:'

/** Mirrors cli/history.ts STALE_AFTER_MS (not imported: UI stays off cli/). */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface DraftAnnotation {
  id: string
  from: number
  to: number
  comment: string
  createdExcerpt: string
  orphaned: boolean
  /** Live doc text of [from, to) at save time; restore orphans on mismatch. */
  savedExcerpt: string
}

export interface ReviewDraft {
  version: typeof DRAFT_VERSION
  /** hashPlan of the ORIGINAL served plan — guards against a stale round. */
  planHash: string
  /** Epoch ms of the last write, for pruning only. */
  savedAt: number
  /** Editor serialization at save time; restored as defaultValue. */
  markdown: string
  /** The original plan's post-parse baseline, so isEdited() stays truthful. */
  baseline: string
  overallFeedback: string
  /** Committed records only; pending ones never persist. */
  annotations: DraftAnnotation[]
}

/** FNV-1a 32-bit — collision-tolerant here: a false match only means an old
 *  draft is offered against a byte-identical plan, which is harmless. */
export function hashPlan(markdown: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < markdown.length; index += 1) {
    hash ^= markdown.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function keyFor(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseAnnotation(value: unknown): DraftAnnotation | null {
  if (!isRecord(value)) return null
  const { id, from, to, comment, createdExcerpt, orphaned, savedExcerpt } =
    value
  if (
    typeof id !== 'string' ||
    typeof from !== 'number' ||
    typeof to !== 'number' ||
    typeof comment !== 'string' ||
    typeof createdExcerpt !== 'string' ||
    typeof orphaned !== 'boolean' ||
    typeof savedExcerpt !== 'string'
  )
    return null
  return { id, from, to, comment, createdExcerpt, orphaned, savedExcerpt }
}

function parseAnnotations(value: unknown): DraftAnnotation[] | null {
  if (!Array.isArray(value)) return null
  const items: readonly unknown[] = value
  const annotations: DraftAnnotation[] = []
  for (const item of items) {
    const annotation = parseAnnotation(item)
    if (annotation === null) return null
    annotations.push(annotation)
  }
  return annotations
}

/**
 * Anything unrecognised — a foreign value under our key, a draft written by a
 * future version — parses to null rather than a partial draft (same rule as
 * parseTheme).
 */
export function parseDraft(raw: string | null): ReviewDraft | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== DRAFT_VERSION) return null
  const { planHash, savedAt, markdown, baseline, overallFeedback } = parsed
  const annotations = parseAnnotations(parsed.annotations)
  if (
    typeof planHash !== 'string' ||
    typeof savedAt !== 'number' ||
    typeof markdown !== 'string' ||
    typeof baseline !== 'string' ||
    typeof overallFeedback !== 'string' ||
    annotations === null
  )
    return null
  return {
    version: DRAFT_VERSION,
    planHash,
    savedAt,
    markdown,
    baseline,
    overallFeedback,
    annotations,
  }
}

/**
 * The stored draft for this session, or null when there is none, it fails to
 * parse, or it was captured against a different plan (an earlier round).
 */
export function readDraft(sessionId: string, plan: string): ReviewDraft | null {
  try {
    const draft = parseDraft(localStorage.getItem(keyFor(sessionId)))
    if (draft === null || draft.planHash !== hashPlan(plan)) return null
    return draft
  } catch {
    return null
  }
}

export function writeDraft(
  sessionId: string,
  draft: DeepReadonly<ReviewDraft>,
): void {
  try {
    localStorage.setItem(keyFor(sessionId), JSON.stringify(draft))
  } catch {
    // Unpersisted (quota, privacy mode) — the live review is unaffected.
  }
}

export function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(keyFor(sessionId))
  } catch {
    // A leftover draft is harmless: planHash gates every restore.
  }
}

/**
 * Removes expired or unparseable drafts under this origin. Sessions that end
 * without a decision (crash, hook timeout) are the only writers that never
 * clean up after themselves, so this runs once per page load.
 */
export function pruneDrafts(now = Date.now()): void {
  try {
    const stale: string[] = []
    // Collect first: removing while iterating shifts the key index.
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key === null || !key.startsWith(KEY_PREFIX)) continue
      const draft = parseDraft(localStorage.getItem(key))
      if (draft === null || now - draft.savedAt > DRAFT_TTL_MS) stale.push(key)
    }
    for (const key of stale) localStorage.removeItem(key)
  } catch {
    // Pruning is best-effort; storage access itself throws in privacy modes.
  }
}
