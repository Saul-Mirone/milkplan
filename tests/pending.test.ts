import { describe, expect, it } from 'vitest'

import {
  listPending,
  pendingDirFor,
  pendingFileFor,
  removePending,
  writePending,
  type PendingEntry,
  type PendingInput,
} from '../src/cli/pending'
import type { DeepReadonly } from '../src/shared/readonly'
import {
  fakePendingIO,
  FAKE_NOW,
  HOME,
  type FakePendingState,
  type Written,
} from './helpers/fake-pending-io'

const TOKEN = '0123456789abcdef0123456789abcdef'
const URL_FOR_PORT = (port: number): string =>
  `http://127.0.0.1:${port}/#token=${TOKEN}`

const input: PendingInput = {
  url: URL_FOR_PORT(54321),
  sessionId: 'session-a',
  cwd: '/Users/dev/Code/app',
  planPath: '/Users/dev/.claude/plans/sunny-rolling-otter.md',
}

function entryJson(overrides: Partial<PendingEntry> = {}): string {
  return `${JSON.stringify({
    pid: 100,
    url: URL_FOR_PORT(54321),
    sessionId: 'session-a',
    cwd: '/Users/dev/Code/app',
    planPath: null,
    startedAt: FAKE_NOW,
    ...overrides,
  })}\n`
}

const dir = pendingDirFor(HOME)

function pidOf(entry: DeepReadonly<PendingEntry>): number {
  return entry.pid
}

/** Keeps the branch out of the `it` body, where it would read as a condition. */
function onlyWrite(state: DeepReadonly<FakePendingState>): Written {
  const [write] = state.writes
  if (write === undefined) throw new Error('expected exactly one write')
  return write
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('writePending', () => {
  it('writes the entry under its own pid, stamping pid and startedAt', () => {
    const fake = fakePendingIO()
    writePending(input, 4242, fake.io)
    expect(fake.state.mkdirs).toEqual([dir])
    expect(fake.state.writes).toHaveLength(1)
    expect(onlyWrite(fake.state).path).toBe(pendingFileFor(HOME, 4242))
    expect(JSON.parse(onlyWrite(fake.state).content)).toEqual({
      ...input,
      pid: 4242,
      startedAt: FAKE_NOW,
    })
  })

  it('never throws when the directory cannot be created', () => {
    // Fail-open: a read-only HOME must cost a diagnostic, not the review.
    const fake = fakePendingIO({ mkdirFails: true })
    expect(() => {
      writePending(input, 1, fake.io)
    }).not.toThrow()
    expect(fake.state.logs.join('\n')).toContain('milkplan open')
  })

  it('never throws when the entry cannot be written', () => {
    const fake = fakePendingIO({ writeFails: true })
    expect(() => {
      writePending(input, 1, fake.io)
    }).not.toThrow()
    expect(fake.state.logs.join('\n')).toContain('milkplan open')
  })

  it('prunes malformed, refused and stale siblings, but never its own file', () => {
    const fake = fakePendingIO({
      files: {
        [`${dir}/1.json`]: 'not json{',
        [`${dir}/2.json`]: entryJson({ pid: 2, url: 'http://evil.test/' }),
        [`${dir}/3.json`]: entryJson({
          pid: 3,
          startedAt: FAKE_NOW - 72 * 60 * 60 * 1000,
        }),
        [`${dir}/4.json`]: entryJson({ pid: 4 }),
        [`${dir}/notes.txt`]: 'ignored',
      },
    })
    writePending(input, 5, fake.io)
    expect(fake.state.removed.sort()).toEqual([
      `${dir}/1.json`,
      `${dir}/2.json`,
      `${dir}/3.json`,
    ])
    // A live sibling and the file just written both survive.
    expect(fake.files.has(`${dir}/4.json`)).toBe(true)
    expect(fake.files.has(`${dir}/5.json`)).toBe(true)
    // A name that is not a pid is never joined to a path.
    expect(fake.files.has(`${dir}/notes.txt`)).toBe(true)
  })

  it('still writes when the directory cannot be listed', () => {
    const fake = fakePendingIO({ listDirFails: true })
    writePending(input, 7, fake.io)
    expect(fake.state.writes).toHaveLength(1)
    expect(fake.state.removed).toEqual([])
  })
})

describe('removePending', () => {
  it('removes exactly the given pid', () => {
    const fake = fakePendingIO({
      files: { [`${dir}/9.json`]: entryJson({ pid: 9 }) },
    })
    removePending(9, fake.io)
    expect(fake.state.removed).toEqual([`${dir}/9.json`])
  })
})

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('listPending', () => {
  it('returns valid entries newest first', () => {
    const fake = fakePendingIO({
      files: {
        [`${dir}/1.json`]: entryJson({ pid: 1, startedAt: FAKE_NOW - 5000 }),
        [`${dir}/2.json`]: entryJson({ pid: 2, startedAt: FAKE_NOW }),
        [`${dir}/3.json`]: entryJson({ pid: 3, startedAt: FAKE_NOW - 1000 }),
      },
    })
    expect(listPending(fake.io).map(pidOf)).toEqual([2, 3, 1])
  })

  it('skips torn, wrong-shaped, badly-named and pattern-refused entries', () => {
    const fake = fakePendingIO({
      files: {
        // A torn writeFile costs only its own line, the way parseHistory works.
        [`${dir}/1.json`]: '{"pid":1,"url":"http://127.0',
        [`${dir}/2.json`]: JSON.stringify({ pid: 2 }),
        [`${dir}/3.json`]: entryJson({ pid: 3, url: 'file:///etc/passwd' }),
        [`${dir}/4.json`]: entryJson({
          pid: 4,
          url: 'http://127.0.0.1:1/#token=nothex',
        }),
        [`${dir}/../escape.json`]: entryJson({ pid: 5 }),
        [`${dir}/6.json`]: entryJson({ pid: 6 }),
      },
    })
    expect(listPending(fake.io).map(pidOf)).toEqual([6])
  })

  it('tolerates unknown fields from a newer writer', () => {
    // `npx @enorim/milkplan open` may be a different version than the hook.
    const fake = fakePendingIO({
      files: {
        [`${dir}/8.json`]: `${JSON.stringify({
          pid: 8,
          url: URL_FOR_PORT(1234),
          sessionId: 'session-a',
          cwd: '/tmp',
          planPath: null,
          startedAt: FAKE_NOW,
          somethingNew: { nested: true },
        })}\n`,
      },
    })
    expect(listPending(fake.io)).toEqual([
      {
        pid: 8,
        url: URL_FOR_PORT(1234),
        sessionId: 'session-a',
        cwd: '/tmp',
        planPath: null,
        startedAt: FAKE_NOW,
      },
    ])
  })

  it('returns nothing when the directory does not exist', () => {
    expect(listPending(fakePendingIO({ listDirFails: true }).io)).toEqual([])
  })
})
