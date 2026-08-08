import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ReviewHeader } from '../../src/ui/components/ReviewHeader'
import type { ReviewMeta } from '../../src/shared/protocol'
import type { DeepReadonly } from '../../src/shared/readonly'

const meta: ReviewMeta = {
  planPath: '/Users/dev/.claude/plans/sunny-rolling-otter.md',
  cwd: '/Users/dev/project',
  sessionId: 'test-session',
}

function renderHeader(
  overrides: DeepReadonly<Partial<ReviewMeta>> = {},
  roundNumber: number | null = null,
  onViewChanges: (() => void) | null = null,
) {
  render(
    <ReviewHeader
      meta={{ ...meta, ...overrides }}
      roundNumber={roundNumber}
      onViewChanges={onViewChanges}
    />,
  )
}

describe('ReviewHeader', () => {
  it('shows the plan path and the working directory', () => {
    renderHeader()
    expect(
      screen.getByText('/Users/dev/.claude/plans/sunny-rolling-otter.md'),
    ).toBeDefined()
    expect(screen.getByText('/Users/dev/project')).toBeDefined()
  })

  it('falls back to an explicit inline-plan label when there is no file', () => {
    renderHeader({ planPath: null })
    expect(screen.getByText('inline plan (no file)')).toBeDefined()
  })

  it('hides the round badge and the diff entry on a first round', () => {
    // A single-round session has nothing to diff against; showing a dead
    // button would only invite a click that can do nothing.
    renderHeader({}, null, null)
    expect(screen.queryByText(/^Round/u)).toBeNull()
    expect(screen.queryByRole('button', { name: 'View changes' })).toBeNull()
  })

  it('shows the round number and fires onViewChanges exactly once per click', () => {
    let opened = 0
    renderHeader({}, 3, () => {
      opened += 1
    })

    expect(screen.getByText('Round 3')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'View changes' }))
    expect(opened).toBe(1)
  })
})
