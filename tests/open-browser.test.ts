import { describe, expect, it } from 'vitest'

import {
  buildCandidates,
  detectBrowserSupport,
  openBrowser,
  realLaunchIO,
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

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
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

  it('does not skip a candidate when a launcher reports its failure twice', () => {
    // child.on('error') should fire once, but a launcher that emits both an
    // error and a synchronous throw would otherwise consume two candidates per
    // failure and reach `exhausted` with untried launchers left.
    const commands: string[] = []
    const io: LaunchIO = {
      spawn(command, _args, onError) {
        commands.push(command)
        onError()
        onError()
      },
    }
    let exhausted = 0
    openBrowser(URL, wslSupport, io, () => {
      exhausted += 1
    })
    expect(commands).toEqual(['wslview', 'powershell.exe', 'cmd.exe'])
    expect(exhausted).toBe(1)
  })

  it('walks the chain when failures arrive asynchronously, the way a real ENOENT does', () => {
    // Every other fake here calls onError synchronously; a real spawn reports
    // ENOENT on a later tick, so the recursion has to survive re-entry across
    // microtasks rather than only inside one call frame.
    const commands: string[] = []
    const io: LaunchIO = {
      spawn(command, _args, onError) {
        commands.push(command)
        queueMicrotask(onError)
      },
    }
    return new Promise<void>((resolvePromise) => {
      openBrowser(URL, wslSupport, io, () => {
        expect(commands).toEqual(['wslview', 'powershell.exe', 'cmd.exe'])
        resolvePromise()
      })
    })
  })

  it('omitting onExhausted is allowed and must not throw when every launcher is missing', () => {
    // The parameter is optional; hook.ts is the only caller that passes it.
    const { io } = recordingIO(() => true)
    expect(() => {
      openBrowser(URL, wslSupport, io)
    }).not.toThrow()
  })
})

describe('realLaunchIO', () => {
  it('reports a missing launcher through onError instead of throwing', async () => {
    // This is the one signal openBrowser advances on. If a future change
    // swallowed it, the chain would stop at the first absent launcher and the
    // hook would sit on a port until the 86400s timeout.
    const called = new Promise<string>((resolvePromise) => {
      realLaunchIO.spawn('milkplan-no-such-launcher', [URL], () => {
        resolvePromise('onError')
      })
    })
    const outcome = await Promise.race([
      called,
      new Promise<string>((resolvePromise) => {
        setTimeout(() => {
          resolvePromise('onError never fired')
        }, 2000)
      }),
    ])
    expect(outcome).toBe('onError')
  })

  it('treats a synchronous spawn throw as a failed launch too', () => {
    // A NUL byte makes spawn throw straight away rather than emit 'error'.
    // The try/catch is what stops that becoming an uncaught exception in the
    // middle of the hook, which would mean no stdout and no exit at all.
    let failures = 0
    expect(() => {
      realLaunchIO.spawn('bad\u0000command', [URL], () => {
        failures += 1
      })
    }).not.toThrow()
    expect(failures).toBe(1)
  })
})
