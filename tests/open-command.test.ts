import { describe, expect, it } from 'vitest'

import type { BrowserSupport } from '../src/cli/browser-support'
import { runOpen, type OpenIO } from '../src/cli/open-command'
import type { PendingEntry } from '../src/cli/pending'
import type { PendingLiveness } from '../src/cli/probe-review'
import type { DeepReadonly } from '../src/shared/readonly'

const AVAILABLE: BrowserSupport = {
  kind: 'available',
  launchers: ['macos-open'],
}

function entry(
  pid: number,
  overrides: Partial<PendingEntry> = {},
): PendingEntry {
  return {
    pid,
    url: `http://127.0.0.1:${5000 + pid}/#token=${'a'.repeat(32)}`,
    sessionId: `session-${pid}`,
    cwd: `/proj/${pid}`,
    planPath: null,
    startedAt: Date.now() - pid * 60_000,
    ...overrides,
  }
}

interface FakeOpenState {
  launched: string[]
  removed: number[]
  stdout: string[]
  logs: string[]
  failures: number
}

interface FakeOpenOptions {
  entries?: PendingEntry[]
  /** Liveness by pid; anything unlisted probes 'live'. */
  verdicts?: Record<number, PendingLiveness>
  support?: BrowserSupport
  /** Invoke onExhausted, as a box with no working launcher would. */
  launchFails?: boolean
}

function fakeOpenIO(options: DeepReadonly<FakeOpenOptions> = {}): {
  io: OpenIO
  state: FakeOpenState
} {
  const state: FakeOpenState = {
    launched: [],
    removed: [],
    stdout: [],
    logs: [],
    failures: 0,
  }
  const entries = options.entries ?? []
  const io: OpenIO = {
    listPending: () => entries.map((each) => ({ ...each })),
    probe: (each) =>
      Promise.resolve(options.verdicts?.[each.pid] ?? ('live' as const)),
    removePending(pid) {
      state.removed.push(pid)
    },
    browserSupport: () => options.support ?? AVAILABLE,
    launch(url, _support, onExhausted) {
      state.launched.push(url)
      if (options.launchFails === true) onExhausted()
    },
    writeStdout(line) {
      state.stdout.push(line)
    },
    log(message) {
      state.logs.push(message)
    },
    fail() {
      state.failures += 1
    },
  }
  return { io, state }
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('runOpen', () => {
  it('fails when nothing is waiting', async () => {
    const fake = fakeOpenIO()
    await runOpen([], fake.io)

    expect(fake.state.launched).toEqual([])
    expect(fake.state.failures).toBe(1)
    expect(fake.state.logs.join('\n')).toContain('no plan review is waiting')
  })

  it('opens the single waiting review', async () => {
    const only = entry(1)
    const fake = fakeOpenIO({ entries: [only] })
    await runOpen([], fake.io)

    expect(fake.state.launched).toEqual([only.url])
    expect(fake.state.failures).toBe(0)
  })

  it('opens the newest and names the rest', async () => {
    // listPending hands them over newest first; the others must still be
    // visible or a second session's review looks like it was never registered.
    const newest = entry(1)
    const older = entry(2)
    const fake = fakeOpenIO({ entries: [newest, older] })
    await runOpen([], fake.io)

    expect(fake.state.launched).toEqual([newest.url])
    const logs = fake.state.logs.join('\n')
    expect(logs).toContain('also waiting')
    expect(logs).toContain(older.url)
  })

  it('opens every review with --all', async () => {
    const first = entry(1)
    const second = entry(2)
    const fake = fakeOpenIO({ entries: [first, second] })
    await runOpen(['--all'], fake.io)

    expect(fake.state.launched).toEqual([first.url, second.url])
  })

  it('prints and launches nothing with --print', async () => {
    const first = entry(1)
    const second = entry(2)
    const fake = fakeOpenIO({ entries: [first, second] })
    await runOpen(['--print'], fake.io)

    expect(fake.state.stdout).toEqual([`${first.url}\n`, `${second.url}\n`])
    expect(fake.state.launched).toEqual([])
    expect(fake.state.failures).toBe(0)
  })

  it('drops entries the probe calls dead', async () => {
    // The corpse an exit handler could not clean up: SIGKILL, or a lost machine.
    const alive = entry(1)
    const fake = fakeOpenIO({
      entries: [alive, entry(2), entry(3)],
      verdicts: { 2: 'dead', 3: 'dead' },
    })
    await runOpen([], fake.io)

    expect(fake.state.removed).toEqual([2, 3])
    expect(fake.state.launched).toEqual([alive.url])
  })

  it('keeps an indeterminate entry but does not offer it', async () => {
    // A Ctrl-Z'd session answers again on fg, so its file must survive even
    // though there is nothing to open right now.
    const fake = fakeOpenIO({
      entries: [entry(1)],
      verdicts: { 1: 'indeterminate' },
    })
    await runOpen([], fake.io)

    expect(fake.state.removed).toEqual([])
    expect(fake.state.launched).toEqual([])
    expect(fake.state.failures).toBe(1)
  })

  it('prints instead of failing when no browser can be opened', async () => {
    // The ssh -L user: the URL is exactly what they came for.
    const only = entry(1)
    const fake = fakeOpenIO({
      entries: [only],
      support: { kind: 'unavailable', reason: 'no DISPLAY' },
    })
    await runOpen([], fake.io)

    expect(fake.state.stdout).toEqual([`${only.url}\n`])
    expect(fake.state.launched).toEqual([])
    expect(fake.state.failures).toBe(0)
  })

  it('prints instead of launching when MILKPLAN_NO_BROWSER suppressed it', async () => {
    // "Never launch anything" is that variable's whole contract — including
    // when the launch was asked for explicitly.
    const only = entry(1)
    const fake = fakeOpenIO({
      entries: [only],
      support: { kind: 'suppressed', reason: 'MILKPLAN_NO_BROWSER' },
    })
    await runOpen([], fake.io)

    expect(fake.state.stdout).toEqual([`${only.url}\n`])
    expect(fake.state.launched).toEqual([])
    expect(fake.state.failures).toBe(0)
  })

  it('reports the URL and fails when every launcher is missing', async () => {
    // WSL with interop disabled. Exiting 0 having opened nothing would be
    // worse than the hook's version of this, which at least has a prompt to
    // fall back to.
    const only = entry(1)
    const fake = fakeOpenIO({ entries: [only], launchFails: true })
    await runOpen([], fake.io)

    expect(fake.state.failures).toBe(1)
    expect(fake.state.logs.join('\n')).toContain(only.url)
  })

  it('rejects an unknown option without touching the registry', async () => {
    const fake = fakeOpenIO({ entries: [entry(1)] })
    await runOpen(['--wat'], fake.io)

    expect(fake.state.launched).toEqual([])
    expect(fake.state.failures).toBe(1)
    expect(fake.state.logs.join('\n')).toContain('--wat')
  })
})
