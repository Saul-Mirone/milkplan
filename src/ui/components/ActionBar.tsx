import { useCallback, useState, type RefObject } from 'react'

import type { ApprovalPermissionMode } from '../../shared/protocol'
import { postDecision, postSkip } from '../api'
import type { AnnotationRecord } from '../annotations/plugin'
import { buildDecision, isModeValue, MODE_OPTIONS } from '../decision'
import type { PlanEditorHandle } from './PlanEditor'
import { ThemeToggle } from './ThemeToggle'
import type { DeepReadonly } from '../../shared/readonly'

/** Minimal readonly shape of the select's change event (only value is read). */
type SelectChangeEvent = DeepReadonly<{ target: { value: string } }>

type ActionBarProps = Readonly<{
  editorRef: DeepReadonly<RefObject<PlanEditorHandle | null>>
  annotations: readonly DeepReadonly<AnnotationRecord>[]
  excerptFor: (record: DeepReadonly<AnnotationRecord>) => string
  overallFeedback: string
  onDone: (variant: 'sent' | 'skipped') => void
}>

/**
 * Runs one request, holding the bar disabled until it settles and surfacing a
 * failure inline — a decision that never reached the CLI must not look sent.
 */
function useSend(onDone: (variant: 'sent' | 'skipped') => void) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = useCallback(
    (run: () => Promise<void>, variant: 'sent' | 'skipped') => {
      setPending(true)
      setError(null)
      run()
        .then(() => {
          onDone(variant)
        })
        .catch((cause: unknown) => {
          setPending(false)
          setError(cause instanceof Error ? cause.message : 'Request failed')
        })
    },
    [onDone],
  )
  return { pending, error, send }
}

export function ActionBar(props: ActionBarProps) {
  const { editorRef, annotations, excerptFor, overallFeedback, onDone } = props
  const [mode, setMode] = useState<ApprovalPermissionMode | ''>('')
  const { pending, error, send } = useSend(onDone)
  const onSkip = useCallback(() => {
    send(postSkip, 'skipped')
  }, [send])
  const ctxFor = useCallback(
    () => ({
      annotations,
      excerptFor,
      overallFeedback,
      editor: editorRef.current,
      mode,
    }),
    [annotations, excerptFor, overallFeedback, editorRef, mode],
  )
  const onRequestChanges = useCallback(() => {
    const ctx = ctxFor()
    send(() => postDecision(buildDecision('request-changes', ctx)), 'sent')
  }, [send, ctxFor])
  const onApprove = useCallback(() => {
    const ctx = ctxFor()
    send(() => postDecision(buildDecision('approve', ctx)), 'sent')
  }, [send, ctxFor])
  const onModeChange = useCallback((event: SelectChangeEvent) => {
    if (isModeValue(event.target.value)) setMode(event.target.value)
  }, [])
  const canRequestChanges =
    annotations.length > 0 || overallFeedback.trim().length > 0
  return (
    <ActionBarView
      error={error}
      pending={pending}
      canRequestChanges={canRequestChanges}
      mode={mode}
      onSkip={onSkip}
      onRequestChanges={onRequestChanges}
      onApprove={onApprove}
      onModeChange={onModeChange}
    />
  )
}

type ActionBarViewProps = Readonly<{
  error: string | null
  pending: boolean
  canRequestChanges: boolean
  mode: ApprovalPermissionMode | ''
  onSkip: () => void
  onRequestChanges: () => void
  onApprove: () => void
  onModeChange: (event: SelectChangeEvent) => void
}>

function ActionBarView(props: ActionBarViewProps) {
  return (
    <footer className="mp-actionbar">
      {/* Everything left of the decision buttons. The wrapper owns the
          margin-right:auto that splits the bar, so the split does not move
          when the error appears or disappears. */}
      <div className="mp-actionbar__lead">
        <ThemeToggle />
        {props.error !== null && props.error !== '' && (
          <span className="mp-actionbar__error">{props.error}</span>
        )}
      </div>
      <button
        type="button"
        className="mp-button mp-button--ghost"
        disabled={props.pending}
        onClick={props.onSkip}
      >
        Skip review
      </button>
      <button
        type="button"
        className="mp-button"
        disabled={props.pending || !props.canRequestChanges}
        title={
          props.canRequestChanges
            ? undefined
            : 'Add at least one annotation or overall feedback first'
        }
        onClick={props.onRequestChanges}
      >
        Request changes
      </button>
      <ModeSelect
        mode={props.mode}
        pending={props.pending}
        onModeChange={props.onModeChange}
      />
      <button
        type="button"
        className="mp-button mp-button--primary"
        disabled={props.pending}
        onClick={props.onApprove}
      >
        Approve
      </button>
    </footer>
  )
}

type ModeSelectProps = Readonly<{
  mode: ApprovalPermissionMode | ''
  pending: boolean
  onModeChange: (event: SelectChangeEvent) => void
}>

function ModeSelect(props: ModeSelectProps) {
  return (
    <label className="mp-mode">
      <span className="mp-mode__label">After approval:</span>
      <select
        className="mp-mode__select"
        value={props.mode}
        disabled={props.pending}
        onChange={props.onModeChange}
      >
        {MODE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
