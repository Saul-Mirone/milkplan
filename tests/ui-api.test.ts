import { afterEach, describe, expect, it } from 'vitest'

import { tokenFromHash } from '../src/ui/api'
import { DEV_TOKEN } from '../src/shared/protocol'
import { createBooter, TOKEN } from './helpers/review-server'

const { boot, cleanupAll } = createBooter()

afterEach(cleanupAll)

describe('tokenFromHash', () => {
  it('reads back exactly the token the review server advertises', async () => {
    // Couples producer and consumer: open-browser carries this URL verbatim
    // into every launcher, and a mismatch between the two sides yields a page
    // that loads and then 403s on its first fetch — a silently broken review
    // rather than a visible failure.
    const { server } = await boot()
    expect(tokenFromHash(new URL(server.url).hash)).toBe(TOKEN)
  })

  it('finds the token when it is not the first fragment parameter', () => {
    expect(tokenFromHash('#view=split&token=abc123')).toBe('abc123')
  })

  it('stops at the next parameter rather than swallowing the rest', () => {
    expect(tokenFromHash('#token=abc123&view=split')).toBe('abc123')
  })

  it('falls back to the dev token when the fragment carries none', () => {
    // This fallback is what lets `vite dev` work without a fragment.
    for (const hash of ['', '#', '#view=split', '#tokenish=abc'])
      expect({ hash, token: tokenFromHash(hash) }).toEqual({
        hash,
        token: DEV_TOKEN,
      })
  })
})
