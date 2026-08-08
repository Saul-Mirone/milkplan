import { describe, expect, it } from 'vitest'

import { buildSession, type FoundPlan } from '../src/cli/hook'
import type { DecisionRequest } from '../src/shared/protocol'
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
describe('buildSession — one review, one answer', () => {
  it('ignores a second decision arriving before the first has exited', () => {
    // server.close() only stops NEW connections, and handleApiRequest is
    // stateless, so a duplicated tab holding the same #token= can post again
    // in the window before the flush callback exits. Two JSON lines on stdout
    // is an unparseable hook response and the review would be thrown away.
    const fake = fakeHookIO({ deferFlush: true })
    const session = sessionFor(fake)

    session.onDecision(decision({ editedMarkdown: '# First\n' }))
    session.onDecision(decision({ editedMarkdown: '# Second\n' }))

    expect(fake.state.stdout).toHaveLength(1)
    expect(fake.onlyLine()).toContain('# First')
    expect(fake.state.planWrites).toEqual([
      { path: PLAN_PATH, content: '# First\n' },
    ])
  })

  it('ignores a skip that lands after a decision', () => {
    const fake = fakeHookIO({ deferFlush: true })
    const session = sessionFor(fake)

    session.onDecision(decision())
    session.onSkip()

    // The skip's exit would fire before the decision's bytes had flushed.
    expect(fake.state.exits).toEqual([])
    expect(fake.state.stdout).toHaveLength(1)
  })

  it('ignores a decision that lands after a skip, keeping stdout empty', () => {
    // A skip means "fall back to Claude Code's own prompt"; a decision after
    // it would answer a prompt the user is already looking at.
    const fake = fakeHookIO()
    const session = sessionFor(fake)

    expect(
      captureExit(() => {
        session.onSkip()
      }),
    ).toBe(0)
    session.onDecision(decision({ editedMarkdown: '# Too late\n' }))

    expect(fake.state.stdout).toEqual([])
    expect(fake.state.planWrites).toEqual([])
    expect(fake.state.exits).toEqual([0])
  })

  it('settles exactly once, so the launcher-failure guard cannot re-arm', () => {
    const fake = fakeHookIO({ deferFlush: true })
    let settles = 0
    const session = buildSession({
      plan: filePlan,
      payload: payload(),
      history: [],
      getRunning: () => ({ url: '', close: () => {} }),
      onSettle: () => {
        settles += 1
      },
      io: fake.io,
    })

    session.onDecision(decision())
    session.onDecision(decision())
    session.onSkip()

    expect(settles).toBe(1)
  })
})
