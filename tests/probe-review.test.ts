import { describe, expect, it } from 'vitest'

import type { PendingEntry } from '../src/cli/pending'
import { probeReview, type ProbeFetch } from '../src/cli/probe-review'

const TOKEN = '0123456789abcdef0123456789abcdef'

const entry: PendingEntry = {
  pid: 100,
  url: `http://127.0.0.1:54321/#token=${TOKEN}`,
  sessionId: 'session-a',
  cwd: '/Users/dev/Code/app',
  planPath: null,
  startedAt: 1_700_000_000_000,
}

interface ProbeCall {
  url: string
  token: string
  timeoutMs: number
}

/** Builds a ProbeFetch from a plain responder, recording what it was asked. */
function fakeFetch(respond: () => Response): {
  fetch: ProbeFetch
  calls: readonly ProbeCall[]
} {
  const calls: ProbeCall[] = []
  return {
    calls,
    fetch: (url, token, timeoutMs) => {
      calls.push({ url, token, timeoutMs })
      return Promise.resolve(respond())
    },
  }
}

function throwingFetch(makeError: () => Error): ProbeFetch {
  return () => Promise.reject(makeError())
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function refused(): Error {
  const error = new TypeError('fetch failed')
  // undici hangs the errno off the cause, which is what isConnectionRefused reads.
  Object.defineProperty(error, 'cause', { value: { code: 'ECONNREFUSED' } })
  return error
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('probeReview', () => {
  it('asks /api/review with the token lifted out of the fragment', async () => {
    // The token lives in the #token= fragment, which is never transmitted:
    // fetching the stored URL as-is would hit index.html and get a bare 200.
    const fake = fakeFetch(() =>
      jsonResponse(200, { meta: { sessionId: 'session-a' } }),
    )
    expect(await probeReview(entry, fake.fetch)).toBe('live')
    expect(fake.calls).toEqual([
      {
        url: 'http://127.0.0.1:54321/api/review',
        token: TOKEN,
        timeoutMs: 500,
      },
    ])
  })

  it('calls a 200 from a different session dead', async () => {
    // A reused ephemeral port held by an unrelated server with an SPA catch-all
    // answers 200 to anything; sending the browser there would be worse than
    // reporting nothing pending.
    const fake = fakeFetch(() =>
      jsonResponse(200, { meta: { sessionId: 'other' } }),
    )
    expect(await probeReview(entry, fake.fetch)).toBe('dead')
  })

  it('calls a 200 that is not even JSON dead', async () => {
    const fake = fakeFetch(
      () =>
        new Response('<!doctype html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    expect(await probeReview(entry, fake.fetch)).toBe('dead')
  })

  it('calls a non-200 dead — a 403 means another review took the port', async () => {
    const fake = fakeFetch(() => new Response('', { status: 403 }))
    expect(await probeReview(entry, fake.fetch)).toBe('dead')
  })

  it('calls connection-refused dead', async () => {
    expect(await probeReview(entry, throwingFetch(refused))).toBe('dead')
  })

  it('calls a timeout indeterminate rather than dead', async () => {
    // A Ctrl-Z'd session accepts the connection and answers on fg, so a
    // timeout must not delete an entry the user can still reach.
    const timedOut = (): Error =>
      new DOMException('The operation was aborted', 'TimeoutError')
    expect(await probeReview(entry, throwingFetch(timedOut))).toBe(
      'indeterminate',
    )
  })

  it('calls an unparseable stored URL dead without touching the network', async () => {
    const fake = fakeFetch(() => jsonResponse(200, {}))
    expect(await probeReview({ ...entry, url: 'not a url' }, fake.fetch)).toBe(
      'dead',
    )
    expect(fake.calls).toEqual([])
  })
})
