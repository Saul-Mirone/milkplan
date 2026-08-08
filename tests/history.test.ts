import { describe, expect, it } from 'vitest'

import {
  historyDirFor,
  historyFileFor,
  MAX_ROUNDS,
  parseHistory,
  recordRound,
} from '../src/cli/history'
import type { PlanVersion } from '../src/shared/protocol'
import type { DeepReadonly } from '../src/shared/readonly'
import { fakeHistoryIO, FAKE_NOW, HOME } from './helpers/fake-history-io'

const SESSION = 'test-session'
const DIR = historyDirFor(HOME)
const FILE = historyFileFor(HOME, SESSION)
const PLAN_PATH = '/Users/dev/.claude/plans/sunny-rolling-otter.md'

function input(markdown: string, planPath: string | null = PLAN_PATH) {
  return { sessionId: SESSION, planPath, markdown }
}

function version(ts: number, markdown: string, round = 1): PlanVersion {
  return { ts, round, planPath: PLAN_PATH, markdown }
}

function fileOf(versions: DeepReadonly<PlanVersion[]>): string {
  return versions.map((entry) => `${JSON.stringify(entry)}\n`).join('')
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('recordRound — persistence', () => {
  it('creates the directory and appends exactly one JSONL line on the first round', () => {
    // No file yet means readFile returns null, which must read as "first
    // round", not as an error.
    const fake = fakeHistoryIO()
    const result = recordRound(input('# Plan'), fake.io)

    const current = version(FAKE_NOW, '# Plan')
    expect(result).toEqual([current])
    expect(fake.state.mkdirs).toEqual([DIR])
    expect(fake.state.appends).toEqual([
      { path: FILE, content: `${JSON.stringify(current)}\n` },
    ])
    expect(fake.state.logs).toEqual([])
  })

  it('round-trips a null planPath for an inline plan', () => {
    const fake = fakeHistoryIO()
    recordRound(input('# Inline round', null), fake.io)
    const result = recordRound(input('# Inline round, revised', null), fake.io)

    expect(result).toEqual([
      { ts: FAKE_NOW, round: 1, planPath: null, markdown: '# Inline round' },
      {
        ts: FAKE_NOW,
        round: 2,
        planPath: null,
        markdown: '# Inline round, revised',
      },
    ])
  })

  it('accumulates rounds oldest to newest with the current round last', () => {
    const fake = fakeHistoryIO()
    recordRound(input('# One'), fake.io)
    recordRound(input('# Two'), fake.io)
    const result = recordRound(input('# Three'), fake.io)

    expect(
      result.map((entry: DeepReadonly<PlanVersion>) => entry.markdown),
    ).toEqual(['# One', '# Two', '# Three'])
    expect(
      result.map((entry: DeepReadonly<PlanVersion>) => entry.round),
    ).toEqual([1, 2, 3])
  })
})

describe('recordRound — dedupe', () => {
  it('collapses a consecutive duplicate, keeping the original ts and skipping the append', () => {
    const prior = version(111, '# Same plan')
    const fake = fakeHistoryIO({ files: { [FILE]: fileOf([prior]) } })
    const result = recordRound(input('# Same plan'), fake.io)

    expect(result).toEqual([prior])
    expect(fake.state.appends).toEqual([])
    expect(fake.state.mkdirs).toEqual([])
  })

  it('treats a CRLF-only difference as the same round', () => {
    const prior = version(111, '# Same\n\nBody\n')
    const fake = fakeHistoryIO({ files: { [FILE]: fileOf([prior]) } })
    const result = recordRound(input('# Same\r\n\r\nBody\r\n'), fake.io)

    expect(result).toEqual([prior])
    expect(fake.state.appends).toEqual([])
  })

  it('records A→B→A as three rounds — only consecutive duplicates collapse', () => {
    const fake = fakeHistoryIO()
    recordRound(input('# A'), fake.io)
    recordRound(input('# B'), fake.io)
    const result = recordRound(input('# A'), fake.io)

    expect(
      result.map((entry: DeepReadonly<PlanVersion>) => entry.markdown),
    ).toEqual(['# A', '# B', '# A'])
    expect(
      result.map((entry: DeepReadonly<PlanVersion>) => entry.round),
    ).toEqual([1, 2, 3])
    expect(fake.state.appends).toHaveLength(3)
  })
})

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('recordRound — resilience', () => {
  it('skips broken lines, keeps the good ones, and appends as usual', () => {
    // A torn concurrent append costs at most the line it tore.
    const good = version(1, '# Round 1')
    const raw = `${[
      'not json at all',
      '42',
      'null',
      JSON.stringify({ ts: 'nan', round: 1, planPath: null, markdown: 'x' }),
      JSON.stringify({ ts: 2, round: 1, planPath: 7, markdown: 'x' }),
      JSON.stringify({ ts: 3, round: 1, planPath: null }),
      // A round-less line is a wrong shape too, not a fallback case.
      JSON.stringify({ ts: 4, planPath: null, markdown: 'x' }),
      JSON.stringify(good).slice(0, 12),
      '',
      JSON.stringify(good),
    ].join('\n')}\n`
    const fake = fakeHistoryIO({ files: { [FILE]: raw } })
    const result = recordRound(input('# Round 2'), fake.io)

    expect(result).toEqual([good, version(FAKE_NOW, '# Round 2', 2)])
    expect(fake.state.appends).toHaveLength(1)
  })

  it('still returns prior plus current when mkdir throws, logging exactly once', () => {
    const prior = version(1, '# Round 1')
    const fake = fakeHistoryIO({
      files: { [FILE]: fileOf([prior]) },
      mkdirFails: true,
    })
    const result = recordRound(input('# Round 2'), fake.io)

    expect(result).toEqual([prior, version(FAKE_NOW, '# Round 2', 2)])
    expect(fake.state.logs).toHaveLength(1)
    expect(fake.state.logs[0]).toContain('could not persist plan history')
  })

  it('still returns the current round when the append throws, logging exactly once', () => {
    const fake = fakeHistoryIO({ appendFails: true })
    const result = recordRound(input('# Plan'), fake.io)

    expect(result).toEqual([version(FAKE_NOW, '# Plan')])
    expect(fake.state.logs).toHaveLength(1)
    expect(fake.state.logs[0]).toContain('could not persist plan history')
  })
})

describe('recordRound — session id validation', () => {
  it('refuses a path-shaped session id with zero disk IO, one log, and the current round', () => {
    // The id becomes a file name; anything path-like must never touch disk.
    for (const sessionId of ['../../etc/passwd', 'a/b', '']) {
      const fake = fakeHistoryIO()
      const result = recordRound(
        { sessionId, planPath: PLAN_PATH, markdown: '# Plan' },
        fake.io,
      )

      expect(result).toEqual([version(FAKE_NOW, '# Plan')])
      expect(fake.state.appends).toEqual([])
      expect(fake.state.mkdirs).toEqual([])
      expect(fake.state.removed).toEqual([])
      expect(fake.state.logs).toHaveLength(1)
    }
  })

  it('uses a well-formed session id verbatim as the file name', () => {
    for (const sessionId of [
      'b3c31f52-1c95-4c6e-8b3e-0a1b2c3d4e5f',
      'milkplan-test-fire',
    ]) {
      const fake = fakeHistoryIO()
      recordRound({ sessionId, planPath: null, markdown: '# Plan' }, fake.io)

      expect(
        fake.state.appends.map(
          (append: DeepReadonly<{ path: string }>) => append.path,
        ),
      ).toEqual([historyFileFor(HOME, sessionId)])
    }
  })
})

describe('recordRound — round cap', () => {
  it('returns only the newest MAX_ROUNDS when a duplicate lands on an overlong file', () => {
    const rounds = Array.from({ length: MAX_ROUNDS + 1 }, (_, i) =>
      version(i + 1, `# Round ${i + 1}`, i + 1),
    )
    const fake = fakeHistoryIO({ files: { [FILE]: fileOf(rounds) } })
    const result = recordRound(input(`# Round ${MAX_ROUNDS + 1}`), fake.io)

    expect(result).toHaveLength(MAX_ROUNDS)
    expect(result[0]).toEqual(rounds[1])
    expect(result.at(-1)).toEqual(rounds.at(-1))
  })

  it('returns only the newest MAX_ROUNDS when appending past the cap, keeping stored round numbers', () => {
    // The slice happens at read time; the file itself is never rewritten, so
    // the surviving entries keep their recorded round numbers.
    const rounds = Array.from({ length: MAX_ROUNDS }, (_, i) =>
      version(i + 1, `# Round ${i + 1}`, i + 1),
    )
    const fake = fakeHistoryIO({ files: { [FILE]: fileOf(rounds) } })
    const result = recordRound(input('# Fresh round'), fake.io)

    expect(result).toHaveLength(MAX_ROUNDS)
    expect(result[0]).toEqual(rounds[1])
    expect(result.at(-1)).toEqual(
      version(FAKE_NOW, '# Fresh round', MAX_ROUNDS + 1),
    )
    expect(fake.state.appends).toHaveLength(1)
  })
})

// Pruning behavior lives in tests/history.pruning.test.ts.

describe('parseHistory', () => {
  it('parses well-formed JSONL in order', () => {
    const rounds = [version(1, '# Round 1'), version(2, '# Round 2', 2)]
    expect(parseHistory(fileOf(rounds))).toEqual(rounds)
  })

  it('returns nothing for an empty or blank-only file', () => {
    expect(parseHistory('')).toEqual([])
    expect(parseHistory('\n\n  \n')).toEqual([])
  })

  it('skips every malformed line while keeping its neighbors', () => {
    const good = version(1, '# Round 1')
    const raw = [
      JSON.stringify(good),
      'garbage',
      '[]',
      'true',
      // JSON has no Infinity literal, but 1e999 parses to one — a non-finite
      // ts must not survive into the versions.
      '{"ts":1e999,"round":1,"planPath":null,"markdown":"x"}',
      JSON.stringify({ ts: 2, round: 1, planPath: PLAN_PATH, markdown: 42 }),
      JSON.stringify({ ts: 3, planPath: null, markdown: 'no round' }),
      JSON.stringify({ ts: 4, round: '4', planPath: null, markdown: 'x' }),
      JSON.stringify(good).slice(0, 8),
    ].join('\n')

    expect(parseHistory(raw)).toEqual([good])
  })
})
