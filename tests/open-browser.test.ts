import { describe, expect, it } from 'vitest'

import {
  buildCandidates,
  detectBrowserSupport,
  openBrowser,
  type BrowserEnv,
  type Candidate,
  type LaunchIO,
} from '../src/cli/open-browser'
import type { DeepReadonly } from '../src/shared/readonly'

// Real shape: loopback, random port, token in the fragment.
const URL = 'http://127.0.0.1:54321/#token=0123456789abcdef'

function candidatesFor(
  overrides: DeepReadonly<Partial<BrowserEnv>>,
): readonly Candidate[] {
  const support = detectBrowserSupport({
    platform: 'linux',
    release: '6.8.0-generic',
    env: {},
    ...overrides,
  })
  return buildCandidates(support, URL)
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('buildCandidates', () => {
  it('builds the macOS and POSIX argv', () => {
    expect(candidatesFor({ platform: 'darwin' })).toEqual([
      { command: 'open', args: [URL] },
    ])
    expect(candidatesFor({ env: { DISPLAY: ':0' } })).toEqual([
      { command: 'xdg-open', args: [URL] },
    ])
    expect(candidatesFor({ env: { BROWSER: '/usr/bin/firefox' } })).toEqual([
      { command: '/usr/bin/firefox', args: [URL] },
    ])
  })

  it('passes the empty title argument to `start` so the URL is not eaten', () => {
    expect(candidatesFor({ platform: 'win32' })).toEqual([
      { command: 'cmd.exe', args: ['/c', 'start', '', URL] },
    ])
  })

  it('single-quotes the URL for PowerShell, whose comments start at #', () => {
    expect(candidatesFor({ env: { WSL_DISTRO_NAME: 'Ubuntu' } })[1]).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process '${URL}'`,
      ],
    })
  })

  it('carries the #token= fragment verbatim into every candidate', () => {
    // Losing it fails silently: the UI falls back to the dev token, so the page
    // loads and then 403s on every /api call.
    const environments: readonly DeepReadonly<Partial<BrowserEnv>>[] = [
      { platform: 'darwin' },
      { platform: 'win32' },
      { env: { DISPLAY: ':0' } },
      { env: { BROWSER: 'firefox' } },
      { env: { WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: ':0' } },
    ]
    for (const overrides of environments) {
      const candidates = candidatesFor(overrides)
      expect(candidates.length).toBeGreaterThan(0)
      for (const candidate of candidates) {
        expect(candidate.args.some((arg) => arg.includes('#token='))).toBe(true)
      }
    }
  })

  it('yields nothing when there is no launcher to run', () => {
    expect(candidatesFor({})).toEqual([])
    expect(candidatesFor({ env: { MILKPLAN_NO_BROWSER: '1' } })).toEqual([])
  })
})

function recordingIO(failing: (command: string) => boolean): {
  io: LaunchIO
  commands: readonly string[]
} {
  const commands: string[] = []
  return {
    commands,
    io: {
      spawn(command, _args, onError) {
        commands.push(command)
        if (failing(command)) onError()
      },
    },
  }
}

const wslSupport = detectBrowserSupport({
  platform: 'linux',
  release: '6.8.0-generic',
  env: { WSL_DISTRO_NAME: 'Ubuntu' },
})

describe('openBrowser', () => {
  it('stops at the first launcher that starts', () => {
    const { io, commands } = recordingIO(() => false)
    let exhausted = 0
    openBrowser(URL, wslSupport, io, () => {
      exhausted += 1
    })
    expect(commands).toEqual(['wslview'])
    expect(exhausted).toBe(0)
  })

  it('advances to the next launcher when one is missing', () => {
    const { io, commands } = recordingIO((command) => command === 'wslview')
    let exhausted = 0
    openBrowser(URL, wslSupport, io, () => {
      exhausted += 1
    })
    expect(commands).toEqual(['wslview', 'powershell.exe'])
    expect(exhausted).toBe(0)
  })

  it('reports exhaustion exactly once when every launcher is missing', () => {
    // WSL with interop disabled: detection cannot see it, so the exhausted
    // chain is what tells the hook to pass through.
    const { io, commands } = recordingIO(() => true)
    let exhausted = 0
    openBrowser(URL, wslSupport, io, () => {
      exhausted += 1
    })
    expect(commands).toEqual(['wslview', 'powershell.exe', 'cmd.exe'])
    expect(exhausted).toBe(1)
  })

  it('never launches or reports exhaustion when suppressed', () => {
    // MILKPLAN_NO_BROWSER means "serve and wait for a manual visit". Reporting
    // exhaustion would turn `pnpm smoke` and ssh -L users into passthroughs.
    const suppressed = detectBrowserSupport({
      platform: 'linux',
      release: '6.8.0-generic',
      env: { MILKPLAN_NO_BROWSER: '1', DISPLAY: ':0' },
    })
    const { io, commands } = recordingIO(() => true)
    let exhausted = 0
    openBrowser(URL, suppressed, io, () => {
      exhausted += 1
    })
    expect(commands).toEqual([])
    expect(exhausted).toBe(0)
  })
})
