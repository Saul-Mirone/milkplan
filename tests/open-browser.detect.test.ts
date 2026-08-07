import { describe, expect, it } from 'vitest'

import {
  detectBrowserSupport,
  type BrowserEnv,
  type BrowserSupport,
  type LauncherId,
} from '../src/cli/open-browser'
import type { DeepReadonly } from '../src/shared/readonly'

/** A bare Linux box — no display, stock kernel — unless a case overrides it. */
function environment(
  overrides: DeepReadonly<Partial<BrowserEnv>> = {},
): DeepReadonly<BrowserEnv> {
  return { platform: 'linux', release: '6.8.0-generic', env: {}, ...overrides }
}

function launchersOf(
  support: DeepReadonly<BrowserSupport>,
): readonly LauncherId[] {
  return support.kind === 'available' ? support.launchers : []
}

function detect(
  overrides: DeepReadonly<Partial<BrowserEnv>>,
): readonly LauncherId[] {
  return launchersOf(detectBrowserSupport(environment(overrides)))
}

/** Empty for any verdict other than 'unavailable', which is itself a failure. */
function reasonOf(support: DeepReadonly<BrowserSupport>): string {
  return support.kind === 'unavailable' ? support.reason : ''
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('detectBrowserSupport', () => {
  it('suppresses the launch when MILKPLAN_NO_BROWSER is set, on any platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const support = detectBrowserSupport(
        environment({ platform, env: { MILKPLAN_NO_BROWSER: '1' } }),
      )
      expect(support.kind).toBe('suppressed')
    }
  })

  it('treats an empty MILKPLAN_NO_BROWSER as unset', () => {
    // Preserves the original check, which required a non-empty value.
    expect(
      detect({ platform: 'darwin', env: { MILKPLAN_NO_BROWSER: '' } }),
    ).toEqual(['macos-open'])
  })

  it('opens on macOS and Windows without any display variable', () => {
    expect(detect({ platform: 'darwin' })).toEqual(['macos-open'])
    expect(detect({ platform: 'win32' })).toEqual(['windows-start'])
  })

  it('ignores $BROWSER on Windows, where spawn cannot resolve .cmd/.bat wrappers', () => {
    expect(detect({ platform: 'win32', env: { BROWSER: 'firefox' } })).toEqual([
      'windows-start',
    ])
  })

  it('uses xdg-open on a Linux desktop, under X11 or Wayland alike', () => {
    expect(detect({ env: { DISPLAY: ':0' } })).toEqual(['xdg-open'])
    // A Wayland-only session has no DISPLAY at all.
    expect(detect({ env: { WAYLAND_DISPLAY: 'wayland-0' } })).toEqual([
      'xdg-open',
    ])
  })

  it('keeps xdg-open for the other POSIX platforms', () => {
    // The original code had an unconditional `else` branch; freebsd and friends
    // must not fall off the platform switch and lose their launcher.
    expect(detect({ platform: 'freebsd', env: { DISPLAY: ':0' } })).toEqual([
      'xdg-open',
    ])
  })

  it('reports unavailable on a headless Linux box', () => {
    // The verdict that makes the hook pass through instead of parking Claude
    // Code on a listening socket until the 86400s hook timeout.
    const support = detectBrowserSupport(environment())
    expect(support.kind).toBe('unavailable')
    expect(reasonOf(support)).toContain('DISPLAY')
  })

  it('treats an empty DISPLAY as no display', () => {
    expect(
      detectBrowserSupport(environment({ env: { DISPLAY: '' } })).kind,
    ).toBe('unavailable')
  })

  it('treats $BROWSER as a display-less escape hatch, ahead of the platform launcher', () => {
    expect(detect({ env: { BROWSER: 'firefox' } })).toEqual(['browser-env'])
    expect(detect({ env: { BROWSER: 'firefox', DISPLAY: ':0' } })).toEqual([
      'browser-env',
      'xdg-open',
    ])
  })
})

const WSL_CHAIN: readonly LauncherId[] = [
  'wslview',
  'powershell',
  'windows-start',
]

describe('detectBrowserSupport under WSL', () => {
  it('recognizes WSL from either environment marker', () => {
    expect(detect({ env: { WSL_DISTRO_NAME: 'Ubuntu' } })).toEqual(WSL_CHAIN)
    expect(detect({ env: { WSL_INTEROP: '/run/WSL/8_interop' } })).toEqual(
      WSL_CHAIN,
    )
  })

  it('recognizes WSL1 and WSL2 kernel strings when the environment is stripped', () => {
    // WSL1 capitalizes it, WSL2 does not — the compare must be case-insensitive.
    expect(detect({ release: '4.4.0-19041-Microsoft' })).toEqual(WSL_CHAIN)
    expect(detect({ release: '5.15.90.1-microsoft-standard-WSL2' })).toEqual(
      WSL_CHAIN,
    )
    // ...and a stock kernel must not match.
    expect(
      detectBrowserSupport(environment({ release: '6.8.0-generic' })).kind,
    ).toBe('unavailable')
  })

  it('does not take the WSL branch on native Windows', () => {
    // WSL variables leak into Windows-side processes; the platform gates them.
    expect(
      detect({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu' } }),
    ).toEqual(['windows-start'])
  })

  it('prefers the Windows browser over WSLg, keeping xdg-open as the backstop', () => {
    expect(
      detect({
        release: '5.15.90.1-microsoft-standard-WSL2',
        env: { DISPLAY: ':0' },
      }),
    ).toEqual([...WSL_CHAIN, 'xdg-open'])
  })

  it('lets $BROWSER jump the whole chain', () => {
    expect(
      detect({ env: { WSL_DISTRO_NAME: 'Ubuntu', BROWSER: 'wslview' } }),
    ).toEqual(['browser-env', ...WSL_CHAIN])
  })
})
