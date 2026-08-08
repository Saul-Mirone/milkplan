import { Decoration } from '@milkdown/kit/prose/view'
import { describe, expect, it } from 'vitest'

import {
  annotate,
  makeHarness,
  INTRO_FROM,
  INTRO_TO,
  QUICK_FROM,
  QUICK_TO,
} from './helpers/annotation-harness'

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('annotation plugin — actions', () => {
  it('clears the pending flag on commit and leaves other records alone', () => {
    const harness = makeHarness()
    annotate(harness, 'a1', INTRO_FROM, INTRO_TO, 'about the intro')
    harness.dispatch({
      type: 'begin',
      id: 'a2',
      from: QUICK_FROM,
      to: QUICK_TO,
      createdExcerpt: 'quick',
    })

    expect(harness.record('a2').pending).toBe(true)
    harness.dispatch({ type: 'commit', id: 'a2', comment: 'why quick?' })

    expect(harness.record('a2').pending).toBe(false)
    expect(harness.record('a2').comment).toBe('why quick?')
    expect(harness.record('a1').comment).toBe('about the intro')
  })

  it('removes only the named record and clears activeId when it was the active one', () => {
    const harness = makeHarness()
    annotate(harness, 'a1', INTRO_FROM, INTRO_TO, 'about the intro')
    // `begin` makes its own record active, so a2 is the active one here.
    annotate(harness, 'a2', QUICK_FROM, QUICK_TO, 'why quick?')

    harness.dispatch({ type: 'remove', id: 'a1' })
    expect(harness.records().map((record) => record.id)).toEqual(['a2'])

    harness.dispatch({ type: 'remove', id: 'a2' })
    expect(harness.records()).toEqual([])
  })

  it('remaps a pending record while its comment popover is still open', () => {
    // The popover anchors to the live `from`; without remapping, saving a
    // comment after typing elsewhere would attach it to stale positions.
    const harness = makeHarness()
    harness.dispatch({
      type: 'begin',
      id: 'a1',
      from: QUICK_FROM,
      to: QUICK_TO,
      createdExcerpt: 'quick',
    })

    harness.insertText('Note: ', 1)

    const pending = harness.record('a1')
    expect(pending.pending).toBe(true)
    expect(harness.textOf(pending.from, pending.to)).toBe('quick')
  })

  it('returns the previous state by reference for a transaction that changes nothing', () => {
    // useSyncExternalStore bails out on Object.is; a fresh object here would
    // notify React on every cursor move and re-render the whole review UI.
    const harness = makeHarness()
    annotate(harness, 'a1', QUICK_FROM, QUICK_TO, 'why quick?')
    const before = harness.pluginStateRef()

    harness.touch()

    expect(harness.pluginStateRef()).toBe(before)
  })
})

describe('annotation plugin — decorations', () => {
  it('decorates every live annotation with its id and the active/pending classes', () => {
    const harness = makeHarness()
    annotate(harness, 'a1', INTRO_FROM, INTRO_TO, 'about the intro')
    // `begin` without `commit`: still active and still pending.
    harness.dispatch({
      type: 'begin',
      id: 'a2',
      from: QUICK_FROM,
      to: QUICK_TO,
      createdExcerpt: 'quick',
    })

    // Comparing whole Decoration objects covers the attrs as well as the
    // range, so this pins the exact class strings the stylesheet targets and
    // the id attribute handleClickOn reads back — without reaching into
    // fields the published types do not expose.
    expect(harness.decorations()).toEqual([
      Decoration.inline(INTRO_FROM, INTRO_TO, {
        class: 'mp-annotation',
        'data-annotation-id': 'a1',
      }),
      Decoration.inline(QUICK_FROM, QUICK_TO, {
        class: 'mp-annotation mp-annotation--active mp-annotation--pending',
        'data-annotation-id': 'a2',
      }),
    ])
  })

  it('drops the active class when the selection moves to another annotation', () => {
    const harness = makeHarness()
    annotate(harness, 'a1', INTRO_FROM, INTRO_TO, 'about the intro')
    annotate(harness, 'a2', QUICK_FROM, QUICK_TO, 'why quick?')

    harness.dispatch({ type: 'setActive', id: 'a1' })

    expect(harness.decorations()).toEqual([
      Decoration.inline(INTRO_FROM, INTRO_TO, {
        class: 'mp-annotation mp-annotation--active',
        'data-annotation-id': 'a1',
      }),
      Decoration.inline(QUICK_FROM, QUICK_TO, {
        class: 'mp-annotation',
        'data-annotation-id': 'a2',
      }),
    ])
  })
})
