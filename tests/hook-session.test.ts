import { describe, expect, it } from 'vitest'

import { buildSession, type FoundPlan } from '../src/cli/hook'
import type { DecisionRequest, PlanVersion } from '../src/shared/protocol'
import type { DeepReadonly } from '../src/shared/readonly'
import {
  captureExit,
  fakeHookIO,
  payload,
  type FakeHook,
} from './helpers/fake-hook-io'

const PLAN_PATH = '/Users/dev/.claude/plans/sunny-rolling-otter.md'

const filePlan: FoundPlan = {
  source: 'file',
  path: PLAN_PATH,
  markdown: '# Plan under review',
}

const inlinePlan: FoundPlan = {
  source: 'inline',
  markdown: '# Plan under review',
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

function sessionFor(
  fake: DeepReadonly<FakeHook>,
  // Forwarded verbatim into buildSession, whose contract takes the mutable
  // domain types; a readonly parameter here would not be assignable.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  plan: FoundPlan = filePlan,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  toolInput: Record<string, unknown> = {},
) {
  return buildSession({
    plan,
    payload: payload({ tool_input: toolInput }),
    history: [],
    getRunning: () => ({ url: '', close: () => {} }),
    // The ordering suites build their own session so they can observe this;
    // here it only has to exist.
    onSettle: () => {},
    io: fake.io,
  })
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('buildSession — plan write-back', () => {
  it('writes the edited plan to disk before answering Claude', () => {
    const fake = fakeHookIO()
    const session = sessionFor(fake)

    captureExit(() => {
      session.onDecision(decision({ editedMarkdown: '# Revised\n' }))
    })

    expect(fake.state.planWrites).toEqual([
      { path: PLAN_PATH, content: '# Revised\n' },
    ])
  })

  it('writes the edits back on request-changes too, not only on approve', () => {
    // The plan file is the document the user was editing; a rejection that
    // discarded their edits would lose work they can never recover.
    const fake = fakeHookIO()
    const session = sessionFor(fake)

    captureExit(() => {
      session.onDecision(
        decision({
          action: 'request-changes',
          editedMarkdown: '# Reworked\n',
          overallFeedback: 'see my edits',
        }),
      )
    })

    expect(fake.state.planWrites).toEqual([
      { path: PLAN_PATH, content: '# Reworked\n' },
    ])
  })

  it('never truncates the plan file when the user emptied the editor', () => {
    // The UI guards this too, but the server accepts a decision from anything
    // holding the token and this write cannot be undone.
    const fake = fakeHookIO()
    const session = sessionFor(fake)

    captureExit(() => {
      session.onDecision(decision({ editedMarkdown: '   \n' }))
    })

    expect(fake.state.planWrites).toEqual([])
  })

  it('writes nothing for an inline plan, which has no file behind it', () => {
    const fake = fakeHookIO()
    const session = sessionFor(fake, inlinePlan)

    captureExit(() => {
      session.onDecision(decision({ editedMarkdown: '# Revised\n' }))
    })

    expect(fake.state.planWrites).toEqual([])
  })

  it('still answers Claude when the plan file cannot be written', () => {
    // A read-only plans directory must degrade to context-only delivery, not
    // swallow the decision: no stdout and no exit would hang the session for
    // the hook's full 86400s timeout.
    const fake = fakeHookIO({ planWriteFails: true })
    const session = sessionFor(fake)

    captureExit(() => {
      session.onDecision(decision({ editedMarkdown: '# Revised\n' }))
    })

    expect(fake.onlyLine()).toContain('# Revised')
    expect(fake.state.logs.join('\n')).toContain('delivering edits via context')
  })
})

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('buildSession — stdout discipline', () => {
  it('emits exactly one newline-terminated line of valid JSON', () => {
    // Any extra byte on stdout makes the envelope unparseable and Claude Code
    // silently falls back to its own dialog, discarding the whole review.
    const fake = fakeHookIO()
    const session = sessionFor(fake)

    captureExit(() => {
      session.onDecision(decision({ overallFeedback: 'ship it' }))
    })

    const line = fake.onlyLine()
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    })
  })

  it('exits only once the bytes have actually left the process', () => {
    // A >64 KiB additionalContext does not fit a single pipe write. Exiting
    // before the flush callback truncates the JSON mid-string, which reads to
    // Claude Code as a malformed hook response.
    const fake = fakeHookIO({ deferFlush: true })
    const session = sessionFor(fake)

    session.onDecision(decision({ overallFeedback: 'ship it' }))

    expect(fake.state.stdout).toHaveLength(1)
    expect(fake.state.exits).toEqual([])

    const flush = fake.state.flushes[0]
    expect(flush).toBeDefined()
    expect(() => flush?.()).toThrow('process.exit(0)')
    expect(fake.state.exits).toEqual([0])
  })

  it('settles and closes the server before writing, so no second decision can land', () => {
    const fake = fakeHookIO()
    const session = buildSession({
      plan: filePlan,
      payload: payload(),
      history: [],
      getRunning: () => ({
        url: '',
        close: () => {
          fake.state.events.push('close')
        },
      }),
      onSettle: () => {
        fake.state.events.push('settle')
      },
      io: fake.io,
    })

    captureExit(() => {
      session.onDecision(decision())
    })

    expect(fake.state.events).toEqual(['settle', 'close', 'stdout', 'exit'])
  })
})

describe('buildSession — skip', () => {
  it('exits silently, leaving Claude Code to run its own approval prompt', () => {
    const fake = fakeHookIO()
    const session = buildSession({
      plan: filePlan,
      payload: payload(),
      history: [],
      getRunning: () => ({
        url: '',
        close: () => {
          fake.state.events.push('close')
        },
      }),
      onSettle: () => {
        fake.state.events.push('settle')
      },
      io: fake.io,
    })

    const code = captureExit(() => {
      session.onSkip()
    })

    expect(code).toBe(0)
    expect(fake.state.stdout).toEqual([])
    expect(fake.state.events).toEqual(['settle', 'close', 'exit'])
  })
})

describe('buildSession — review payload', () => {
  it('hands the UI the plan path for a file plan and null for an inline one', () => {
    const fake = fakeHookIO()
    expect(sessionFor(fake, filePlan).payload.meta.planPath).toBe(PLAN_PATH)
    expect(sessionFor(fake, inlinePlan).payload.meta.planPath).toBeNull()
  })

  it('forwards the recorded history into the payload untouched', () => {
    const fake = fakeHookIO()
    const history: PlanVersion[] = [
      {
        ts: 1_700_000_000_000,
        round: 1,
        planPath: PLAN_PATH,
        markdown: '# Round 1',
      },
    ]
    const session = buildSession({
      plan: filePlan,
      payload: payload(),
      history,
      getRunning: () => ({ url: '', close: () => {} }),
      onSettle: () => {},
      io: fake.io,
    })

    // Same reference, not a copy: buildSession must not rewrite the rounds.
    expect(session.payload.history).toBe(history)
  })

  it('mints a fresh 32-character hex token per session', () => {
    // The token is the only thing standing between a drive-by page and the
    // review; reusing one across sessions would make it guessable from a log.
    const fake = fakeHookIO()
    const first = sessionFor(fake).token
    const second = sessionFor(fake).token
    expect(first).toMatch(/^[0-9a-f]{32}$/u)
    expect(second).not.toBe(first)
  })
})
