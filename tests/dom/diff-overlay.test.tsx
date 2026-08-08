import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Change } from '@milkdown/kit/prose/changeset'
import {
  derivePaneStatus,
  type DiffStateSlice,
} from '../../src/ui/components/DiffEditorPane'
import { DiffOverlayView } from '../../src/ui/components/DiffOverlay'
import { versionLabel } from '../../src/ui/history'
import type { PlanVersion } from '../../src/shared/protocol'
import type { DeepReadonly } from '../../src/shared/readonly'

/**
 * Only the shell is rendered here, with a stub pane as children — the real
 * DiffEditorPane builds a Crepe instance, which does not enter happy-dom
 * (see app.test.tsx). The pane's pure status derivation is covered below;
 * the rendered diff itself is verified manually via `pnpm dev`.
 */
const versions: readonly DeepReadonly<PlanVersion>[] = [
  {
    ts: 1_700_000_000_000,
    round: 1,
    planPath: '/Users/dev/.claude/plans/sunny-rolling-otter.md',
    markdown: '# Round one',
  },
  {
    ts: 1_700_000_060_000,
    round: 2,
    planPath: '/Users/dev/.claude/plans/sunny-rolling-otter.md',
    markdown: '# Round two',
  },
]

interface Calls {
  selected: number[]
  closed: number
}

/** Non-null lookup for overlay parts that carry no ARIA role of their own. */
function overlayPart(className: string): Element {
  const part = screen.getByRole('dialog').querySelector(`.${className}`)
  if (part === null) throw new Error(`missing .${className}`)
  return part
}

function renderOverlay(selectedIndex = 1): Calls {
  const calls: Calls = { selected: [], closed: 0 }
  render(
    <DiffOverlayView
      versions={versions}
      selectedIndex={selectedIndex}
      onSelect={(index) => {
        calls.selected.push(index)
      }}
      onClose={() => {
        calls.closed += 1
      }}
    >
      <div data-testid="pane" />
    </DiffOverlayView>,
  )
  return calls
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('DiffOverlayView', () => {
  it('is a modal dialog, labelled for screen readers', () => {
    renderOverlay()
    const dialog = screen.getByRole('dialog', { name: 'Plan changes' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('renders the stub pane it was handed as children', () => {
    renderOverlay()
    expect(screen.getByTestId('pane')).toBeDefined()
  })

  it('offers one option per version, labelled by versionLabel', () => {
    renderOverlay()
    const options = screen.getAllByRole('option')
    expect(
      options.map(
        (option: { readonly textContent: string | null }) => option.textContent,
      ),
    ).toEqual(versions.map((version) => versionLabel(version)))
  })

  it('reflects the selected index in the picker', () => {
    renderOverlay(0)
    const select = screen.getByRole<HTMLSelectElement>('combobox')
    expect(select.value).toBe('0')
  })

  it('reports a picked version by its index', () => {
    const calls = renderOverlay()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '0' } })
    expect(calls.selected).toEqual([0])
  })

  it('ignores a change that maps to no version', () => {
    // Setting a <select> to a value with no matching option yields '' — and
    // Number('') is 0, which would silently pick the first round.
    const calls = renderOverlay()
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'bogus' },
    })
    expect(calls.selected).toEqual([])
  })

  it('closes on Escape from inside the dialog', () => {
    const calls = renderOverlay()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(calls.closed).toBe(1)
  })

  it('closes on Escape even when focus has left the dialog', () => {
    // Clicking the read-only diff text drops focus onto the body — Escape
    // must still close, which is why the listener sits on the document.
    const calls = renderOverlay()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(calls.closed).toBe(1)
  })

  it('closes on a backdrop click but not on a click inside the panel', () => {
    const calls = renderOverlay()

    fireEvent.click(overlayPart('mp-diff-overlay__backdrop'))
    expect(calls.closed).toBe(1)

    fireEvent.click(overlayPart('mp-diff-overlay__panel'))
    expect(calls.closed).toBe(1)
  })

  it('closes from the Close button', () => {
    const calls = renderOverlay()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(calls.closed).toBe(1)
  })

  it('focuses Close on mount so Escape and Enter work immediately', () => {
    renderOverlay()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close' }),
    )
  })
})

describe('derivePaneStatus', () => {
  // fromJSON because the Change constructor is internal to prosemirror-changeset.
  const change = Change.fromJSON({
    fromA: 0,
    toA: 0,
    fromB: 0,
    toB: 5,
    deleted: [],
    inserted: [{ length: 5, data: null }],
  })
  function activeState(
    rejectedRanges: DeepReadonly<{ fromB: number; toB: number }[]> = [],
  ): DiffStateSlice {
    return { changes: [change], rejectedRanges: [...rejectedRanges] }
  }

  it('treats a failed start as an error, never as no-changes', () => {
    // started=false means the current markdown failed to parse — reporting
    // "no changes" would be the opposite of what happened.
    expect(derivePaneStatus(false, activeState())).toBe('error')
  })

  it('reports no-changes when the plugin holds no state', () => {
    expect(derivePaneStatus(true, null)).toBe('no-changes')
    expect(derivePaneStatus(true, undefined)).toBe('no-changes')
  })

  it('reports a diff while changes are pending', () => {
    expect(derivePaneStatus(true, activeState())).toBe('diff')
  })

  it('reports no-changes when every change is rejected', () => {
    // Unreachable through the read-only overlay (controls are hidden), but
    // the predicate must not misread a fully-rejected review as a diff.
    expect(derivePaneStatus(true, activeState([{ fromB: 0, toB: 5 }]))).toBe(
      'no-changes',
    )
  })
})
