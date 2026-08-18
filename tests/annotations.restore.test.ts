import { describe, expect, it } from 'vitest'

import type { DeepReadonly } from '../src/shared/readonly'
import type { AnnotationSeed } from '../src/ui/annotations/seed'
import {
  boundsOf,
  makeHarness,
  QUICK_FROM,
  QUICK_TO,
} from './helpers/annotation-harness'

/** A seed anchored on "quick" in the harness doc; override per test. */
function makeSeed(
  overrides: DeepReadonly<Partial<AnnotationSeed>> = {},
): AnnotationSeed {
  return {
    id: 's1',
    from: QUICK_FROM,
    to: QUICK_TO,
    comment: 'why quick?',
    createdExcerpt: 'quick',
    orphaned: false,
    expectedExcerpt: 'quick',
    ...overrides,
  }
}

function restore(...seeds: readonly DeepReadonly<AnnotationSeed>[]) {
  return makeHarness({ initialAnnotations: seeds })
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('annotation plugin — restoring persisted records at init', () => {
  it('seeds a committed, decorated record whose anchor still matches', () => {
    const harness = restore(makeSeed())

    const record = harness.record('s1')
    expect(record.pending).toBe(false)
    expect(record.orphaned).toBe(false)
    expect(record.comment).toBe('why quick?')
    expect(harness.textOf(record.from, record.to)).toBe('quick')
    expect(harness.decorations()).toHaveLength(1)
    expect(harness.activeId()).toBeNull()
  })

  it('validates against the save-time excerpt, not the created one', () => {
    // The reviewer edited inside the range before the draft was written:
    // createdExcerpt is stale but expectedExcerpt matches the doc — the
    // record must restore anchored, not orphaned.
    const harness = restore(makeSeed({ createdExcerpt: 'quickly' }))
    expect(harness.record('s1').orphaned).toBe(false)
  })

  it('orphans a seed whose excerpt no longer matches the doc', () => {
    const harness = restore(makeSeed({ expectedExcerpt: 'brown' }))

    const record = harness.record('s1')
    expect(record.orphaned).toBe(true)
    expect(record.createdExcerpt).toBe('quick')
    expect(record.comment).toBe('why quick?')
    expect(harness.decorations()).toEqual([])
  })

  it.each<[string, DeepReadonly<Partial<AnnotationSeed>>]>([
    ['end past the doc', { to: 999 }],
    ['negative start', { from: -3 }],
    ['empty range', { to: QUICK_FROM, expectedExcerpt: '' }],
    ['inverted range', { from: QUICK_TO, to: QUICK_FROM }],
  ])(
    'orphans a seed with an invalid range (%s) without throwing',
    (_label, bad) => {
      const harness = restore(makeSeed(bad))
      expect(harness.record('s1').orphaned).toBe(true)
      expect(harness.decorations()).toEqual([])
    },
  )

  it('passes an already-orphaned seed through undecorated', () => {
    const harness = restore(
      makeSeed({ from: 0, to: 0, orphaned: true, expectedExcerpt: '' }),
    )

    const record = harness.record('s1')
    expect(record.orphaned).toBe(true)
    // The whole point of keeping orphans: the hook output can still quote it.
    expect(record.createdExcerpt).toBe('quick')
    expect(harness.decorations()).toEqual([])
  })

  it('restores each seed independently when one of them is stale', () => {
    const harness = restore(
      makeSeed(),
      makeSeed({ id: 's2', expectedExcerpt: 'stale' }),
    )
    expect(harness.record('s1').orphaned).toBe(false)
    expect(harness.record('s2').orphaned).toBe(true)
    expect(harness.decorations()).toHaveLength(1)
  })

  it('remaps restored records through later edits like live ones', () => {
    const harness = restore(makeSeed())

    harness.insertText('Note: ', 1)

    const record = harness.record('s1')
    expect(boundsOf(record)).toEqual([QUICK_FROM + 6, QUICK_TO + 6])
    expect(harness.textOf(record.from, record.to)).toBe('quick')
  })

  it('starts empty when no seeds are configured', () => {
    expect(makeHarness().records()).toEqual([])
    expect(makeHarness({ initialAnnotations: [] }).records()).toEqual([])
  })
})
