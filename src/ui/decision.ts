import type {
  AnnotationOut,
  ApprovalPermissionMode,
  DecisionRequest,
} from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'
import type { AnnotationRecord } from './annotations/plugin'

/** '' = keep the session's current mode (no updatedPermissions sent). */
export const MODE_OPTIONS: readonly Readonly<{
  value: ApprovalPermissionMode | ''
  label: string
}>[] = [
  { value: '', label: 'Keep current mode' },
  { value: 'auto', label: 'Auto mode' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'default', label: 'Manually approve' },
]

/** Narrow a raw <select> value to the mode union without an unsafe assertion. */
export function isModeValue(
  value: string,
): value is ApprovalPermissionMode | '' {
  return (
    value === '' ||
    value === 'auto' ||
    value === 'acceptEdits' ||
    value === 'default'
  )
}

/**
 * The two questions buildDecision asks of the editor. Narrower than
 * PlanEditorHandle on purpose: it keeps this module free of React and of
 * Crepe, so the decision shape — the UI half of the hook protocol — can be
 * tested as a plain function.
 */
export interface EditorSnapshot {
  /** Compared against the post-parse baseline, never the original file. */
  isEdited: () => boolean
  getMarkdown: () => string
}

export type DecisionContext = Readonly<{
  annotations: readonly DeepReadonly<AnnotationRecord>[]
  excerptFor: (record: DeepReadonly<AnnotationRecord>) => string
  overallFeedback: string
  editor: DeepReadonly<EditorSnapshot> | null
  mode: ApprovalPermissionMode | ''
}>

/**
 * Reads the user's edits, if any are worth sending.
 *
 * isEdited() is a plain string compare against the parse baseline, so
 * selecting the whole plan and deleting it counts as an edit whose content is
 * empty. Sending that would blank the plan file and tell Claude the empty
 * document is the authoritative revision, so a blank edit is no edit — the
 * same rule overallFeedback and tool_input.plan already follow. cli/feedback.ts
 * repeats the check, since the server accepts decisions from anything holding
 * the token.
 */
function editsFrom(editor: DeepReadonly<EditorSnapshot> | null): string | null {
  if (editor === null || !editor.isEdited()) return null
  const markdown = editor.getMarkdown()
  return markdown.trim() === '' ? null : markdown
}

export function buildDecision(
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
  const edited = editsFrom(ctx.editor)
  if (edited !== null) decision.editedMarkdown = edited
  if (action === 'approve' && ctx.mode !== '')
    decision.permissionMode = ctx.mode
  return decision
}
