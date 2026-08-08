import { describe, expect, it } from 'vitest'

import {
  isHookPayload,
  parsePayload,
  passThroughOnLaunchFailure,
  runHook,
} from '../src/cli/hook'
import {
  captureExit,
  captureExitAsync,
  fakeHookIO,
  FAKE_URL,
} from './helpers/fake-hook-io'

const VALID = JSON.stringify({
  session_id: 's1',
  transcript_path: '/t.jsonl',
  cwd: '/proj',
  hook_event_name: 'PermissionRequest',
  tool_name: 'ExitPlanMode',
  tool_input: {},
})

describe('parsePayload', () => {
  it('accepts a payload carrying the three fields the hook actually reads', () => {
    expect(parsePayload(VALID)).toMatchObject({
      session_id: 's1',
      transcript_path: '/t.jsonl',
      cwd: '/proj',
    })
  })

  it('rejects anything that is not a hook payload, so the hook passes through', () => {
    // Every rejection here becomes an exit-0-with-no-stdout, which is what
    // makes Claude Code fall back to its own prompt instead of hanging.
    const rejected = [
      'not json at all',
      '',
      'null',
      '[]',
      '"a string"',
      '42',
      JSON.stringify({ transcript_path: '/t.jsonl', cwd: '/proj' }),
      JSON.stringify({ session_id: 's1', cwd: '/proj' }),
      JSON.stringify({ session_id: 's1', transcript_path: '/t.jsonl' }),
      JSON.stringify({ session_id: 1, transcript_path: '/t.jsonl', cwd: '/p' }),
      JSON.stringify({ session_id: 's1', transcript_path: null, cwd: '/p' }),
    ]
    for (const raw of rejected)
      expect({ raw, parsed: parsePayload(raw) }).toEqual({ raw, parsed: null })
  })

  it('agrees with isHookPayload on an already-parsed value', () => {
    expect(isHookPayload(JSON.parse(VALID))).toBe(true)
    expect(isHookPayload({ session_id: 's1' })).toBe(false)
  })
})

describe('runHook — fail-open paths', () => {
  it('passes through on a malformed payload without touching stdout', async () => {
    const fake = fakeHookIO()
    const code = await captureExitAsync(runHook('not json at all', fake.io))

    expect(code).toBe(0)
    expect(fake.state.stdout).toEqual([])
    expect(fake.state.serverStarts).toBe(0)
    expect(fake.state.logs.join('\n')).toContain('malformed hook payload')
  })

  it('passes through when no plan can be found, without binding a port', async () => {
    const fake = fakeHookIO({ plan: { source: 'none' } })
    const code = await captureExitAsync(runHook(VALID, fake.io))

    expect(code).toBe(0)
    expect(fake.state.stdout).toEqual([])
    expect(fake.state.serverStarts).toBe(0)
    expect(fake.state.logs.join('\n')).toContain('no plan found')
  })

  it('passes through on a headless box before the server is ever started', async () => {
    // The load-bearing ordering: binding first would park Claude Code on a
    // listening socket nobody can reach until the 86400s hook timeout, which
    // reads to the user as a frozen session.
    const fake = fakeHookIO({
      support: { kind: 'unavailable', reason: 'no DISPLAY' },
    })
    const code = await captureExitAsync(runHook(VALID, fake.io))

    expect(code).toBe(0)
    expect(fake.state.serverStarts).toBe(0)
    expect(fake.state.launches).toEqual([])
    // The log line is the user's only pointer back to a review here.
    expect(fake.state.logs.join('\n')).toContain('MILKPLAN_NO_BROWSER=1')
  })

  it('passes through when the review server cannot start', async () => {
    const fake = fakeHookIO({ serverFails: true })
    const code = await captureExitAsync(runHook(VALID, fake.io))

    expect(code).toBe(0)
    expect(fake.state.stdout).toEqual([])
    expect(fake.state.logs.join('\n')).toContain(
      'review server failed to start',
    )
  })
})

describe('runHook — happy path', () => {
  it('serves the review and hands the tokenized URL to the browser launcher', async () => {
    const fake = fakeHookIO()
    await runHook(VALID, fake.io)

    expect(fake.state.serverStarts).toBe(1)
    expect(fake.state.launches).toEqual([FAKE_URL])
    // Nothing may reach stdout until a decision arrives.
    expect(fake.state.stdout).toEqual([])
    expect(fake.state.exits).toEqual([])
    // The URL is logged so a user whose browser silently failed can still open it.
    expect(fake.state.logs.join('\n')).toContain(FAKE_URL)
  })

  it('keeps serving when the browser is suppressed rather than passing through', async () => {
    // MILKPLAN_NO_BROWSER means "serve and wait for a manual visit" — the
    // escape hatch ssh -L users and the e2e suite both rely on.
    const fake = fakeHookIO({ support: { kind: 'suppressed' } })
    await runHook(VALID, fake.io)

    expect(fake.state.serverStarts).toBe(1)
    expect(fake.state.exits).toEqual([])
  })
})

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('passThroughOnLaunchFailure', () => {
  it('closes the server and exits when every launcher turned out to be missing', () => {
    // WSL with interop disabled: detection cannot see it, so an exhausted
    // launcher chain is the only signal that nobody is coming.
    const fake = fakeHookIO()
    let closed = 0
    const onExhausted = passThroughOnLaunchFailure(
      {
        close: () => {
          closed += 1
        },
      },
      () => false,
      fake.io,
    )

    expect(captureExit(onExhausted)).toBe(0)
    expect(closed).toBe(1)
    expect(fake.state.logs.join('\n')).toContain(
      'every browser launcher failed',
    )
  })

  it('stands down when a decision is already in flight', () => {
    // The launcher chain and a decision can settle in the same tick; exiting
    // here would discard a review the user had already submitted.
    const fake = fakeHookIO()
    let closed = 0
    const onExhausted = passThroughOnLaunchFailure(
      {
        close: () => {
          closed += 1
        },
      },
      () => true,
      fake.io,
    )

    onExhausted()

    expect(closed).toBe(0)
    expect(fake.state.exits).toEqual([])
    expect(fake.state.logs).toEqual([])
  })

  it('still exits when closing the server throws', () => {
    // This runs inside a spawn error handler, where a throw would surface as
    // an uncaught exception instead of a passthrough.
    const fake = fakeHookIO()
    const onExhausted = passThroughOnLaunchFailure(
      {
        close: () => {
          throw new Error('already closed')
        },
      },
      () => false,
      fake.io,
    )

    expect(captureExit(onExhausted)).toBe(0)
  })
})
