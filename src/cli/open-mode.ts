import type { DeepReadonly } from '../shared/readonly'

/**
 * What should happen to the browser when a review is ready.
 *
 * - 'auto'       — open a tab and let the browser take focus (the default)
 * - 'background' — open a tab without raising the browser (macOS only)
 * - 'manual'     — open nothing; serve the review and wait for `milkplan open`
 */
export type OpenMode = 'auto' | 'background' | 'manual'

/** Keyed by mode so a new OpenMode fails to compile until it is accepted here. */
const MODES: Record<OpenMode, true> = {
  auto: true,
  background: true,
  manual: true,
}

function isOpenMode(value: string): value is OpenMode {
  return Object.hasOwn(MODES, value)
}

/**
 * Reads an environment variable, treating an empty value as unset — matching
 * `envValue` in open-browser.ts. Deliberately not shared: importing it from
 * there would point the launch *policy* at the launcher module, and this
 * module is the one open-browser.ts depends on, not the other way round.
 */
function envValue(
  env: DeepReadonly<Partial<Record<string, string>>>,
  key: string,
): string | undefined {
  const value = env[key]
  return value === undefined || value === '' ? undefined : value
}

/**
 * Whether the automation escape hatch is engaged.
 *
 * Exported because `milkplan open` has to answer this question separately: it
 * overrides MILKPLAN_OPEN (an explicit open must open) but not this, whose
 * documented contract is "never launch anything".
 */
export function noBrowserRequested(
  env: DeepReadonly<Partial<Record<string, string>>>,
): boolean {
  return envValue(env, 'MILKPLAN_NO_BROWSER') !== undefined
}

/**
 * Resolves the launch policy from the environment.
 *
 * MILKPLAN_NO_BROWSER wins outright. It predates the mode switch and its
 * documented meaning — serve the review, never launch, never pass through — is
 * exactly 'manual'. Letting an ambient MILKPLAN_OPEN override it would break
 * the automation escape hatch, and tests/helpers/cli-process.ts sets it on
 * every e2e run precisely to keep the suite from opening real browsers.
 *
 * An unrecognized MILKPLAN_OPEN falls back to 'auto' rather than failing: a
 * typo in a shell profile must not cost the user a review. It is logged,
 * because silently ignoring a switch the user clearly meant to set is worse.
 */
export function resolveOpenMode(
  env: DeepReadonly<Partial<Record<string, string>>>,
  log: (message: string) => void,
): OpenMode {
  if (noBrowserRequested(env)) return 'manual'

  const raw = envValue(env, 'MILKPLAN_OPEN')
  if (raw === undefined) return 'auto'
  const value = raw.trim().toLowerCase()
  // Whitespace-only reads as unset, not as a typo: no warning for it.
  if (value === '') return 'auto'
  if (isOpenMode(value)) return value

  log(`unknown MILKPLAN_OPEN value ${JSON.stringify(raw)}; opening normally`)
  return 'auto'
}
