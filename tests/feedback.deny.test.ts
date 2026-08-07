import { describe, expect, it } from 'vitest'

import { buildDecisionOutput } from '../src/cli/feedback'
import type {
  AnnotationOut,
  DecisionRequest,
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

function note(
  excerpt: string,
  comment: string,
  orphaned = false,
): AnnotationOut {
  return { excerpt, comment, orphaned }
}

function denyMessage(output: DeepReadonly<HookOutput> | null): string {
  if (output === null) throw new Error('expected deny output, got null')
  const d = output.hookSpecificOutput.decision
  if (d.behavior !== 'deny') throw new Error('expected deny output, got allow')
  return d.message
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('buildDecisionOutput — request changes', () => {
  it('deny with annotations and overall feedback', () => {
    const output = buildDecisionOutput(
      decision({
        action: 'request-changes',
        annotations: [
          note('hashed remote address', 'This breaks users behind CGNAT.'),
          note('a deleted paragraph', 'This was load-bearing.', true),
        ],
        overallFeedback: 'Rework the client key strategy.',
      }),
      filePlan,
    )
    expect(denyMessage(output)).toMatchInlineSnapshot(`
      "The user reviewed the plan and requests changes before approving it.

      Inline comments (each refers to a quoted excerpt from the plan):

      1. Regarding: "hashed remote address"
         Comment: This breaks users behind CGNAT.

      2. Regarding a passage that was removed during review (original text: "a deleted paragraph")
         Comment: This was load-bearing.

      Overall feedback:
      Rework the client key strategy.

      Revise the plan to address this feedback, then present the updated plan again using ExitPlanMode."
    `)
  })

  it('deny with overall feedback only omits the inline comments section', () => {
    const output = buildDecisionOutput(
      decision({
        action: 'request-changes',
        overallFeedback: 'Please split this into two phases.',
      }),
      filePlan,
    )
    expect(denyMessage(output)).toMatchInlineSnapshot(`
      "The user reviewed the plan and requests changes before approving it.

      Overall feedback:
      Please split this into two phases.

      Revise the plan to address this feedback, then present the updated plan again using ExitPlanMode."
    `)
  })

  it('deny with annotations only omits the overall feedback section', () => {
    const output = buildDecisionOutput(
      decision({
        action: 'request-changes',
        annotations: [
          note('EVAL with a small Lua script', 'Use a Redis function.'),
        ],
      }),
      filePlan,
    )
    expect(denyMessage(output)).toMatchInlineSnapshot(`
      "The user reviewed the plan and requests changes before approving it.

      Inline comments (each refers to a quoted excerpt from the plan):

      1. Regarding: "EVAL with a small Lua script"
         Comment: Use a Redis function.

      Revise the plan to address this feedback, then present the updated plan again using ExitPlanMode."
    `)
  })

  it('deny with edits appends the edited-version appendix', () => {
    const output = buildDecisionOutput(
      decision({
        action: 'request-changes',
        editedMarkdown: '# Reworked plan\n\nPhase 1 only.',
        overallFeedback: 'See my edits for the direction I want.',
      }),
      filePlan,
    )
    expect(denyMessage(output)).toMatchInlineSnapshot(`
      "The user reviewed the plan and requests changes before approving it.

      Overall feedback:
      See my edits for the direction I want.

      Revise the plan to address this feedback, then present the updated plan again using ExitPlanMode.

      The user also directly edited the plan; their edited version:

      # Reworked plan

      Phase 1 only."
    `)
  })
})
