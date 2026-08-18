import { describe, expect, it } from 'vitest'

import {
  DRAFT_TTL_MS,
  clearDraft,
  hashPlan,
  parseDraft,
  pruneDrafts,
  readDraft,
  writeDraft,
} from '../src/ui/draft'
import { makeDraft } from './helpers/draft-fixtures'

describe('hashPlan', () => {
  it('is stable for equal input and differs across inputs', () => {
    expect(hashPlan('# Plan')).toBe(hashPlan('# Plan'))
    expect(hashPlan('# Plan')).not.toBe(hashPlan('# Plan v2'))
    // Fixed-width hex: the value is compared, never parsed.
    expect(hashPlan('')).toMatch(/^[0-9a-f]{8}$/u)
  })
})

describe('parseDraft', () => {
  it('round-trips a serialized draft', () => {
    const draft = makeDraft()
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft)
  })

  it('accepts an empty annotations list', () => {
    const draft = makeDraft({ annotations: [] })
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft)
  })

  it.each([
    ['null input', null],
    ['non-JSON', 'not json'],
    ['a JSON scalar', '42'],
    ['a foreign object', JSON.stringify({ theme: 'dark' })],
    ['a future version', JSON.stringify({ ...makeDraft(), version: 2 })],
    [
      'a missing field',
      JSON.stringify({ ...makeDraft(), markdown: undefined }),
    ],
    [
      'a wrong-typed field',
      JSON.stringify({ ...makeDraft(), savedAt: 'yesterday' }),
    ],
    [
      'a malformed annotation',
      JSON.stringify({ ...makeDraft(), annotations: [{ id: 'a1' }] }),
    ],
    [
      'a non-array annotations field',
      JSON.stringify({ ...makeDraft(), annotations: {} }),
    ],
  ])('rejects %s', (_label, raw) => {
    expect(parseDraft(raw)).toBeNull()
  })
})

describe('storage helpers without a DOM', () => {
  // The node project deliberately has no localStorage global: every helper
  // must fail open instead of throwing, because the same code path runs in
  // browsers whose privacy mode throws on any storage access.
  it('readDraft returns null instead of throwing', () => {
    expect(readDraft('session-1', '# Plan')).toBeNull()
  })

  it('writeDraft, clearDraft, and pruneDrafts are silent no-ops', () => {
    expect(() => {
      writeDraft('session-1', makeDraft())
      clearDraft('session-1')
      pruneDrafts(makeDraft().savedAt + DRAFT_TTL_MS + 1)
    }).not.toThrow()
  })
})
