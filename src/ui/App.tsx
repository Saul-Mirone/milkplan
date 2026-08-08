import { useCallback, useEffect, useRef, useState } from 'react'

import type { DeepReadonly } from '../shared/readonly'
import { fetchReview } from './api'
import { ActionBar } from './components/ActionBar'
import { CommentPopover } from './components/CommentPopover'
import { DiffOverlay } from './components/DiffOverlay'
import { PlanEditor, type PlanEditorHandle } from './components/PlanEditor'
import { ReviewHeader } from './components/ReviewHeader'
import { Sidebar } from './components/Sidebar'
import {
  createAnnotationStore,
  useAnnotations,
  type UseAnnotationsResult,
  type ViewGetter,
} from './hooks/useAnnotations'

// Typed off the api/hook surfaces instead of the shared modules — this file
// sits at oxlint's max-dependencies cap, and both aliases are identical to
// ReviewPayload / AnnotationRecord by construction.
type ReviewData = DeepReadonly<Awaited<ReturnType<typeof fetchReview>>>
type AnnotationItem = UseAnnotationsResult['annotations'][number]

type Phase =
  | { kind: 'loading' }
  | { kind: 'review'; payload: ReviewData }
  | { kind: 'done'; variant: 'sent' | 'skipped' }
  | { kind: 'error'; message: string }

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const handleDone = useCallback((variant: 'sent' | 'skipped') => {
    setPhase({ kind: 'done', variant })
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchReview()
      .then((payload: ReviewData) => {
        if (!cancelled) setPhase({ kind: 'review', payload })
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setPhase({
            kind: 'error',
            message:
              cause instanceof Error ? cause.message : 'Failed to load review',
          })
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (phase.kind === 'loading') return <LoadingScreen />
  if (phase.kind === 'error') return <ErrorScreen message={phase.message} />
  if (phase.kind === 'done') return <DoneScreen variant={phase.variant} />

  return <ReviewScreen payload={phase.payload} onDone={handleDone} />
}

interface ReviewScreenProps {
  payload: ReviewData
  onDone: (variant: 'sent' | 'skipped') => void
}

/** The review phase: header, workspace, and the on-demand diff overlay. */
function ReviewScreen({ payload, onDone }: Readonly<ReviewScreenProps>) {
  // Overlay state lives beside the header button, outside useReview: opening
  // and closing the diff must never touch the editor's lifecycle.
  const [diffOpen, setDiffOpen] = useState(false)
  const openDiff = useCallback(() => {
    setDiffOpen(true)
  }, [])
  const closeDiff = useCallback(() => {
    setDiffOpen(false)
  }, [])

  const prior = payload.history
  // The badge counts from the last stored round, not the array length — the
  // served history is capped, so indexes undercount in very long sessions.
  const lastPrior = prior.at(-1)
  return (
    <div className="mp-app">
      <ReviewHeader
        meta={payload.meta}
        roundNumber={lastPrior === undefined ? null : lastPrior.round + 1}
        onViewChanges={lastPrior === undefined ? null : openDiff}
      />
      <ReviewWorkspace defaultValue={payload.plan} onDone={onDone} />
      {diffOpen && (
        // The current side is the submitted plan (payload.plan), never the
        // live editor content — the diff means "last round → this round", and
        // reviewer edits in flight are not part of either.
        <DiffOverlay
          versions={prior}
          currentMarkdown={payload.plan}
          onClose={closeDiff}
        />
      )}
    </div>
  )
}

function LoadingScreen() {
  return (
    <div className="mp-screen">
      <p className="mp-screen__message">Loading plan…</p>
    </div>
  )
}

function ErrorScreen({ message }: Readonly<{ message: string }>) {
  return (
    <div className="mp-screen">
      <h1 className="mp-screen__title">Review unavailable</h1>
      <p className="mp-screen__message">{message}</p>
    </div>
  )
}

function DoneScreen({ variant }: Readonly<{ variant: 'sent' | 'skipped' }>) {
  return (
    <div className="mp-screen">
      <h1 className="mp-screen__title">
        {variant === 'sent' ? 'Decision sent' : 'Review skipped'}
      </h1>
      <p className="mp-screen__message">
        {variant === 'sent'
          ? 'Decision sent — you can close this tab.'
          : 'Review skipped — you can close this tab.'}
      </p>
    </div>
  )
}

function useReview() {
  const [store] = useState(createAnnotationStore)
  const [popoverId, setPopoverId] = useState<string | null>(null)
  const [overallFeedback, setOverallFeedback] = useState('')
  const editorRef = useRef<PlanEditorHandle | null>(null)
  const getView = useCallback(() => editorRef.current?.getView() ?? null, [])
  const ann = useAnnotations(store, getView)
  const { beginAnnotation, setActive } = ann

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

  return {
    ...ann,
    store,
    editorRef,
    getView,
    popoverId,
    setPopoverId,
    overallFeedback,
    setOverallFeedback,
    openAnnotationPopover,
    selectAnnotation,
  }
}

interface ReviewWorkspaceProps {
  defaultValue: string
  onDone: (variant: 'sent' | 'skipped') => void
}

function ReviewWorkspace({
  defaultValue,
  onDone,
}: Readonly<ReviewWorkspaceProps>) {
  const r = useReview()
  return (
    <>
      <main className="mp-main">
        <div className="mp-editor-column">
          <PlanEditor
            ref={r.editorRef}
            defaultValue={defaultValue}
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
        onDone={onDone}
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
