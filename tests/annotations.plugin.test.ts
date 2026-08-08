import { describe, expect, it } from 'vitest'

import {
  annotate,
  boundsOf,
  makeHarness,
  INTRO_FROM,
  INTRO_TO,
  QUICK_FROM,
  QUICK_TO,
} from './helpers/annotation-harness'

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('annotation plugin — position mapping', () => {
  it('keeps an anchor on its original words when text is inserted above it', () => {
    const harness = makeHarness()
    annotate(harness, 'a1', QUICK_FROM, QUICK_TO, 'why quick?')

    harness.insertText('Note: ', 1)

    const record = harness.record('a1')
    expect(boundsOf(record)).toEqual([QUICK_FROM + 6, QUICK_TO + 6])
    expect(harness.textOf(record.from, record.to)).toBe('quick')
    expect(record.comment).toBe('why quick?')
    expect(record.orphaned).toBe(false)
  })

  it('orphans an annotation whose anchor text was deleted, keeping the original excerpt for the hook output', () => {
    const harness = makeHarness()
    annotate(harness, 'a1', QUICK_FROM, QUICK_TO, 'why quick?')

    harness.deleteRange(QUICK_FROM, QUICK_TO)

    const record = harness.record('a1')
    expect(record.orphaned).toBe(true)
    expect(record.from).toBe(record.to)
    // The record survives deletion precisely so feedback.ts can still quote it.
    expect(record.createdExcerpt).toBe('quick')
    expect(record.comment).toBe('why quick?')
    expect(harness.decorations()).toEqual([])
  })

  it('orphans an annotation swallowed by a larger deletion spanning both paragraphs', () => {
    const harness = makeHarness()
    annotate(harness, 'a1', QUICK_FROM, QUICK_TO, 'why quick?')

    // From inside "Intro line" to inside "brown": crosses the block boundary
    // and takes the whole anchor with it.
    harness.deleteRange(6, 24)

    expect(harness.record('a1').orphaned).toBe(true)
  })

  it('shrinks rather than orphans when only part of the anchor is deleted', () => {
    const harness = makeHarness()
    annotate(harness, 'a1', QUICK_FROM, QUICK_TO, 'why quick?')

    // Deletes "qu".
    harness.deleteRange(QUICK_FROM, QUICK_FROM + 2)

    const record = harness.record('a1')
    expect(record.orphaned).toBe(false)
    expect(harness.textOf(record.from, record.to)).toBe('ick')
  })

  it('never swallows text typed at either boundary of the anchor', () => {
    // Pins the bias arguments in remapThrough: map(from, 1) pushes the start
    // past an insertion sitting exactly on it, map(to, -1) holds the end back.
    // Flip either and the annotation silently grows to cover text the user
    // never selected — which then ships to Claude as the quoted excerpt.
    const atStart = makeHarness()
    annotate(atStart, 'a1', QUICK_FROM, QUICK_TO, 'why quick?')
    atStart.insertText('X', QUICK_FROM)
    const started = atStart.record('a1')
    expect(atStart.textOf(started.from, started.to)).toBe('quick')

    const atEnd = makeHarness()
    annotate(atEnd, 'a1', QUICK_FROM, QUICK_TO, 'why quick?')
    atEnd.insertText('X', QUICK_TO)
    const ended = atEnd.record('a1')
    expect(atEnd.textOf(ended.from, ended.to)).toBe('quick')
  })

  it('freezes an orphaned record so later edits can never revive or move it', () => {
    const harness = makeHarness()
    annotate(harness, 'a1', QUICK_FROM, QUICK_TO, 'why quick?')
    harness.deleteRange(QUICK_FROM, QUICK_TO)
    const orphaned = harness.record('a1')

    harness.insertText('Note: ', 1)

    // useAnnotations.excerptFor reads createdExcerpt for orphans and the live
    // doc otherwise; a remapped orphan would point at unrelated text.
    expect(boundsOf(harness.record('a1'))).toEqual(boundsOf(orphaned))
    expect(harness.record('a1').orphaned).toBe(true)
  })

  it('remaps several annotations independently through one transaction', () => {
    const harness = makeHarness()
    annotate(harness, 'a1', INTRO_FROM, INTRO_TO, 'about the intro')
    annotate(harness, 'a2', QUICK_FROM, QUICK_TO, 'why quick?')

    // Inside "Intro", which is above "quick".
    harness.insertText('X', 3)

    expect(harness.textOf(...boundsOf(harness.record('a1')))).toBe('InXtro')
    expect(harness.textOf(...boundsOf(harness.record('a2')))).toBe('quick')
  })
})
