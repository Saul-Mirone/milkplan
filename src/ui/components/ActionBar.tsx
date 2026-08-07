import { useCallback, useState, type RefObject } from 'react'

import type {
  AnnotationOut,
  ApprovalPermissionMode,
  DecisionRequest,
} from '../../shared/protocol'
import { postDecision, postSkip } from '../api'
import type { AnnotationRecord } from '../annotations/plugin'
import type { PlanEditorHandle } from './PlanEditor'
import type { DeepReadonly } from '../../shared/readonly'

/** '' = keep the session's current mode (no updatedPermissions sent). */
const MODE_OPTIONS: readonly Readonly<{
  value: ApprovalPermissionMode | ''
  label: string
}>[] = [
  { value: '', label: 'Keep current mode' },
  { value: 'auto', label: 'Auto mode' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'default', label: 'Manually approve' },
]

/** Minimal readonly shape of the select's change event (only value is read). */
type SelectChangeEvent = DeepReadonly<{ target: { value: string } }>

/** Narrow a raw <select> value to the mode union without an unsafe assertion. */
function isModeValue(value: string): value is ApprovalPermissionMode | '' {
  return (
    value === '' ||
    value === 'auto' ||
    value === 'acceptEdits' ||
    value === 'default'
  )
}

type DecisionContext = Readonly<{
  annotations: readonly DeepReadonly<AnnotationRecord>[]
  excerptFor: (record: DeepReadonly<AnnotationRecord>) => string
  overallFeedback: string
  editorRef: DeepReadonly<RefObject<PlanEditorHandle | null>>
  mode: ApprovalPermissionMode | ''
}>

function buildDecision(
  action: DecisionRequest['action'],
  ctx: DecisionContext,
): DecisionRequest {
  const serialized: AnnotationOut[] = ctx.annotations.map((record) => ({
    excerpt: ctx.excerptFor(record),
    comment: record.comment,
    orphaned: record.orphaned,
  }))
  const decision: DecisionRequest = {
    action,
    annotations: serialized,
    overallFeedback: ctx.overallFeedback.trim(),
  }
  const editor = ctx.editorRef.current
  // editedMarkdown only when the content diverged from the parse baseline.
  if (editor?.isEdited() === true)
    decision.editedMarkdown = editor.getMarkdown()
  if (action === 'approve' && ctx.mode !== '')
    decision.permissionMode = ctx.mode
  return decision
}

type ActionBarProps = Readonly<{
  editorRef: DeepReadonly<RefObject<PlanEditorHandle | null>>
  annotations: readonly DeepReadonly<AnnotationRecord>[]
  excerptFor: (record: DeepReadonly<AnnotationRecord>) => string
  overallFeedback: string
  onDone: (variant: 'sent' | 'skipped') => void
}>

export function ActionBar(props: ActionBarProps) {
  const { editorRef, annotations, excerptFor, overallFeedback, onDone } = props
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<ApprovalPermissionMode | ''>('')
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
  const onSkip = useCallback(() => {
    send(postSkip, 'skipped')
  }, [send])
  const onRequestChanges = useCallback(() => {
    const ctx = { annotations, excerptFor, overallFeedback, editorRef, mode }
    send(() => postDecision(buildDecision('request-changes', ctx)), 'sent')
  }, [send, annotations, excerptFor, overallFeedback, editorRef, mode])
  const onApprove = useCallback(() => {
    const ctx = { annotations, excerptFor, overallFeedback, editorRef, mode }
    send(() => postDecision(buildDecision('approve', ctx)), 'sent')
  }, [send, annotations, excerptFor, overallFeedback, editorRef, mode])
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
      {props.error !== null && props.error !== '' && (
        <span className="mp-actionbar__error">{props.error}</span>
      )}
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
