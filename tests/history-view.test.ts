import { describe, expect, it } from 'vitest'

import { versionLabel } from '../src/ui/history'
import type { PlanVersion } from '../src/shared/protocol'

const version: PlanVersion = {
  ts: 1_700_000_000_000,
  round: 3,
  planPath: '/Users/dev/.claude/plans/sunny-rolling-otter.md',
  markdown: '# Plan',
}

describe('versionLabel', () => {
  it('numbers the round from the recorded round field and appends a clock time', () => {
    // Only the structure is asserted: the clock renders in the host's locale
    // and timezone, which neither CI nor dev machines pin.
    expect(versionLabel(version)).toMatch(/^Round 3 · \d{1,2}:\d{2}/u)
  })

  it('keeps the stored number even when the version sits at index 0', () => {
    // After the round cap slices old entries off, indexes restart at 0 while
    // recorded round numbers keep counting — the label must follow the record.
    expect(versionLabel({ ...version, round: 7, planPath: null })).toMatch(
      /^Round 7 · \d{1,2}:\d{2}/u,
    )
  })
})
