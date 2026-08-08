import { afterEach, describe, expect, it } from 'vitest'

import { TOKEN_HEADER, type DecisionRequest } from '../src/shared/protocol'
import type { DeepReadonly } from '../src/shared/readonly'
import { createBooter, reviewPayload, TOKEN } from './helpers/review-server'

const { boot, cleanupAll } = createBooter()

afterEach(cleanupAll)

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('startReviewServer', () => {
  it('advertises the token in the URL fragment', async () => {
    const { server, base } = await boot()
    expect(server.url).toBe(`${base}/#token=${TOKEN}`)
  })

  it('rejects /api requests without or with a wrong token', async () => {
    const { base } = await boot()
    const noToken = await fetch(`${base}/api/review`)
    expect(noToken.status).toBe(403)
    const wrongToken = await fetch(`${base}/api/review`, {
      headers: { [TOKEN_HEADER]: 'wrong' },
    })
    expect(wrongToken.status).toBe(403)
  })

  it('serves the review payload on GET /api/review with the token', async () => {
    const { base } = await boot()
    const res = await fetch(`${base}/api/review`, {
      headers: { [TOKEN_HEADER]: TOKEN },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(reviewPayload)
  })

  it('invokes onDecision with the posted decision', async () => {
    let resolveReceived!: (d: DeepReadonly<DecisionRequest>) => void
    const received = new Promise<DeepReadonly<DecisionRequest>>((r) => {
      resolveReceived = r
    })
    const { base } = await boot({
      onDecision: (d: DeepReadonly<DecisionRequest>) => {
        resolveReceived(d)
      },
    })

    const body: DecisionRequest = {
      action: 'approve',
      editedMarkdown: '# Revised',
      annotations: [
        { excerpt: 'a passage', comment: 'a note', orphaned: false },
      ],
      overallFeedback: 'ship it',
    }
    const res = await fetch(`${base}/api/decision`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await received).toEqual(body)
  })

  it('rejects an invalid decision body with 400', async () => {
    let called = false
    const { base } = await boot({
      onDecision: () => {
        called = true
      },
    })
    const res = await fetch(`${base}/api/decision`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'explode' }),
    })
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  it('rejects malformed annotation items with 400 instead of crashing later', async () => {
    let called = false
    const { base } = await boot({
      onDecision: () => {
        called = true
      },
    })
    const res = await fetch(`${base}/api/decision`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'approve',
        annotations: [{}],
        overallFeedback: '',
      }),
    })
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  it('invokes onSkip on POST /api/skip', async () => {
    let resolveSkipped!: () => void
    const skipped = new Promise<void>((r) => {
      resolveSkipped = r
    })
    const { base } = await boot({
      onSkip: () => {
        resolveSkipped()
      },
    })
    const res = await fetch(`${base}/api/skip`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: TOKEN },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    await skipped
  })

  it('serves the UI index without a token', async () => {
    const { base } = await boot()
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('milkplan test ui')
  })

  it('rejects path traversal on the static route', async () => {
    const { base } = await boot()
    // Encoded slashes survive URL normalization, so the raw path reaches the
    // server; the decoded ../ segments must be rejected, not resolved.
    const res = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`)
    expect(res.status).toBe(403)
  })
})
