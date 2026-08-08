import { DecorationSet } from '@milkdown/kit/prose/view'
import { describe, expect, it } from 'vitest'

import { emptyAnnotationState } from '../src/ui/annotations/plugin'
import type { AnnotationState } from '../src/ui/annotations/plugin'
import { createAnnotationStore } from '../src/ui/hooks/useAnnotations'
import type { DeepReadonly } from '../src/shared/readonly'

function stateWith(id: string): AnnotationState {
  return {
    annotations: [
      {
        id,
        from: 1,
        to: 6,
        comment: 'why?',
        createdExcerpt: 'Intro',
        orphaned: false,
        pending: false,
      },
    ],
    decorations: DecorationSet.empty,
    activeId: id,
  }
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('createAnnotationStore', () => {
  it('starts on the shared empty state so the first render has no annotations', () => {
    expect(createAnnotationStore().getSnapshot()).toBe(emptyAnnotationState)
  })

  it('hands back the pushed state by reference, which is what stops useSyncExternalStore re-rendering forever', () => {
    // useSyncExternalStore compares snapshots with Object.is. Cloning or
    // re-wrapping the plugin state here would make every getSnapshot look like
    // a change and spin React until the tab locks up.
    const store = createAnnotationStore()
    const pushed = stateWith('a1')

    store.onChange(pushed)

    expect(store.getSnapshot()).toBe(pushed)
    expect(store.getSnapshot()).toBe(store.getSnapshot())
  })

  it('notifies every subscriber on change and stops after unsubscribe', () => {
    const store = createAnnotationStore()
    const seen: string[] = []
    const unsubscribeFirst = store.subscribe(() => {
      seen.push('first')
    })
    store.subscribe(() => {
      seen.push('second')
    })

    store.onChange(stateWith('a1'))
    expect(seen).toEqual(['first', 'second'])

    unsubscribeFirst()
    store.onChange(stateWith('a2'))
    expect(seen).toEqual(['first', 'second', 'second'])
  })

  it('keeps serving the latest snapshot to a subscriber that joins later', () => {
    const store = createAnnotationStore()
    const pushed = stateWith('a1')
    store.onChange(pushed)

    let observed: DeepReadonly<AnnotationState> | null = null
    store.subscribe(() => {
      observed = store.getSnapshot()
    })
    expect(store.getSnapshot()).toBe(pushed)

    const next = stateWith('a2')
    store.onChange(next)
    expect(observed).toBe(next)
  })
})
