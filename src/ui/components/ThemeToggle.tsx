import { useCallback, useState } from 'react'

import {
  applyTheme,
  nextTheme,
  readStoredTheme,
  storeTheme,
  THEME_LABELS,
} from '../theme'

/**
 * Cycles System → Light → Dark. Three states rather than a plain Light/Dark
 * switch: the page follows the OS by default, and a two-way toggle would drop
 * that the first time it was touched, with no way back.
 *
 * Deliberately not disabled while a decision is in flight — unlike every other
 * control in the bar, this one changes nothing the CLI will see.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState(readStoredTheme)
  // The side effects stay out of the updater callback: React is free to run
  // that more than once for a single click, which would skip a state.
  const onClick = useCallback(() => {
    const next = nextTheme(preference)
    applyTheme(next)
    storeTheme(next)
    setPreference(next)
  }, [preference])
  return (
    <button
      type="button"
      className="mp-button mp-button--ghost mp-theme"
      onClick={onClick}
      title={`Switch to ${THEME_LABELS[nextTheme(preference)]}`}
      aria-label={`Theme: ${THEME_LABELS[preference]}. Switch to ${THEME_LABELS[nextTheme(preference)]}`}
    >
      {`Theme: ${THEME_LABELS[preference]}`}
    </button>
  )
}
