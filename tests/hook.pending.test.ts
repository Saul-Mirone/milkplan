import { describe, expect, it } from 'vitest'

import { runHook } from '../src/cli/hook'
import { captureExitAsync, fakeHookIO, FAKE_URL } from './helpers/fake-hook-io'

const VALID = JSON.stringify({
  session_id: 's1',
  transcript_path: '/t.jsonl',
  cwd: '/proj',
  hook_event_name: 'PermissionRequest',
  tool_name: 'ExitPlanMode',
  tool_input: {},
})

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('runHook pending registration', () => {
  it('registers the running review exactly once, with the plan path', async () => {
    const fake = fakeHookIO()
    await runHook(VALID, fake.io)

    expect(fake.state.pendingRegistrations).toEqual([
      {
        url: FAKE_URL,
        sessionId: 's1',
        cwd: '/proj',
        planPath: '/Users/dev/.claude/plans/sunny-rolling-otter.md',
      },
    ])
  })

  it('registers a null planPath for an inline plan', async () => {
    // Older Claude Code versions send the plan text rather than a file path;
    // there is nothing on disk for `milkplan open` to name.
    const fake = fakeHookIO({
      plan: { source: 'inline', markdown: '# Plan under review' },
    })
    await runHook(VALID, fake.io)

    expect(fake.state.pendingRegistrations.at(0)?.planPath).toBeNull()
  })

  it('registers after the server is listening, never before', async () => {
    // The URL does not exist until then, and registering a review that failed
    // to start would hand `milkplan open` a dead port to launch.
    const fake = fakeHookIO()
    await runHook(VALID, fake.io)

    const { events } = fake.state
    expect(events.indexOf('register-pending')).toBeGreaterThan(
      events.indexOf('start-server'),
    )
  })

  it('registers nothing on any passthrough exit', async () => {
    // Mirrors the history guarantee: the call sits after every passthrough, so
    // a review nobody can reach never enters the registry.
    const malformed = fakeHookIO()
    await captureExitAsync(runHook('not json at all', malformed.io))
    const planless = fakeHookIO({ plan: { source: 'none' } })
    await captureExitAsync(runHook(VALID, planless.io))
    const headless = fakeHookIO({
      support: { kind: 'unavailable', reason: 'no DISPLAY' },
    })
    await captureExitAsync(runHook(VALID, headless.io))
    const serverless = fakeHookIO({ serverFails: true })
    await captureExitAsync(runHook(VALID, serverless.io))

    for (const fake of [malformed, planless, headless, serverless])
      expect(fake.state.pendingRegistrations).toEqual([])
  })

  it('still registers in manual mode, which is the case it exists for', async () => {
    // Nothing will open, so the registry is the only way back to this review.
    // (That openBrowser itself launches nothing when suppressed is asserted in
    // tests/open-browser.test.ts; runHook calls io.launch either way.)
    const fake = fakeHookIO({
      support: { kind: 'suppressed', reason: 'MILKPLAN_OPEN=manual' },
    })
    await runHook(VALID, fake.io)

    expect(fake.state.pendingRegistrations).toHaveLength(1)
    // And the user is told how to reach it, since no window will announce it.
    expect(fake.state.logs.join('\n')).toContain('milkplan open')
  })
})
