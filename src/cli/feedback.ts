import type {
  AnnotationOut,
  DecisionRequest,
  HookAllowOutput,
  HookDenyOutput,
  ResolvedPlan,
} from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'

const EXCERPT_LIMIT = 200

function truncateExcerpt(text: string): string {
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text
}

function annotationEntry(
  annotation: DeepReadonly<AnnotationOut>,
  index: number,
  label: 'Note' | 'Comment',
): string {
  const excerpt = truncateExcerpt(annotation.excerpt)
  const heading = annotation.orphaned
    ? `Regarding a passage that was removed during review (original text: "${excerpt}")`
    : `Regarding: "${excerpt}"`
  return `${index + 1}. ${heading}\n   ${label}: ${annotation.comment}`
}

function buildRevisedBlock(
  markdown: string,
  plan: DeepReadonly<ResolvedPlan>,
): string {
  const closing =
    plan.source === 'file'
      ? `The plan file at ${plan.path} has been updated to match this revision. Follow the revised plan, not the version you originally submitted.`
      : 'Follow the revised plan, not the version you originally submitted.'
  return [
    'The user revised the plan during review. The authoritative version of the plan is now:',
    markdown,
    closing,
  ].join('\n\n')
}

function buildNotesBlock(
  annotations: DeepReadonly<AnnotationOut[]>,
  overallFeedback: string,
): string {
  const sections: string[] = [
    'The user approved the plan and attached implementation notes anchored to specific parts of the plan:',
  ]
  if (annotations.length > 0)
    sections.push(
      annotations.map((a, i) => annotationEntry(a, i, 'Note')).join('\n\n'),
    )
  if (overallFeedback.trim() !== '')
    sections.push(`Overall notes:\n${overallFeedback}`)
  sections.push(
    'Follow the plan, and take these notes into account during implementation.',
  )
  return sections.join('\n\n')
}

function buildDenyMessage(decision: DeepReadonly<DecisionRequest>): string {
  const sections: string[] = [
    'The user reviewed the plan and requests changes before approving it.',
  ]
  if (decision.annotations.length > 0)
    sections.push(
      'Inline comments (each refers to a quoted excerpt from the plan):\n\n' +
        decision.annotations
          .map((a, i) => annotationEntry(a, i, 'Comment'))
          .join('\n\n'),
    )
  if (decision.overallFeedback.trim() !== '')
    sections.push(`Overall feedback:\n${decision.overallFeedback}`)
  sections.push(
    'Revise the plan to address this feedback, then present the updated plan again using ExitPlanMode.',
  )
  if (decision.editedMarkdown !== undefined)
    sections.push(
      `The user also directly edited the plan; their edited version:\n\n${decision.editedMarkdown}`,
    )
  return sections.join('\n\n')
}

/**
 * All hook envelope construction lives here so an empirical correction to the
 * envelope shape (see protocol.ts caveat) is a one-file change.
 */
export function buildDecisionOutput(
  decision: DeepReadonly<DecisionRequest>,
  plan: DeepReadonly<ResolvedPlan>,
  toolInput: DeepReadonly<Record<string, unknown>> = {},
): HookAllowOutput | HookDenyOutput | null {
  if (decision.action === 'request-changes') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: buildDenyMessage(decision) },
      },
    }
  }

  // Echo tool_input on allow (required on >= 2.1.199, see protocol.ts); when
  // the user edited and the input carries the plan inline, the edited
  // markdown replaces it — the first-class delivery channel on new versions.
  const updatedInput: Record<string, unknown> = { ...toolInput }
  if (decision.editedMarkdown !== undefined && 'plan' in updatedInput)
    updatedInput['plan'] = decision.editedMarkdown

  const output: HookAllowOutput = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput,
        ...(decision.permissionMode !== undefined && {
          updatedPermissions: [
            {
              type: 'setMode' as const,
              mode: decision.permissionMode,
              destination: 'session' as const,
            },
          ],
        }),
      },
    },
  }
  const blocks: string[] = []
  if (decision.editedMarkdown !== undefined)
    blocks.push(buildRevisedBlock(decision.editedMarkdown, plan))
  if (decision.annotations.length > 0 || decision.overallFeedback.trim() !== '')
    blocks.push(buildNotesBlock(decision.annotations, decision.overallFeedback))
  if (blocks.length > 0) output.additionalContext = blocks.join('\n\n')
  return output
}
