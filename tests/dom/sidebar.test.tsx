import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Sidebar } from '../../src/ui/components/Sidebar'
import type { AnnotationRecord } from '../../src/ui/annotations/plugin'
import type { DeepReadonly } from '../../src/shared/readonly'

function record(
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

interface Handlers {
  selected: DeepReadonly<AnnotationRecord>[]
  deleted: string[]
  feedback: string[]
}

function renderSidebar(
  annotations: readonly DeepReadonly<AnnotationRecord>[],
  activeId: string | null = null,
): Handlers {
  const handlers: Handlers = { selected: [], deleted: [], feedback: [] }
  render(
    <Sidebar
      annotations={annotations}
      activeId={activeId}
      excerptFor={(candidate) => `live:${candidate.createdExcerpt}`}
      onSelect={(candidate) => {
        handlers.selected.push(candidate)
      }}
      onDelete={(id) => {
        handlers.deleted.push(id)
      }}
      overallFeedback=""
      onOverallFeedbackChange={(value) => {
        handlers.feedback.push(value)
      }}
    />,
  )
  return handlers
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('Sidebar', () => {
  it('explains how to make an annotation when there are none yet', () => {
    renderSidebar([])
    expect(screen.getByText(/select text in the plan/iu)).toBeDefined()
  })

  it('shows the live excerpt rather than the text captured at creation', () => {
    // excerptFor is what keeps the sidebar in step with the document; showing
    // createdExcerpt would leave stale quotes on screen after every edit.
    renderSidebar([record()])
    expect(screen.getByText('live:Intro')).toBeDefined()
    expect(screen.getByText('why this?')).toBeDefined()
  })

  it('marks an orphaned annotation so the user can see its anchor is gone', () => {
    renderSidebar([record({ orphaned: true })])
    expect(screen.getByText('orphaned')).toBeDefined()
  })

  it('counts the annotations that will be sent', () => {
    renderSidebar([record({ id: 'a1' }), record({ id: 'a2' })])
    expect(screen.getByText('2')).toBeDefined()
  })

  it('selects a card by click and by keyboard, so it is not mouse-only', () => {
    // The card cannot be a <button> (it contains a Delete button), so the
    // role/tabIndex/onKeyDown trio is the only thing making it operable.
    const handlers = renderSidebar([record()])
    const card = screen.getByRole('button', { name: /why this\?/u })

    fireEvent.click(card)
    fireEvent.keyDown(card, { key: 'Enter' })
    fireEvent.keyDown(card, { key: ' ' })
    fireEvent.keyDown(card, { key: 'a' })

    expect(
      handlers.selected.map(
        (entry: DeepReadonly<AnnotationRecord>) => entry.id,
      ),
    ).toEqual(['a1', 'a1', 'a1'])
  })

  it('deletes without also selecting, because Delete sits inside the card', () => {
    // Without stopPropagation the click bubbles to the card and selects an
    // annotation that is being removed in the same tick.
    const handlers = renderSidebar([record()])

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(handlers.deleted).toEqual(['a1'])
    expect(handlers.selected).toEqual([])
  })

  it('reports overall feedback as the user types it', () => {
    const handlers = renderSidebar([])
    const textarea = screen.getByPlaceholderText(/notes that apply/iu)

    fireEvent.change(textarea, { target: { value: 'needs work' } })

    expect(handlers.feedback).toEqual(['needs work'])
  })
})
