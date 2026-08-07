import { spawn } from 'node:child_process'

import type { DeepReadonly } from '../shared/readonly'

/**
 * Everything the launch decision depends on. Injected so `detectBrowserSupport`
 * stays a pure function — testable without spawning anything or trusting the
 * host OS the suite happens to run on.
 */
export interface BrowserEnv {
  platform: NodeJS.Platform
  /** os.release(): carries the WSL kernel marker. */
  release: string
  env: Partial<Record<string, string>>
}

/** Launcher identities, resolved to argv by `buildCandidates`. */
export type LauncherId =
  | 'browser-env'
  | 'macos-open'
  | 'windows-start'
  | 'wslview'
  | 'powershell'
  | 'xdg-open'

export type BrowserSupport =
  | { kind: 'suppressed' }
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'available'
      /** Tried in order; the first launcher that starts wins. */
      launchers: readonly LauncherId[]
      /** $BROWSER's value. Set exactly when `launchers` contains 'browser-env'. */
      browserCommand?: string
    }

export interface Candidate {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * Reads an environment variable, treating an empty value as unset — the
 * semantics the original MILKPLAN_NO_BROWSER check already used, and the only
 * sane reading of `DISPLAY=`.
 */
function envValue(
  env: DeepReadonly<Partial<Record<string, string>>>,
  key: string,
): string | undefined {
  const value = env[key]
  return value === undefined || value === '' ? undefined : value
}

/**
 * WSL reports platform 'linux', so the Windows-side launchers have to be gated
 * on an explicit WSL signal. The kernel-release fallback covers a stripped
 * environment; casing differs between WSL1 ("4.4.0-19041-Microsoft") and WSL2
 * ("5.15.90.1-microsoft-standard-WSL2"), hence the lowercased compare.
 */
function isWsl(environment: DeepReadonly<BrowserEnv>): boolean {
  if (environment.platform !== 'linux') return false
  if (envValue(environment.env, 'WSL_DISTRO_NAME') !== undefined) return true
  if (envValue(environment.env, 'WSL_INTEROP') !== undefined) return true
  return environment.release.toLowerCase().includes('microsoft')
}

function available(
  launchers: readonly LauncherId[],
  browserCommand: string | undefined,
): BrowserSupport {
  return { kind: 'available', launchers, browserCommand }
}

/**
 * The user's browser lives on the Windows side, so the Windows launchers come
 * first even under WSLg — a WSL distro with a real Linux browser installed is
 * the rare case, and xdg-open still backstops it when there is a display.
 */
function wslLaunchers(
  override: readonly LauncherId[],
  hasDisplay: boolean,
): readonly LauncherId[] {
  return [
    ...override,
    'wslview',
    'powershell',
    'windows-start',
    ...(hasDisplay ? (['xdg-open'] as const) : []),
  ]
}

/**
 * Decides how — or whether — a browser can be opened here.
 *
 * 'unavailable' is the load-bearing verdict: the hook passes through to Claude
 * Code's own approval prompt instead of serving a review nobody can reach. Left
 * to itself the process would sit on a listening socket until the hook timeout
 * (86400s as written by `milkplan init`), which reads as a frozen session.
 */
export function detectBrowserSupport(
  environment: DeepReadonly<BrowserEnv>,
): BrowserSupport {
  // First, so the automation escape hatch keeps its exact meaning: serve, never
  // launch, and never pass through.
  if (envValue(environment.env, 'MILKPLAN_NO_BROWSER') !== undefined)
    return { kind: 'suppressed' }

  // $BROWSER is the POSIX convention; on win32 it is meaningless and `spawn`
  // there does not resolve .cmd/.bat wrappers, so it is not honored.
  const browserCommand =
    environment.platform === 'win32'
      ? undefined
      : envValue(environment.env, 'BROWSER')
  const override: readonly LauncherId[] =
    browserCommand === undefined ? [] : ['browser-env']

  if (environment.platform === 'darwin')
    return available([...override, 'macos-open'], browserCommand)
  if (environment.platform === 'win32')
    return available(['windows-start'], undefined)

  const hasDisplay =
    envValue(environment.env, 'DISPLAY') !== undefined ||
    envValue(environment.env, 'WAYLAND_DISPLAY') !== undefined

  if (isWsl(environment))
    return available(wslLaunchers(override, hasDisplay), browserCommand)

  if (hasDisplay) return available([...override, 'xdg-open'], browserCommand)
  // $BROWSER on a display-less box is an explicit "here is how to open a URL",
  // which is exactly the escape hatch an SSH or container user needs.
  if (browserCommand !== undefined) return available(override, browserCommand)
  return {
    kind: 'unavailable',
    reason: 'no DISPLAY, WAYLAND_DISPLAY or BROWSER',
  }
}

/**
 * Every launcher but 'browser-env', which alone needs a command from the
 * environment. Keyed by id so adding a `LauncherId` fails to compile until it
 * has argv here.
 */
const FIXED_CANDIDATES: Record<
  Exclude<LauncherId, 'browser-env'>,
  (url: string) => Candidate
> = {
  'macos-open': (url) => ({ command: 'open', args: [url] }),
  // The empty argument is `start`'s title parameter; without it `start` would
  // consume the URL as the window title.
  'windows-start': (url) => ({
    command: 'cmd.exe',
    args: ['/c', 'start', '', url],
  }),
  wslview: (url) => ({ command: 'wslview', args: [url] }),
  // The URL must stay single-quoted: PowerShell begins a comment at a `#`
  // preceded by whitespace, and the review URL always carries a `#token=`
  // fragment. We generate the URL ourselves, so it holds no quote to escape.
  powershell: (url) => ({
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process '${url}'`,
    ],
  }),
  'xdg-open': (url) => ({ command: 'xdg-open', args: [url] }),
}

function candidateFor(
  id: LauncherId,
  url: string,
  browserCommand: string | undefined,
): Candidate | null {
  // $BROWSER is taken as a bare command: no colon-list splitting (it would cut
  // a Windows path in half) and no %s expansion. Returning null when it is
  // absent keeps the pairing honest without a non-null assertion.
  if (id === 'browser-env')
    return browserCommand === undefined
      ? null
      : { command: browserCommand, args: [url] }
  return FIXED_CANDIDATES[id](url)
}

/**
 * Expands a support verdict into concrete argv. Every candidate must carry the
 * URL's `#token=` fragment verbatim: the UI falls back to the dev token when the
 * fragment is missing, so dropping it yields a page that loads and then 403s on
 * every API call — a silently broken review rather than a visible failure.
 */
export function buildCandidates(
  support: DeepReadonly<BrowserSupport>,
  url: string,
): readonly Candidate[] {
  if (support.kind !== 'available') return []
  const { browserCommand } = support
  return support.launchers
    .map((id) => candidateFor(id, url, browserCommand))
    .filter((candidate): candidate is Candidate => candidate !== null)
}

export interface LaunchIO {
  /**
   * Starts a launcher without waiting for it. `onError` fires when the process
   * could not be started at all — the one signal the chain advances on.
   */
  spawn(command: string, args: readonly string[], onError: () => void): void
}

export const realLaunchIO: LaunchIO = {
  spawn(command, args, onError) {
    try {
      // detached + unref so a launcher never keeps the hook process alive; the
      // handle is held only long enough to hear a spawn failure.
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      child.on('error', onError)
      child.unref()
    } catch {
      // spawn can still throw synchronously; treat it as "did not start".
      onError()
    }
  },
}

/**
 * Walks the candidate chain, advancing only when a launcher fails to start at
 * all (ENOENT/EACCES). Exit codes are deliberately ignored: they disagree across
 * launchers (`start` returns the moment it hands off, explorer.exe returns 1 even
 * on success), and the "installed but no display" case is already settled by
 * `detectBrowserSupport` before the server binds.
 *
 * `onExhausted` means every launcher was missing — nothing opened, so the caller
 * can pass through. A suppressed verdict returns early instead:
 * MILKPLAN_NO_BROWSER means "serve and wait for a manual visit", never "pass
 * through".
 */
export function openBrowser(
  url: string,
  support: DeepReadonly<BrowserSupport>,
  io: DeepReadonly<LaunchIO>,
  onExhausted?: () => void,
): void {
  if (support.kind !== 'available') return
  const candidates = buildCandidates(support, url)
  let index = 0
  const advance = (): void => {
    const next = candidates[index]
    index += 1
    if (next === undefined) {
      onExhausted?.()
      return
    }
    let advanced = false
    io.spawn(next.command, next.args, () => {
      // 'error' should fire once, but a second event must not skip a candidate.
      if (advanced) return
      advanced = true
      advance()
    })
  }
  advance()
}
