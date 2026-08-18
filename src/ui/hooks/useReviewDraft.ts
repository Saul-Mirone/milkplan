import { useCallback, useEffect, useRef, useState } from 'react'

import type { DeepReadonly } from '../../shared/readonly'
import type { AnnotationSeed } from '../annotations/seed'
import {
  DRAFT_VERSION,
  clearDraft as clearStoredDraft,
  hashPlan,
  pruneDrafts,
  readDraft,
  writeDraft,
  type DraftAnnotation,
  type ReviewDraft,
} from '../draft'
import {
  excerptOf,
  type AnnotationStore,
  type DocSource,
} from './useAnnotations'

/** Trailing edits keep pushing the write out; pagehide flushes the tail. */
const SAVE_DEBOUNCE_MS = 400

export interface InitialDraft {
  draft: ReviewDraft | null
  /** The draft's annotations as plugin seeds; undefined when none restore. */
  seeds: readonly AnnotationSeed[] | undefined
}

function seedsFrom(
  draft: DeepReadonly<ReviewDraft> | null,
): readonly AnnotationSeed[] | undefined {
  if (draft === null || draft.annotations.length === 0) return undefined
  return draft.annotations.map((annotation) => ({
    id: annotation.id,
    from: annotation.from,
    to: annotation.to,
    comment: annotation.comment,
    createdExcerpt: annotation.createdExcerpt,
    orphaned: annotation.orphaned,
    expectedExcerpt: annotation.savedExcerpt,
  }))
}

/**
 * Reads this session's draft once, before the first PlanEditor render — the
 * editor bootstraps off its initial defaultValue, so the restored markdown
 * has to be decided synchronously at mount. Also the once-per-load pruning
 * hook for expired drafts.
 */
export function useInitialDraft(sessionId: string, plan: string): InitialDraft {
  const [initial] = useState((): InitialDraft => {
    pruneDrafts()
    const draft = readDraft(sessionId, plan)
    return { draft, seeds: seedsFrom(draft) }
  })
  return initial
}

/**
 * The two questions the draft saver asks of the editor. PlanEditorHandle
 * satisfies it structurally; tests drive a plain object.
 */
export interface DraftEditorSource {
  getMarkdown: () => string
  /** Null while the editor is still bootstrapping — the flush waits. */
  getBaseline: () => string | null
}

export interface DraftPersistenceOptions {
  sessionId: string
  /** The ORIGINAL served plan; hashed so stale rounds never restore. */
  plan: string
  store: AnnotationStore
  getEditor: () => DeepReadonly<DraftEditorSource> | null
  getView: () => DocSource | null
  overallFeedback: string
}

type DraftSources = Pick<
  DraftPersistenceOptions,
  'plan' | 'store' | 'getEditor' | 'getView'
>

/** The draft as it stands right now, or null while the editor bootstraps. */
function buildDraft(
  sources: DeepReadonly<DraftSources>,
  overallFeedback: string,
): ReviewDraft | null {
  const editor = sources.getEditor()
  const view = sources.getView()
  if (editor === null || view === null) return null
  const baseline = editor.getBaseline()
  if (baseline === null) return null
  const annotations = sources.store
    .getSnapshot()
    .annotations.filter((record) => !record.pending)
    .map((record): DraftAnnotation => ({
      id: record.id,
      from: record.from,
      to: record.to,
      comment: record.comment,
      createdExcerpt: record.createdExcerpt,
      orphaned: record.orphaned,
      savedExcerpt: excerptOf(view, record),
    }))
  return {
    version: DRAFT_VERSION,
    planHash: hashPlan(sources.plan),
    savedAt: Date.now(),
    markdown: editor.getMarkdown(),
    baseline,
    overallFeedback,
    annotations,
  }
}

/**
 * Calls onChange when the annotation snapshot actually changes. The plugin
 * notifies on every editor transaction (it remaps through all of them), but
 * cursor-only transactions keep the same snapshot reference — the reference
 * compare stops those from scheduling writes. Doc edits always produce a
 * fresh snapshot, so editor typing is covered even with zero annotations.
 */
function useStoreChanges(
  store: DeepReadonly<AnnotationStore>,
  onChange: () => void,
): void {
  useEffect(() => {
    let lastSnapshot = store.getSnapshot()
    return store.subscribe(() => {
      const snapshot = store.getSnapshot()
      if (snapshot === lastSnapshot) return
      lastSnapshot = snapshot
      onChange()
    })
  }, [onChange, store])
}

function useFeedbackChanges(overallFeedback: string, onChange: () => void) {
  const firstRun = useRef(true)
  useEffect(() => {
    // The initial value is the restored draft's own feedback — not a change.
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    onChange()
  }, [overallFeedback, onChange])
}

function usePageHideFlush(flush: () => void): void {
  useEffect(() => {
    // Refresh inside the debounce window must not lose the tail of typing.
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
    }
  }, [flush])
}

/**
 * Persists the review draft on every meaningful change, debounced.
 *
 * Multi-tab: both tabs restore the same draft and race their writes;
 * last-write-wins is acceptable because the decision itself can only be
 * claimed once server-side, and the winner clears the key.
 */
export function useDraftPersistence(
  options: DeepReadonly<DraftPersistenceOptions>,
): { clearDraft: () => void } {
  const { sessionId, plan, store, getEditor, getView, overallFeedback } =
    options

  // Ref: flush reads the live value without keystrokes churning its identity.
  const feedbackRef = useRef(overallFeedback)
  feedbackRef.current = overallFeedback
  const clearedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelTimer = useCallback(() => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const flush = useCallback(() => {
    cancelTimer()
    if (clearedRef.current) return
    const draft = buildDraft(
      { plan, store, getEditor, getView },
      feedbackRef.current,
    )
    if (draft !== null) writeDraft(sessionId, draft)
  }, [cancelTimer, getEditor, getView, plan, sessionId, store])

  const schedule = useCallback(() => {
    if (clearedRef.current) return
    cancelTimer()
    timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }, [cancelTimer, flush])

  useStoreChanges(store, schedule)
  useFeedbackChanges(overallFeedback, schedule)
  usePageHideFlush(flush)

  // No flush on unmount: post-decision unmount follows a just-cleared draft.
  useEffect(() => cancelTimer, [cancelTimer])

  const clearDraft = useCallback(() => {
    clearedRef.current = true
    // A queued flush must not resurrect the draft after the decision.
    cancelTimer()
    clearStoredDraft(sessionId)
  }, [cancelTimer, sessionId])

  return { clearDraft }
}
