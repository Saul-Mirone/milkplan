import { describe, expect, it } from 'vitest'

import { buildDecisionOutput } from '../src/cli/feedback'
import type {
  AnnotationOut,
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
const inlinePlan: ResolvedPlan = {
  source: 'inline',
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

function isAllow(
  output: DeepReadonly<HookOutput>,
): output is DeepReadonly<HookAllowOutput> {
  return output.hookSpecificOutput.decision.behavior === 'allow'
}

function allowOutput(
  output: DeepReadonly<HookOutput> | null,
): DeepReadonly<HookAllowOutput> {
  if (output === null) throw new Error('expected allow output, got null')
  if (!isAllow(output)) throw new Error('expected allow output, got deny')
  return output
}

function allowContext(output: DeepReadonly<HookOutput> | null): string {
  const context = allowOutput(output).additionalContext
  if (context === undefined) throw new Error('expected additionalContext')
  return context
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('buildDecisionOutput — approve', () => {
  it('clean approve echoes tool_input as updatedInput (required on >= 2.1.199)', () => {
    const toolInput = { plan: '# Original', planFilePath: '/x/plan.md' }
    const output = buildDecisionOutput(decision(), filePlan, toolInput)
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: toolInput },
      },
    })
  })

  it('approve with edits swaps the inline plan inside updatedInput', () => {
    const toolInput = { plan: '# Original', planFilePath: '/x/plan.md' }
    const output = buildDecisionOutput(
      decision({ editedMarkdown: '# Revised\n' }),
      filePlan,
      toolInput,
    )
    expect(
      allowOutput(output).hookSpecificOutput.decision.updatedInput,
    ).toEqual({
      plan: '# Revised',
      planFilePath: '/x/plan.md',
    })
  })

  it('approve with edits leaves updatedInput untouched when no inline plan exists', () => {
    const toolInput = { allowedPrompts: [] }
    const output = buildDecisionOutput(
      decision({ editedMarkdown: '# Revised\n' }),
      filePlan,
      toolInput,
    )
    expect(
      allowOutput(output).hookSpecificOutput.decision.updatedInput,
    ).toEqual(toolInput)
  })

  it('approve with a permission mode emits a session setMode permission update', () => {
    const output = buildDecisionOutput(
      decision({ permissionMode: 'acceptEdits' }),
      filePlan,
      {},
    )
    expect(
      allowOutput(output).hookSpecificOutput.decision.updatedPermissions,
    ).toEqual([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ])
  })

  it('approve without a permission mode omits updatedPermissions entirely', () => {
    const output = buildDecisionOutput(decision(), filePlan, {})
    expect(
      'updatedPermissions' in allowOutput(output).hookSpecificOutput.decision,
    ).toBe(false)
  })

  it('whitespace-only overall feedback still counts as clean approve', () => {
    const output = buildDecisionOutput(
      decision({ overallFeedback: '  \n ' }),
      filePlan,
    )
    expect(output).not.toBeNull()
    expect(allowOutput(output).additionalContext).toBeUndefined()
  })

  it('approve with edits (file source) includes the plan-file sentence', () => {
    const output = buildDecisionOutput(
      decision({ editedMarkdown: '# Revised plan\n\nUse Redis instead.' }),
      filePlan,
    )
    expect(allowContext(output)).toMatchInlineSnapshot(`
      "The user revised the plan during review. The authoritative version of the plan is now:

      # Revised plan

      Use Redis instead.

      The plan file at /Users/test/.claude/plans/sunny-rolling-otter.md has been updated to match this revision. Follow the revised plan, not the version you originally submitted."
    `)
  })

  it('approve with edits (inline source) drops the plan-file sentence', () => {
    const output = buildDecisionOutput(
      decision({ editedMarkdown: '# Revised plan\n\nUse Redis instead.' }),
      inlinePlan,
    )
    expect(allowContext(output)).toMatchInlineSnapshot(`
      "The user revised the plan during review. The authoritative version of the plan is now:

      # Revised plan

      Use Redis instead.

      Follow the revised plan, not the version you originally submitted."
    `)
  })

  it('approve with annotations only', () => {
    const output = buildDecisionOutput(
      decision({
        annotations: [
          note('token-bucket strategy', 'Prefer a sliding window here.'),
          note('TTL 120s', 'Double-check against session length.'),
        ],
      }),
      filePlan,
    )
    expect(allowContext(output)).toMatchInlineSnapshot(`
      "The user approved the plan and attached implementation notes anchored to specific parts of the plan:

      1. Regarding: "token-bucket strategy"
         Note: Prefer a sliding window here.

      2. Regarding: "TTL 120s"
         Note: Double-check against session length.

      Follow the plan, and take these notes into account during implementation."
    `)
  })

  it('approve with overall feedback only', () => {
    const output = buildDecisionOutput(
      decision({ overallFeedback: 'Looks good, keep the PR small.' }),
      filePlan,
    )
    expect(allowContext(output)).toMatchInlineSnapshot(`
      "The user approved the plan and attached implementation notes anchored to specific parts of the plan:

      Overall notes:
      Looks good, keep the PR small.

      Follow the plan, and take these notes into account during implementation."
    `)
  })

  it('approve with annotations and overall feedback', () => {
    const output = buildDecisionOutput(
      decision({
        annotations: [
          note('Redis instance', 'Reuse the existing client pool.'),
        ],
        overallFeedback: 'Ship behind a feature flag.',
      }),
      filePlan,
    )
    expect(allowContext(output)).toMatchInlineSnapshot(`
      "The user approved the plan and attached implementation notes anchored to specific parts of the plan:

      1. Regarding: "Redis instance"
         Note: Reuse the existing client pool.

      Overall notes:
      Ship behind a feature flag.

      Follow the plan, and take these notes into account during implementation."
    `)
  })

  it('approve with edits and notes joins both blocks with a blank line', () => {
    const output = buildDecisionOutput(
      decision({
        editedMarkdown: '# Revised plan',
        annotations: [note('burst of 10', 'Make this configurable.')],
        overallFeedback: 'Nice work.',
      }),
      filePlan,
    )
    expect(allowContext(output)).toMatchInlineSnapshot(`
      "The user revised the plan during review. The authoritative version of the plan is now:

      # Revised plan

      The plan file at /Users/test/.claude/plans/sunny-rolling-otter.md has been updated to match this revision. Follow the revised plan, not the version you originally submitted.

      The user approved the plan and attached implementation notes anchored to specific parts of the plan:

      1. Regarding: "burst of 10"
         Note: Make this configurable.

      Overall notes:
      Nice work.

      Follow the plan, and take these notes into account during implementation."
    `)
  })

  it('renders orphaned annotations with the removed-passage wording', () => {
    const output = buildDecisionOutput(
      decision({
        annotations: [
          note('a deleted paragraph', 'Why was this dropped?', true),
        ],
      }),
      filePlan,
    )
    expect(allowContext(output)).toMatchInlineSnapshot(`
      "The user approved the plan and attached implementation notes anchored to specific parts of the plan:

      1. Regarding a passage that was removed during review (original text: "a deleted paragraph")
         Note: Why was this dropped?

      Follow the plan, and take these notes into account during implementation."
    `)
  })

  it('truncates excerpts to 200 chars with a trailing ellipsis', () => {
    const long = 'x'.repeat(250)
    const output = buildDecisionOutput(
      decision({ annotations: [note(long, 'Too long.')] }),
      filePlan,
    )
    const context = allowContext(output)
    expect(context).toContain(`"${'x'.repeat(200)}…"`)
    expect(context).not.toContain('x'.repeat(201))
  })

  it('keeps a 200-char excerpt untouched', () => {
    const exact = 'y'.repeat(200)
    const output = buildDecisionOutput(
      decision({ annotations: [note(exact, 'Boundary.')] }),
      filePlan,
    )
    const context = allowContext(output)
    expect(context).toContain(`"${exact}"`)
    expect(context).not.toContain('…')
  })
})
