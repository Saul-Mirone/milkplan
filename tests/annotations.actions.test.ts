import { describe, expect, it } from 'vitest'

import { beginActionFor, excerptOf } from '../src/ui/hooks/useAnnotations'
import type { AnnotationRecord } from '../src/ui/annotations/plugin'
import type { DeepReadonly } from '../src/shared/readonly'
import {
  makeDocSource,
  INTRO_FROM,
  INTRO_TO,
  QUICK_FROM,
  QUICK_TO,
} from './helpers/annotation-harness'

function record(
  overrides: DeepReadonly<Partial<AnnotationRecord>> = {},
): AnnotationRecord {
  return {
    id: 'a1',
    from: QUICK_FROM,
    to: QUICK_TO,
    comment: 'why quick?',
    createdExcerpt: 'quick',
    orphaned: false,
    pending: false,
    ...overrides,
  }
}

describe('beginActionFor', () => {
  it('captures the selected text as the excerpt the annotation falls back to', () => {
    expect(beginActionFor(makeDocSource(), QUICK_FROM, QUICK_TO, 'a1')).toEqual(
      {
        type: 'begin',
        id: 'a1',
        from: QUICK_FROM,
        to: QUICK_TO,
        createdExcerpt: 'quick',
      },
    )
  })

  it('refuses every range that cannot carry an annotation', () => {
    // An empty or inverted selection would create a record that is orphaned
    // the instant it exists; an out-of-range end is what a toolbar click
    // racing an edit that shortened the document produces, and reading it
    // would throw inside the reducer.
    const source = makeDocSource()
    const size = source.state.doc.content.size
    for (const [from, to, why] of [
      [5, 5, 'empty selection'],
      [9, 4, 'inverted selection'],
      [1, size + 1, 'past the end of the document'],
    ] as const)
      expect({ why, action: beginActionFor(source, from, to, 'a1') }).toEqual({
        why,
        action: null,
      })
  })

  it('refuses when no editor is mounted', () => {
    expect(beginActionFor(null, INTRO_FROM, INTRO_TO, 'a1')).toBeNull()
  })
})

describe('excerptOf', () => {
  it('reads the live document so the excerpt reflects edits made after annotating', () => {
    // The sidebar and the hook output both quote this. A stale excerpt would
    // send Claude text that is no longer in the plan.
    const source = makeDocSource()
    expect(excerptOf(source, record({ from: 13, to: QUICK_TO }))).toBe(
      'The quick',
    )
  })

  it('quotes the captured text for an orphan, without touching the document at all', () => {
    // Proving it never reads the doc matters: an orphan's positions collapse
    // to a point that now sits in unrelated text.
    const source = makeDocSource()
    const orphan = record({
      orphaned: true,
      from: INTRO_FROM,
      to: INTRO_TO,
      createdExcerpt: 'a passage that was deleted',
    })
    const excerpt = excerptOf(source, orphan)
    expect(excerpt).toBe('a passage that was deleted')
    expect(excerpt).not.toBe('Intro')
  })

  it('falls back to the captured text when the range no longer fits the document', () => {
    // Plugin-remapped positions are valid by construction, so this only
    // matters across an editor rebuild — but throwing here would take down the
    // whole sidebar render.
    const source = makeDocSource()
    expect(
      excerptOf(source, record({ from: 5, to: 9999, createdExcerpt: 'quick' })),
    ).toBe('quick')
  })

  it('falls back to the captured text when no editor is mounted', () => {
    expect(excerptOf(null, record())).toBe('quick')
  })
})
