import { describe, expect, it } from 'vitest'

import {
  colorSchemeFor,
  nextTheme,
  parseTheme,
  THEME_LABELS,
  type ThemePreference,
} from '../src/ui/theme'

const ALL: readonly ThemePreference[] = ['system', 'light', 'dark']

describe('theme preference', () => {
  it('cycles System → Light → Dark and back', () => {
    // Three states on purpose: a plain Light/Dark switch would drop the
    // follow-the-OS behaviour the first time it was pressed, with no way back.
    expect(nextTheme('system')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('system')
  })

  it('returns to the starting state after one full cycle', () => {
    let preference: ThemePreference = 'system'
    for (const _ of ALL) preference = nextTheme(preference)
    expect(preference).toBe('system')
  })

  it('maps System to the two-value color-scheme light-dark() needs', () => {
    // Load-bearing: `light dark` is what lets every light-dark() in style.css
    // resolve from the OS. A single value here would pin the whole page.
    expect(colorSchemeFor('system')).toBe('light dark')
    expect(colorSchemeFor('light')).toBe('light')
    expect(colorSchemeFor('dark')).toBe('dark')
  })

  it('falls back to System for anything it did not write', () => {
    // Storage is shared with whatever else runs on localhost, and a future
    // version may store a value this one has never heard of.
    expect(parseTheme(null)).toBe('system')
    expect(parseTheme('')).toBe('system')
    expect(parseTheme('sepia')).toBe('system')
    expect(parseTheme('Dark')).toBe('system')
  })

  it('round-trips every value it can store', () => {
    for (const preference of ALL)
      expect(parseTheme(preference)).toBe(preference)
  })

  it('labels every state', () => {
    for (const preference of ALL) expect(THEME_LABELS[preference]).not.toBe('')
  })
})
