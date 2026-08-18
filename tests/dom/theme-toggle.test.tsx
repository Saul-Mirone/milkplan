import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ThemeToggle } from '../../src/ui/components/ThemeToggle'

const STORAGE_KEY = 'milkplan:theme'

function colorScheme(): string {
  return document.documentElement.style.getPropertyValue('color-scheme')
}

const toggle = () => screen.getByRole('button', { name: /^Theme:/u })

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
})

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
})

describe('ThemeToggle', () => {
  it('starts on System, which is what leaves the page following the OS', () => {
    render(<ThemeToggle />)
    expect(toggle().textContent).toBe('Theme: System')
    // Untouched: the stylesheet's own `color-scheme: light dark` is already
    // the System value, so a fresh page must not need an inline override.
    expect(colorScheme()).toBe('')
  })

  it('walks Light → Dark → System, driving color-scheme on <html>', () => {
    // The single switch the whole page hangs off: the --mp-* palette, the
    // vendored Crepe palette and shiki's code-block tokens are all
    // light-dark(), so this one property re-themes every one of them.
    render(<ThemeToggle />)

    fireEvent.click(toggle())
    expect(toggle().textContent).toBe('Theme: Light')
    expect(colorScheme()).toBe('light')

    fireEvent.click(toggle())
    expect(toggle().textContent).toBe('Theme: Dark')
    expect(colorScheme()).toBe('dark')

    fireEvent.click(toggle())
    expect(toggle().textContent).toBe('Theme: System')
    expect(colorScheme()).toBe('light dark')
  })

  it('remembers the choice across reviews', () => {
    render(<ThemeToggle />)
    fireEvent.click(toggle())
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
  })

  it('picks up a stored choice as its starting state', () => {
    // main.tsx has already applied it before render; the button only has to
    // agree, or the next click would jump to the wrong state.
    localStorage.setItem(STORAGE_KEY, 'dark')
    render(<ThemeToggle />)
    expect(toggle().textContent).toBe('Theme: Dark')
  })

  it('says what the next press does, since the label only shows the current state', () => {
    render(<ThemeToggle />)
    expect(toggle().getAttribute('title')).toBe('Switch to Light')
  })
})
