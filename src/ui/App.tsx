import { useCallback, useEffect, useState } from 'react'

import type { DeepReadonly } from '../shared/readonly'
import { fetchReview } from './api'
import { DiffOverlay } from './components/DiffOverlay'
import { ReviewHeader } from './components/ReviewHeader'
import { ReviewWorkspace } from './components/ReviewWorkspace'

// Typed off the api surface instead of the shared module — identical to
// ReviewPayload by construction.
type ReviewData = DeepReadonly<Awaited<ReturnType<typeof fetchReview>>>

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
      <ReviewWorkspace
        sessionId={payload.meta.sessionId}
        plan={payload.plan}
        onDone={onDone}
      />
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
