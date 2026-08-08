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

  it('shrinks to fit a viewport narrower than the popover instead of overflowing it', () => {
    // Moving the box cannot rescue this case: the dialog is position:fixed and
    // its actions row is right-aligned, so a fixed 320 would leave Save and
    // Cancel off-screen with no scrolling that reaches them.
    const style = popoverStyle(
      { left: 40, bottom: 100 },
      { width: 300, height: 900 },
    )
    expect(style).toEqual({ left: 8, top: 108, width: 284 })
    expect(Number(style.left) + Number(style.width)).toBeLessThanOrEqual(
      300 - 8,
    )
  })

  it('keeps the full width whenever the viewport has room for it', () => {
    for (const width of [1440, 400, 336])
      expect(
        popoverStyle({ left: 0, bottom: 0 }, { width, height: 900 }).width,
      ).toBe(320)
  })

  it('never reports a negative width, however absurd the viewport', () => {
    const style = popoverStyle({ left: 0, bottom: 0 }, { width: 4, height: 4 })
    expect(Number(style.width)).toBeGreaterThanOrEqual(0)
  })
})
