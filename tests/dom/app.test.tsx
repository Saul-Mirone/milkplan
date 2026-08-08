import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from '../../src/ui/App'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * These cover the phases before the editor mounts. The review phase itself
 * builds a real Crepe instance (shiki, ProseMirror, a live DOM), which the
 * end-to-end suite exercises through the actual browser bundle instead.
 */
describe('App — pre-review phases', () => {
  it('shows a loading screen until the review payload arrives', () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    render(<App />)
    expect(screen.getByText('Loading plan…')).toBeDefined()
  })

  it('explains a failed load instead of leaving a blank page', async () => {
    // The realistic cause is a stale tab reusing a spent token, which 403s.
    // Without this the user sees nothing and cannot tell the review is dead.
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({}),
      }),
    )
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Review unavailable')).toBeDefined()
    })
    expect(screen.getByText(/failed with status 403/u)).toBeDefined()
  })

  it('falls back to a generic message when the failure carries no Error', async () => {
    // The rejection deliberately carries a bare string: App's `cause
    // instanceof Error` check is exactly what this exercises, so an Error here
    // would test the other branch.
    // oxlint-disable-next-line eslint/prefer-promise-reject-errors, typescript/prefer-promise-reject-errors
    vi.stubGlobal('fetch', () => Promise.reject('network down'))
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Failed to load review')).toBeDefined()
    })
  })
})
