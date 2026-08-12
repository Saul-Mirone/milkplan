import { platform as osPlatform, release } from 'node:os'

import { noBrowserRequested, resolveOpenMode, type OpenMode } from './open-mode'
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
  /**
   * The caller's launch policy. Required, and deliberately not read from `env`
   * here: `milkplan open` passes 'auto' to override whatever the user
   * configured — an explicit open always launches — and a required field makes
   * a call site that forgets to thread the mode a compile error.
   */
  mode: OpenMode
}

/** Launcher identities, resolved to argv by `buildCandidates`. */
export type LauncherId =
  | 'browser-env'
  | 'macos-open'
  | 'macos-open-bg'
  | 'windows-start'
  | 'wslview'
  | 'powershell'
  | 'xdg-open'

export type BrowserSupport =
  /** Serve the review and wait for a manual visit; never launch, never pass through. */
  | { kind: 'suppressed'; reason: string }
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'available'
      /** Tried in order; the first launcher that starts wins. */
      launchers: readonly LauncherId[]
      /** $BROWSER's value. Set exactly when `launchers` contains 'browser-env'. */
      browserCommand?: string
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
  // First, so the manual/automation escape hatch keeps its exact meaning:
  // serve, never launch, and never pass through — including on a box where
  // the checks below would have returned 'unavailable'.
  if (environment.mode === 'manual')
    return { kind: 'suppressed', reason: 'MILKPLAN_OPEN=manual' }

  // $BROWSER is the POSIX convention; on win32 it is meaningless and `spawn`
  // there does not resolve .cmd/.bat wrappers, so it is not honored.
  const browserCommand =
    environment.platform === 'win32'
      ? undefined
      : envValue(environment.env, 'BROWSER')
  const override: readonly LauncherId[] =
    browserCommand === undefined ? [] : ['browser-env']

  if (environment.platform === 'darwin')
    return available(
      // $BROWSER still wins when set: we cannot know an arbitrary browser
      // command's background flag, so background mode only reshapes the
      // platform launcher.
      [
        ...override,
        environment.mode === 'background' ? 'macos-open-bg' : 'macos-open',
      ],
      browserCommand,
    )
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
 * The impure counterpart of `detectBrowserSupport` — the real platform, the
 * real environment — kept here beside it rather than in hook-io.ts so that
 * `detectBrowserSupport` can stay a pure function of its argument.
 *
 * `mode` may be forced: `milkplan open` passes 'auto' because an explicit open
 * must launch whatever the user configured for the hook.
 */
export function realBrowserSupport(
  log: (message: string) => void,
  forced?: OpenMode,
): BrowserSupport {
  const mode = forced ?? resolveOpenMode(process.env, log)
  // Only reachable here, where both the resolved mode and the real platform
  // are known. Nothing else can tell the user their switch did nothing.
  if (mode === 'background' && osPlatform() !== 'darwin')
    log('MILKPLAN_OPEN=background only works on macOS; opening normally')
  const support = detectBrowserSupport({
    platform: osPlatform(),
    release: release(),
    env: process.env,
    mode,
  })
  // detectBrowserSupport is pure and sees only a mode, so it names the switch
  // it can infer. This layer knows which one the user actually set — and a
  // message naming a variable they never touched is worse than none.
  if (support.kind === 'suppressed' && noBrowserRequested(process.env))
    return { ...support, reason: 'MILKPLAN_NO_BROWSER' }
  return support
}
