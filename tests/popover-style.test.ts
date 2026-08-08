import { describe, expect, it } from 'vitest'

import { popoverStyle } from '../src/ui/components/CommentPopover'

const WIDE = { width: 1440, height: 900 }

describe('popoverStyle', () => {
  it('places the popover just below the selection when there is room', () => {
    expect(popoverStyle({ left: 300, bottom: 220 }, WIDE)).toEqual({
      left: 300,
      top: 228,
      width: 320,
    })
  })

  it('pulls the popover back inside the right edge instead of letting it hang off', () => {
    // Unclamped, an annotation near the right margin opens a box whose Save
    // and Cancel buttons are off-screen — the comment can be typed but never
    // saved, and Escape is the only way out.
    const { left } = popoverStyle({ left: 1400, bottom: 200 }, WIDE)
    expect(left).toBe(1440 - 320 - 8)
    expect(Number(left) + 320).toBeLessThanOrEqual(WIDE.width)
  })

  it('lifts the popover above the fold for an annotation near the bottom of a long plan', () => {
    const { top } = popoverStyle({ left: 100, bottom: 880 }, WIDE)
    expect(top).toBe(900 - 180)
    expect(Number(top)).toBeLessThan(WIDE.height)
  })

  it('keeps the left margin rather than going negative on a viewport narrower than itself', () => {
    // 320 + 16 > 300, so the inner Math.min goes negative here; the outer
    // Math.max is what stops the box being positioned off the left edge.
    expect(
      popoverStyle({ left: 40, bottom: 100 }, { width: 300, height: 900 }),
    ).toEqual({ left: 8, top: 108, width: 320 })
  })

  it('always reports the fixed popover width, so the caller never has to', () => {
    for (const viewport of [WIDE, { width: 320, height: 200 }])
      expect(popoverStyle({ left: 0, bottom: 0 }, viewport).width).toBe(320)
  })
})
