import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  CommentPopover,
  type CoordsSource,
} from '../../src/ui/components/CommentPopover'
import type { DeepReadonly } from '../../src/shared/readonly'

interface Calls {
  saved: string[]
  cancelled: number
}

const coords: CoordsSource = {
  coordsAtPos: () => ({ left: 120, bottom: 240 }),
}

function renderPopover(
  view: DeepReadonly<CoordsSource> | null = coords,
): Calls {
  const calls: Calls = { saved: [], cancelled: 0 }
  render(
    <CommentPopover
      getView={() => view}
      from={17}
      onSave={(comment) => {
        calls.saved.push(comment)
      }}
      onCancel={() => {
        calls.cancelled += 1
      }}
    />,
  )
  return calls
}

function textarea(): HTMLElement {
  return screen.getByPlaceholderText(/comment on the selected text/iu)
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('CommentPopover', () => {
  it('renders nothing when there is no editor to anchor to', () => {
    renderPopover(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('positions itself from the anchor coordinates', () => {
    renderPopover()
    const dialog = screen.getByLabelText('Add annotation')
    expect(dialog.getAttribute('style')).toContain('left: 120px')
    expect(dialog.getAttribute('style')).toContain('top: 248px')
  })

  it('focuses the textarea so the user can just start typing', () => {
    // The popover opens from a toolbar click; without this the first
    // keystrokes would land in the editor and edit the plan instead.
    renderPopover()
    expect(document.activeElement).toBe(textarea())
  })

  it('keeps Save disabled until the comment has content', () => {
    // An empty comment would serialize as an annotation with no note — noise
    // in the hook output that Claude cannot act on.
    renderPopover()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.hasAttribute('disabled')).toBe(true)

    fireEvent.change(textarea(), { target: { value: '   ' } })
    expect(save.hasAttribute('disabled')).toBe(true)

    fireEvent.change(textarea(), { target: { value: 'split this' } })
    expect(save.hasAttribute('disabled')).toBe(false)
  })

  it('saves the trimmed comment on click', () => {
    const calls = renderPopover()
    fireEvent.change(textarea(), { target: { value: '  split this  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.saved).toEqual(['split this'])
  })

  it('saves on Cmd+Enter and on Ctrl+Enter, but not on Enter alone', () => {
    // Enter alone has to insert a newline: comments are frequently multi-line.
    const calls = renderPopover()
    fireEvent.change(textarea(), { target: { value: 'split this' } })

    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(calls.saved).toEqual([])

    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true })
    fireEvent.keyDown(textarea(), { key: 'Enter', ctrlKey: true })
    expect(calls.saved).toEqual(['split this', 'split this'])
  })

  it('ignores Cmd+Enter while the comment is still empty', () => {
    const calls = renderPopover()
    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true })
    expect(calls.saved).toEqual([])
  })

  it('cancels on Escape and on the Cancel button', () => {
    // Cancel removes the pending record; leaving it behind would decorate the
    // document with an annotation carrying no comment.
    const calls = renderPopover()
    fireEvent.keyDown(textarea(), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(calls.cancelled).toBe(2)
  })
})
