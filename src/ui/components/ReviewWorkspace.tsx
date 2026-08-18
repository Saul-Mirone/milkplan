import { useCallback, useRef, useState } from 'react'

import {
  createAnnotationStore,
  useAnnotations,
  type UseAnnotationsResult,
  type ViewGetter,
} from '../hooks/useAnnotations'
import { useDraftPersistence, useInitialDraft } from '../hooks/useReviewDraft'
import { ActionBar } from './ActionBar'
import { CommentPopover } from './CommentPopover'
import { PlanEditor, type PlanEditorHandle } from './PlanEditor'
import { Sidebar } from './Sidebar'

// Typed off the hook surface instead of the plugin module — identical to
// AnnotationRecord by construction (same aliasing rule as App.tsx's
// ReviewData).
type AnnotationItem = UseAnnotationsResult['annotations'][number]

/** Popover lifecycle + sidebar selection, split out of useReview for size. */
function useAnnotationNavigation(
  beginAnnotation: (from: number, to: number) => string | null,
  setActive: (id: string | null) => void,
  getView: ViewGetter,
) {
  const [popoverId, setPopoverId] = useState<string | null>(null)

  const openAnnotationPopover = useCallback(
    (range: { readonly from: number; readonly to: number }) => {
      setPopoverId(beginAnnotation(range.from, range.to))
    },
    [beginAnnotation],
  )

  const selectAnnotation = useCallback(
    (record: Readonly<AnnotationItem>) => {
      setActive(record.id)
      if (record.orphaned) return
      const view = getView()
      if (!view) return
      view.dom
        .querySelector(`[data-annotation-id="${record.id}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    [getView, setActive],
  )

  return { popoverId, setPopoverId, openAnnotationPopover, selectAnnotation }
}

function useReview(sessionId: string, plan: string) {
  const [store] = useState(createAnnotationStore)
  const { draft, seeds } = useInitialDraft(sessionId, plan)
  const [overallFeedback, setOverallFeedback] = useState(
    draft?.overallFeedback ?? '',
  )
  const editorRef = useRef<PlanEditorHandle | null>(null)
  const getEditor = useCallback(() => editorRef.current, [])
  const getView = useCallback(() => editorRef.current?.getView() ?? null, [])
  const ann = useAnnotations(store, getView)
  const nav = useAnnotationNavigation(
    ann.beginAnnotation,
    ann.setActive,
    getView,
  )
  const { clearDraft } = useDraftPersistence({
    sessionId,
    plan,
    store,
    getEditor,
    getView,
    overallFeedback,
  })

  return {
    ...ann,
    ...nav,
    store,
    draft,
    seeds,
    clearDraft,
    editorRef,
    getView,
    overallFeedback,
    setOverallFeedback,
  }
}

interface ReviewWorkspaceProps {
  sessionId: string
  /** The ORIGINAL served plan — the draft key and restore guard hash it. */
  plan: string
  onDone: (variant: 'sent' | 'skipped') => void
}

/** onDone with the draft cleared first — the decision reached the CLI. */
function useDoneHandler(
  clearDraft: () => void,
  onDone: (variant: 'sent' | 'skipped') => void,
) {
  return useCallback(
    (variant: 'sent' | 'skipped') => {
      // Runs only on a successful POST (useSend), so a failed decision keeps
      // the draft; skip clears too — it is an explicit abandonment.
      clearDraft()
      onDone(variant)
    },
    [clearDraft, onDone],
  )
}

export function ReviewWorkspace({
  sessionId,
  plan,
  onDone,
}: Readonly<ReviewWorkspaceProps>) {
  const r = useReview(sessionId, plan)
  const handleDone = useDoneHandler(r.clearDraft, onDone)
  return (
    <>
      <main className="mp-main">
        <div className="mp-editor-column">
          <PlanEditor
            ref={r.editorRef}
            defaultValue={r.draft?.markdown ?? plan}
            baseline={r.draft?.baseline ?? null}
            initialAnnotations={r.seeds}
            onAnnotationsChange={r.store.onChange}
            onAnnotate={r.openAnnotationPopover}
          />
        </div>
        <Sidebar
          annotations={r.annotations}
          activeId={r.activeId}
          excerptFor={r.excerptFor}
          onSelect={r.selectAnnotation}
          onDelete={r.removeAnnotation}
          overallFeedback={r.overallFeedback}
          onOverallFeedbackChange={r.setOverallFeedback}
        />
      </main>
      <ActionBar
        editorRef={r.editorRef}
        annotations={r.annotations}
        excerptFor={r.excerptFor}
        overallFeedback={r.overallFeedback}
        onDone={handleDone}
      />
      <ReviewPopover
        popoverId={r.popoverId}
        pendingAnnotation={r.pendingAnnotation}
        getView={r.getView}
        commitAnnotation={r.commitAnnotation}
        removeAnnotation={r.removeAnnotation}
        setPopoverId={r.setPopoverId}
      />
    </>
  )
}

interface ReviewPopoverProps {
  popoverId: string | null
  pendingAnnotation: Readonly<AnnotationItem> | null
  getView: ViewGetter
  commitAnnotation: (id: string, comment: string) => void
  removeAnnotation: (id: string) => void
  setPopoverId: (id: string | null) => void
}

function ReviewPopover({
  popoverId,
  pendingAnnotation,
  getView,
  commitAnnotation,
  removeAnnotation,
  setPopoverId,
}: Readonly<ReviewPopoverProps>) {
  const handleSave = useCallback(
    (comment: string) => {
      if (popoverId !== null) commitAnnotation(popoverId, comment)
      setPopoverId(null)
    },
    [commitAnnotation, popoverId, setPopoverId],
  )
  const handleCancel = useCallback(() => {
    if (popoverId !== null) removeAnnotation(popoverId)
    setPopoverId(null)
  }, [popoverId, removeAnnotation, setPopoverId])

  if (
    popoverId === null ||
    pendingAnnotation === null ||
    pendingAnnotation.id !== popoverId
  )
    return null

  return (
    <CommentPopover
      getView={getView}
      // Live position from plugin state: remapped through concurrent edits.
      from={pendingAnnotation.from}
      onSave={handleSave}
      onCancel={handleCancel}
    />
  )
}
