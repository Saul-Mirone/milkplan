/**
 * The review page's light/dark switch.
 *
 * Every themed value — the app palette, the vendored Crepe palette, shiki's
 * code-block tokens, and native controls like the `After approval:` select —
 * resolves through CSS `light-dark()`, so the only thing that has to move is
 * `color-scheme` on <html>. Nothing re-renders and no stylesheet is swapped,
 * which is what makes this reachable at all: shiki's token colors live in
 * ProseMirror decorations that cannot be invalidated from outside the
 * highlight plugin (see src/ui/highlight/feature.ts).
 */

export type ThemePreference = 'system' | 'light' | 'dark'

/** Bumping this orphans stored choices; there is no migration. */
const STORAGE_KEY = 'milkplan:theme'

const THEME_PREFERENCES: readonly ThemePreference[] = [
  'system',
  'light',
  'dark',
]

/** The order the toggle button walks through. */
const NEXT: Readonly<Record<ThemePreference, ThemePreference>> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

export const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

/** 'light dark' is the value that lets `light-dark()` follow the OS. */
const COLOR_SCHEMES: Readonly<Record<ThemePreference, string>> = {
  system: 'light dark',
  light: 'light',
  dark: 'dark',
}

/** Anything unrecognised — including a key written by a future version. */
export function parseTheme(raw: string | null): ThemePreference {
  return THEME_PREFERENCES.find((pref) => pref === raw) ?? 'system'
}

export function colorSchemeFor(preference: ThemePreference): string {
  return COLOR_SCHEMES[preference]
}

export function nextTheme(preference: ThemePreference): ThemePreference {
  return NEXT[preference]
}

/**
 * Storage access itself throws in some privacy modes, not just the write — a
 * review that cannot render is worse than one that forgets the choice.
 */
export function readStoredTheme(): ThemePreference {
  try {
    return parseTheme(localStorage.getItem(STORAGE_KEY))
  } catch {
    return 'system'
  }
}

export function storeTheme(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Unpersisted, but the current page still honors the choice.
  }
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.style.colorScheme = colorSchemeFor(preference)
}
