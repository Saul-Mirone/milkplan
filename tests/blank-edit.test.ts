import { describe, expect, it } from 'vitest'

import { buildDecisionOutput, editedMarkdownOf } from '../src/cli/feedback'
import type {
  DecisionRequest,
  HookAllowOutput,
  HookOutput,
  ResolvedPlan,
} from '../src/shared/protocol'
import type { DeepReadonly } from '../src/shared/readonly'

const filePlan: ResolvedPlan = {
  source: 'file',
  path: '/Users/test/.claude/plans/sunny-rolling-otter.md',
  markdown: '# Original plan',
}

function decision(
  overrides: DeepReadonly<Partial<DecisionRequest>> = {},
): DeepReadonly<DecisionRequest> {
  return {
    action: 'approve',
    annotations: [],
    overallFeedback: '',
    ...overrides,
  }
}

function denyMessage(output: DeepReadonly<HookOutput>): string {
  const { decision: outcome } = output.hookSpecificOutput
  if (outcome.behavior !== 'deny') throw new Error('expected a deny output')
  return outcome.message
}

function isAllow(
  output: DeepReadonly<HookOutput>,
): output is DeepReadonly<HookAllowOutput> {
  return output.hookSpecificOutput.decision.behavior === 'allow'
}

function allowOutput(
  output: DeepReadonly<HookOutput>,
): DeepReadonly<HookAllowOutput> {
  if (!isAllow(output)) throw new Error('expected allow output, got deny')
  return output
}

/**
 * Regression suite for the one-click plan-destroying path: PlanEditor reports
 * isEdited() from a plain string compare, so select-all + delete counts as an
 * edit whose content is empty. Before this guard, approving then wrote that
 * empty string over the plan file and told Claude it was the authoritative
 * revision — irreversibly, in a single click.
 */
describe('editedMarkdownOf', () => {
  it('treats an empty or whitespace-only edit as no edit at all', () => {
    for (const editedMarkdown of ['', '   ', '\n\n', '\t \n']) {
      expect({
        editedMarkdown,
        result: editedMarkdownOf(decision({ editedMarkdown })),
      }).toEqual({ editedMarkdown, result: undefined })
    }
  })

  it('passes real content through untouched, including its surrounding blank lines', () => {
    const editedMarkdown = '\n# Revised plan\n\nStep one.\n'
    expect(editedMarkdownOf(decision({ editedMarkdown }))).toBe(editedMarkdown)
  })

  it('reports no edit when the field is absent', () => {
    expect(editedMarkdownOf(decision())).toBeUndefined()
  })
})

describe('buildDecisionOutput with a blank edit', () => {
  it('does not announce a revision, and leaves the echoed plan alone', () => {
    // Without the guard this produced "The authoritative version of the plan
    // is now:" followed by nothing, and blanked tool_input.plan as well.
    const toolInput = { plan: '# Original', planFilePath: '/x/plan.md' }
    const output = buildDecisionOutput(
      decision({ editedMarkdown: '   \n' }),
      filePlan,
      toolInput,
    )
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: toolInput },
      },
    })
    expect(allowOutput(output).additionalContext).toBeUndefined()
  })

  it('still reports annotations when the edit alongside them is blank', () => {
    const output = buildDecisionOutput(
      decision({
        editedMarkdown: '',
        overallFeedback: 'looks good',
      }),
      filePlan,
    )
    const context = allowOutput(output).additionalContext
    expect(context).toContain('looks good')
    expect(context).not.toContain('The user revised the plan during review')
  })

  it('omits the edited-version appendix from a request-changes message', () => {
    const output = buildDecisionOutput(
      decision({
        action: 'request-changes',
        editedMarkdown: '\n',
        overallFeedback: 'please rework this',
      }),
      filePlan,
    )
    expect(denyMessage(output)).not.toContain('their edited version')
  })
})
