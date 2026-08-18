import { render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AnnotationRecord,
  AnnotationState,
} from '../../src/ui/annotations/plugin'
import { DecorationSet } from '@milkdown/kit/prose/view'
import {
  hashPlan,
  readDraft,
  writeDraft,
  DRAFT_TTL_MS,
  type DraftAnnotation,
} from '../../src/ui/draft'
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../../src/ui/hooks/useAnnotations'
import {
  useDraftPersistence,
  useInitialDraft,
} from '../../src/ui/hooks/useReviewDraft'
import type { DeepReadonly } from '../../src/shared/readonly'
import { makeDocSource } from '../helpers/annotation-harness'
import { makeDraft } from '../helpers/draft-fixtures'

const SESSION = 'session-1'
const PLAN = '# Plan'

// A stable doc source over the harness document; "Intro" occupies [1, 6).
const VIEW = makeDocSource()
const EDITOR = {
  getMarkdown: () => '# Plan\n\nEdited.',
  getBaseline: () => '# Plan\n',
}
const getEditor = () => EDITOR
const getView = () => VIEW

function makeRecord(
  overrides: DeepReadonly<Partial<AnnotationRecord>> = {},
): AnnotationRecord {
  return {
    id: 'a1',
    from: 1,
    to: 6,
    comment: 'why this?',
    createdExcerpt: 'Intro',
    orphaned: false,
    pending: false,
    ...overrides,
  }
}

function stateWith(
  ...records: readonly DeepReadonly<AnnotationRecord>[]
): AnnotationState {
  return {
    annotations: [...records],
    decorations: DecorationSet.empty,
    activeId: null,
  }
}

interface ProbeProps {
  readonly store: DeepReadonly<AnnotationStore>
  readonly overallFeedback: string
  readonly onReady: (clearDraft: () => void) => void
}

function Probe({ store, overallFeedback, onReady }: ProbeProps) {
  const { clearDraft } = useDraftPersistence({
    sessionId: SESSION,
    plan: PLAN,
    store,
    getEditor,
    getView,
    overallFeedback,
  })
  onReady(clearDraft)
  return null
}

function renderProbe(store: DeepReadonly<AnnotationStore>) {
  let clear: () => void = () => {}
  const utils = render(
    <Probe
      store={store}
      overallFeedback=""
      onReady={(clearDraft) => {
        clear = clearDraft
      }}
    />,
  )
  const rerenderWithFeedback = (overallFeedback: string) => {
    utils.rerender(
      <Probe
        store={store}
        overallFeedback={overallFeedback}
        onReady={(clearDraft) => {
          clear = clearDraft
        }}
      />,
    )
  }
  return {
    clearDraft: () => {
      clear()
    },
    rerenderWithFeedback,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('useDraftPersistence', () => {
  it('writes a debounced draft when the annotation snapshot changes', () => {
    const store = createAnnotationStore()
    renderProbe(store)

    store.onChange(stateWith(makeRecord()))
    expect(readDraft(SESSION, PLAN)).toBeNull()
    vi.advanceTimersByTime(400)

    const draft = readDraft(SESSION, PLAN)
    expect(draft).not.toBeNull()
    expect(draft?.markdown).toBe('# Plan\n\nEdited.')
    expect(draft?.baseline).toBe('# Plan\n')
    expect(draft?.planHash).toBe(hashPlan(PLAN))
    // savedExcerpt is the LIVE doc text, captured at save time.
    expect(draft?.annotations).toEqual([
      {
        id: 'a1',
        from: 1,
        to: 6,
        comment: 'why this?',
        createdExcerpt: 'Intro',
        orphaned: false,
        savedExcerpt: 'Intro',
      },
    ])
  })

  it('drops pending records from the draft', () => {
    const store = createAnnotationStore()
    renderProbe(store)

    store.onChange(
      stateWith(makeRecord(), makeRecord({ id: 'a2', pending: true })),
    )
    vi.advanceTimersByTime(400)

    const ids = readDraft(SESSION, PLAN)?.annotations.map(
      (annotation: DeepReadonly<DraftAnnotation>) => annotation.id,
    )
    expect(ids).toEqual(['a1'])
  })

  it('ignores notifications that keep the same snapshot reference', () => {
    // The plugin notifies on cursor-only transactions too; those reuse the
    // state object, and must not schedule a write.
    const store = createAnnotationStore()
    renderProbe(store)
    const state = stateWith(makeRecord())
    store.onChange(state)
    vi.advanceTimersByTime(400)
    localStorage.clear()

    store.onChange(state)
    vi.advanceTimersByTime(1000)

    expect(readDraft(SESSION, PLAN)).toBeNull()
  })

  it('does not write on mount, only after a feedback change', () => {
    const store = createAnnotationStore()
    const probe = renderProbe(store)
    vi.advanceTimersByTime(1000)
    expect(readDraft(SESSION, PLAN)).toBeNull()

    probe.rerenderWithFeedback('needs a rollback section')
    vi.advanceTimersByTime(400)

    expect(readDraft(SESSION, PLAN)?.overallFeedback).toBe(
      'needs a rollback section',
    )
  })

  it('clearDraft removes the key and cancels the in-flight write', () => {
    const store = createAnnotationStore()
    const probe = renderProbe(store)
    store.onChange(stateWith(makeRecord()))

    probe.clearDraft()
    vi.advanceTimersByTime(1000)

    // Neither the queued flush nor later changes may resurrect the draft.
    store.onChange(stateWith(makeRecord({ id: 'a3' })))
    vi.advanceTimersByTime(1000)
    expect(readDraft(SESSION, PLAN)).toBeNull()
  })

  it('flushes immediately on pagehide, inside the debounce window', () => {
    const store = createAnnotationStore()
    renderProbe(store)
    store.onChange(stateWith(makeRecord()))
    expect(readDraft(SESSION, PLAN)).toBeNull()

    window.dispatchEvent(new Event('pagehide'))

    expect(readDraft(SESSION, PLAN)).not.toBeNull()
  })
})

describe('useInitialDraft', () => {
  it('restores the stored draft and maps annotations to plugin seeds', () => {
    // Pin the clock near the fixture's savedAt so pruning leaves it alone.
    vi.setSystemTime(1_700_000_000_000 + 1000)
    writeDraft(SESSION, makeDraft())

    const { result } = renderHook(() => useInitialDraft(SESSION, PLAN))

    expect(result.current.draft).toEqual(makeDraft())
    expect(result.current.seeds).toEqual([
      {
        id: 'a1',
        from: 17,
        to: 22,
        comment: 'why quick?',
        createdExcerpt: 'quick',
        orphaned: false,
        expectedExcerpt: 'quick',
      },
    ])
  })

  it('returns no draft for a different plan and prunes expired ones', () => {
    vi.setSystemTime(1_700_000_000_000)
    writeDraft(
      'expired',
      makeDraft({ savedAt: 1_700_000_000_000 - DRAFT_TTL_MS - 1 }),
    )
    writeDraft(SESSION, makeDraft({ planHash: hashPlan('another plan') }))

    const { result } = renderHook(() => useInitialDraft(SESSION, PLAN))

    expect(result.current.draft).toBeNull()
    expect(result.current.seeds).toBeUndefined()
    expect(localStorage.getItem('milkplan:draft:expired')).toBeNull()
  })
})
