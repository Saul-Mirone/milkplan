import { describe, expect, it } from 'vitest'

import { resolveOpenMode, type OpenMode } from '../src/cli/open-mode'

function resolve(env: Readonly<Partial<Record<string, string>>>): {
  mode: OpenMode
  logs: readonly string[]
} {
  const logs: string[] = []
  const mode = resolveOpenMode(env, (message) => {
    logs.push(message)
  })
  return { mode, logs }
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('resolveOpenMode', () => {
  it('defaults to auto when nothing is set', () => {
    expect(resolve({}).mode).toBe('auto')
  })

  it('accepts every mode name', () => {
    expect(resolve({ MILKPLAN_OPEN: 'auto' }).mode).toBe('auto')
    expect(resolve({ MILKPLAN_OPEN: 'background' }).mode).toBe('background')
    expect(resolve({ MILKPLAN_OPEN: 'manual' }).mode).toBe('manual')
  })

  it('trims and lowercases the value', () => {
    expect(resolve({ MILKPLAN_OPEN: '  background  ' }).mode).toBe('background')
    expect(resolve({ MILKPLAN_OPEN: 'Manual' }).mode).toBe('manual')
    expect(resolve({ MILKPLAN_OPEN: 'AUTO' }).mode).toBe('auto')
  })

  it('falls back to auto and logs on an unrecognized value', () => {
    // Fail-open: a typo in a shell profile must not cost the user a review,
    // but it must not be swallowed either.
    const { mode, logs } = resolve({ MILKPLAN_OPEN: 'backgrund' })
    expect(mode).toBe('auto')
    expect(logs.join('\n')).toContain('backgrund')
  })

  it('treats empty and whitespace-only as unset, without logging', () => {
    // An unset-shaped value is not a typo; warning about it would be noise.
    for (const value of ['', '   ']) {
      const { mode, logs } = resolve({ MILKPLAN_OPEN: value })
      expect(mode).toBe('auto')
      expect(logs).toEqual([])
    }
  })

  it('lets MILKPLAN_NO_BROWSER win over any MILKPLAN_OPEN value', () => {
    // The older switch means exactly 'manual'. It has to win, or a developer's
    // ambient MILKPLAN_OPEN=auto would make the e2e suite launch real browsers.
    expect(resolve({ MILKPLAN_NO_BROWSER: '1' }).mode).toBe('manual')
    for (const open of ['auto', 'background', 'manual', 'nonsense']) {
      const { mode, logs } = resolve({
        MILKPLAN_NO_BROWSER: '1',
        MILKPLAN_OPEN: open,
      })
      expect(mode).toBe('manual')
      // It short-circuits, so even a bogus MILKPLAN_OPEN goes unremarked.
      expect(logs).toEqual([])
    }
  })

  it('falls through to MILKPLAN_OPEN when MILKPLAN_NO_BROWSER is empty', () => {
    expect(
      resolve({ MILKPLAN_NO_BROWSER: '', MILKPLAN_OPEN: 'background' }).mode,
    ).toBe('background')
    expect(resolve({ MILKPLAN_NO_BROWSER: '' }).mode).toBe('auto')
  })
})
