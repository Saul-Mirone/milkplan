import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { APPROVAL_PERMISSION_MODES, TOKEN_HEADER } from '../src/shared/protocol'
import {
  createBooter,
  decisionBody,
  raw,
  reviewPayload,
  untypedDecisionBody,
  JSON_HEADERS,
  TOKEN,
} from './helpers/review-server'

const { boot, cleanupAll } = createBooter()

afterEach(cleanupAll)

describe('handleApiRequest — host guard', () => {
  it('rejects a non-loopback Host before it ever looks at the token', async () => {
    // Loopback binding alone does not stop a malicious page in the same
    // browser from POSTing to 127.0.0.1:<port>; the Host check is what closes
    // the DNS-rebinding hole. Sending the CORRECT token is what proves the
    // host check runs first — otherwise a passing test proves only that some
    // 403 came back.
    const { base } = await boot()

    const rebind = await raw(base, '/api/review', {
      headers: { [TOKEN_HEADER]: TOKEN, host: 'localhost.evil.com' },
    })
    expect(rebind.status).toBe(403)
    expect(JSON.parse(rebind.body)).toEqual({ error: 'forbidden host' })
  })

  it('distinguishes a bad host from a bad token so the two guards cannot be confused', async () => {
    const { base } = await boot()
    const noToken = await raw(base, '/api/review', {
      headers: { host: '127.0.0.1' },
    })
    expect(noToken.status).toBe(403)
    expect(JSON.parse(noToken.body)).toEqual({
      error: 'missing or invalid token',
    })
  })

  it('accepts a literal localhost Host with a port, which is what a browser sends', async () => {
    const { base } = await boot()
    const port = new URL(base).port
    const res = await raw(base, '/api/review', {
      headers: { [TOKEN_HEADER]: TOKEN, host: `localhost:${port}` },
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual(reviewPayload)
  })
})

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('handleApiRequest — decision validation', () => {
  it('accepts every declared approval permission mode', async () => {
    const received: string[] = []
    const { base } = await boot({
      onDecision: (decision) => {
        // String() rather than a fallback: a dropped mode then shows up as
        // the literal "undefined" in the diff instead of a plausible value.
        received.push(String(decision.permissionMode))
      },
    })

    const responses = await Promise.all(
      APPROVAL_PERMISSION_MODES.map((mode) =>
        raw(base, '/api/decision', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: decisionBody({ permissionMode: mode }),
        }),
      ),
    )

    expect(responses.map((res) => res.status)).toEqual(
      APPROVAL_PERMISSION_MODES.map(() => 200),
    )
    expect([...received].sort()).toEqual([...APPROVAL_PERMISSION_MODES].sort())
  })

  it('rejects permission modes Claude Code knows but an approval must never set', async () => {
    // 'bypassPermissions' and 'plan' are real session modes; forwarding either
    // from a compromised page would hand away far more than the approval the
    // user actually clicked.
    let called = false
    const { base } = await boot({
      onDecision: () => {
        called = true
      },
    })

    const responses = await Promise.all(
      ['bypassPermissions', 'plan', ''].map((permissionMode) =>
        raw(base, '/api/decision', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: untypedDecisionBody({ permissionMode }),
        }),
      ),
    )
    expect(responses.map((res) => res.status)).toEqual([400, 400, 400])
    expect(called).toBe(false)
  })

  it('rejects every malformed decision shape with a 400 rather than throwing after the 200', async () => {
    // buildDecisionOutput runs AFTER the response is flushed, so anything this
    // validator lets through becomes an uncaught throw with no stdout and no
    // exit — and the hook is registered with timeout 86400, so the user's
    // session hangs for a day.
    let called = false
    const { base } = await boot({
      onDecision: () => {
        called = true
      },
    })

    const bodies = [
      'not json at all',
      '',
      'null',
      '[]',
      '"approve"',
      JSON.stringify({ annotations: [], overallFeedback: '' }),
      JSON.stringify({ action: 'approve', overallFeedback: '' }),
      untypedDecisionBody({ annotations: {} }),
      untypedDecisionBody({ overallFeedback: 7 }),
      untypedDecisionBody({
        annotations: [{ excerpt: 'a', comment: 'b', orphaned: 'no' }],
      }),
      untypedDecisionBody({ annotations: [null] }),
      untypedDecisionBody({ editedMarkdown: 42 }),
    ]

    const results = await Promise.all(
      bodies.map(async (body) => ({
        body,
        status: (
          await raw(base, '/api/decision', {
            method: 'POST',
            headers: JSON_HEADERS,
            body,
          })
        ).status,
      })),
    )
    expect(results).toEqual(bodies.map((body) => ({ body, status: 400 })))
    expect(called).toBe(false)
  })

  it('drops an oversized body without calling onDecision and stays up for the next request', async () => {
    // The 413 is written but the client normally sees ECONNRESET instead:
    // readBody destroys the request mid-upload. What has to hold is that no
    // decision fires and the server survives, so the user can retry.
    let called = false
    const { base } = await boot({
      onDecision: () => {
        called = true
      },
    })

    const outcome = await raw(base, '/api/decision', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: 'x'.repeat(11 * 1024 * 1024),
    })
      .then((res) => `status:${res.status}`)
      .catch(() => 'connection reset')
    expect(['connection reset', 'status:413']).toContain(outcome)
    expect(called).toBe(false)

    const after = await fetch(`${base}/api/review`, {
      headers: { [TOKEN_HEADER]: TOKEN },
    })
    expect(after.status).toBe(200)
  })

  it('404s an authenticated request to an unknown api route or the wrong method', async () => {
    const { base } = await boot()
    const [unknown, wrongMethod, postReview] = await Promise.all([
      raw(base, '/api/nope', { headers: { [TOKEN_HEADER]: TOKEN } }),
      raw(base, '/api/decision', { headers: { [TOKEN_HEADER]: TOKEN } }),
      raw(base, '/api/review', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{}',
      }),
    ])
    expect([unknown.status, wrongMethod.status, postReview.status]).toEqual([
      404, 404, 404,
    ])
  })
})

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('serveStatic', () => {
  it('labels each asset type the browser needs to execute it', async () => {
    // A .js served as application/octet-stream is refused by the module
    // loader, so the review page renders blank with only a console error.
    const { base, uiDir } = await boot()
    await Promise.all([
      writeFile(join(uiDir, 'app.js'), 'export const ok = 1'),
      writeFile(join(uiDir, 'app.css'), '.mp-app{}'),
      writeFile(join(uiDir, 'data.bin'), 'binary'),
    ])

    const [script, style, unknown] = await Promise.all([
      fetch(`${base}/app.js`),
      fetch(`${base}/app.css`),
      fetch(`${base}/data.bin`),
    ])
    expect(script.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    )
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(unknown.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('falls back to index.html for a path that does not exist', async () => {
    const { base } = await boot()
    const res = await fetch(`${base}/assets/app-abc123.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toContain('milkplan test ui')
  })

  it('refuses a non-GET request for a static path', async () => {
    const { base } = await boot()
    const res = await raw(base, '/index.html', { method: 'DELETE' })
    expect(res.status).toBe(405)
  })

  it('answers an undecodable path instead of dying, and keeps serving afterwards', async () => {
    // decodeURIComponent throws URIError on a stray percent; that rejection
    // has to land in the request handler's catch, not take the process down
    // and leave Claude Code waiting out the hook timeout.
    const { base } = await boot()
    const paths = ['/%', '/%zz']
    const results = await Promise.all(
      paths.map(async (path) => ({
        path,
        status: (await raw(base, path)).status,
      })),
    )
    expect(results).toEqual(paths.map((path) => ({ path, status: 500 })))

    const after = await fetch(`${base}/`)
    expect(after.status).toBe(200)
  })
})
