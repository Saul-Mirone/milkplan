import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  historyDirFor,
  historyFileFor,
  recordRound,
  STALE_AFTER_MS,
} from '../src/cli/history'
import { fakeHistoryIO, FAKE_NOW, HOME } from './helpers/fake-history-io'

const SESSION = 'test-session'
const DIR = historyDirFor(HOME)
const FILE = historyFileFor(HOME, SESSION)
const PLAN_PATH = '/Users/dev/.claude/plans/sunny-rolling-otter.md'

function input(markdown: string) {
  return { sessionId: SESSION, planPath: PLAN_PATH, markdown }
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('recordRound — pruning', () => {
  it('removes a stale sibling session file and keeps a fresh one', () => {
    const stale = join(DIR, 'old-session.jsonl')
    const fresh = join(DIR, 'fresh-session.jsonl')
    const fake = fakeHistoryIO({
      files: { [stale]: '', [fresh]: '' },
      mtimes: {
        [stale]: FAKE_NOW - STALE_AFTER_MS - 1,
        [fresh]: FAKE_NOW - 1000,
      },
    })
    recordRound(input('# Plan'), fake.io)

    expect(fake.state.removed).toEqual([stale])
  })

  it('never removes the current session file, even when it looks stale', () => {
    // A failed append leaves the file's mtime old; pruning it would destroy
    // the very history this round degraded to.
    const round = JSON.stringify({
      ts: 1,
      round: 1,
      planPath: PLAN_PATH,
      markdown: '# Round 1',
    })
    const fake = fakeHistoryIO({
      files: { [FILE]: `${round}\n` },
      mtimes: { [FILE]: FAKE_NOW - STALE_AFTER_MS * 2 },
    })
    recordRound(input('# Round 2'), fake.io)

    expect(fake.state.removed).toEqual([])
  })

  it('skips entries that are not .jsonl files', () => {
    const note = join(DIR, 'README.txt')
    const fake = fakeHistoryIO({
      files: { [note]: 'not a session' },
      mtimes: { [note]: FAKE_NOW - STALE_AFTER_MS * 2 },
    })
    recordRound(input('# Plan'), fake.io)

    expect(fake.state.removed).toEqual([])
  })

  it('skips pruning silently when the directory cannot be listed', () => {
    const fake = fakeHistoryIO({ listDirFails: true })
    recordRound(input('# Plan'), fake.io)

    expect(fake.state.removed).toEqual([])
    expect(fake.state.logs).toEqual([])
  })

  it('skips a sibling silently when its mtime cannot be read', () => {
    const stale = join(DIR, 'old-session.jsonl')
    const fake = fakeHistoryIO({ files: { [stale]: '' } })
    recordRound(input('# Plan'), fake.io)

    expect(fake.state.removed).toEqual([])
    expect(fake.state.logs).toEqual([])
  })
})
