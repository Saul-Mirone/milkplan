import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { resolvePlan, type ResolveIO } from '../src/cli/resolve-plan'
import type { HookPayload } from '../src/shared/protocol'
import type { DeepReadonly } from '../src/shared/readonly'

const HOME = '/Users/test'
const TRANSCRIPT_PATH = `${HOME}/.claude/projects/session.jsonl`
const FIXTURE_PLAN_PATH = `${HOME}/.claude/plans/sunny-rolling-otter.md`

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
}

function makeIO(files: DeepReadonly<Record<string, string>>): ResolveIO {
  return {
    readFile: (path) => files[path] ?? null,
    homedir: () => HOME,
  }
}

function makePayload(
  overrides: DeepReadonly<Partial<HookPayload>> = {},
): HookPayload {
  return {
    session_id: 'test-session',
    transcript_path: TRANSCRIPT_PATH,
    cwd: `${HOME}/project`,
    ...overrides,
  }
}

function toolUseLine(name: 'Write' | 'Edit', filePath: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_x',
          name,
          input: { file_path: filePath, content: 'stale transcript fragment' },
        },
      ],
    },
  })
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('resolvePlan', () => {
  it('prefers tool_input.planFilePath over transcript scanning', () => {
    const io = makeIO({
      [TRANSCRIPT_PATH]: toolUseLine('Write', `${HOME}/.claude/plans/old.md`),
      [`${HOME}/.claude/plans/old.md`]: '# Old plan\n',
      [`${HOME}/.claude/plans/direct.md`]: '# Direct plan\n',
    })
    const payload = makePayload({
      tool_input: { planFilePath: `${HOME}/.claude/plans/direct.md` },
    })
    expect(resolvePlan(payload, io)).toEqual({
      source: 'file',
      path: `${HOME}/.claude/plans/direct.md`,
      markdown: '# Direct plan\n',
    })
  })

  it('rejects a planFilePath outside ~/.claude/plans and falls through', () => {
    const io = makeIO({
      [`${HOME}/secrets.md`]: 'not a plan',
    })
    const payload = makePayload({
      tool_input: { planFilePath: `${HOME}/secrets.md`, plan: '# Inline\n' },
    })
    expect(resolvePlan(payload, io)).toEqual({
      source: 'inline',
      markdown: '# Inline\n',
    })
  })

  it('falls back to the transcript when planFilePath is unreadable', () => {
    const io = makeIO({
      [TRANSCRIPT_PATH]: toolUseLine('Write', `${HOME}/.claude/plans/a.md`),
      [`${HOME}/.claude/plans/a.md`]: '# From transcript\n',
    })
    const payload = makePayload({
      tool_input: { planFilePath: `${HOME}/.claude/plans/deleted.md` },
    })
    expect(resolvePlan(payload, io)).toEqual({
      source: 'file',
      path: `${HOME}/.claude/plans/a.md`,
      markdown: '# From transcript\n',
    })
  })

  it('finds the plan via a Write entry and returns the disk content', () => {
    const io = makeIO({
      [TRANSCRIPT_PATH]: toolUseLine('Write', `${HOME}/.claude/plans/a.md`),
      [`${HOME}/.claude/plans/a.md`]: '# Disk content\n',
    })
    expect(resolvePlan(makePayload(), io)).toEqual({
      source: 'file',
      path: `${HOME}/.claude/plans/a.md`,
      markdown: '# Disk content\n',
    })
  })

  it('reads disk (not the transcript fragment) for the fixture transcript, skipping malformed lines', () => {
    // The fixture's newest plan reference is an Edit entry that only carries
    // old_string/new_string, preceded by a malformed line; the returned
    // markdown must be the disk content, never the Write entry fragment.
    const io = makeIO({
      [TRANSCRIPT_PATH]: fixture('transcript.jsonl'),
      [FIXTURE_PLAN_PATH]: '# Fresh disk content\n',
    })
    expect(resolvePlan(makePayload(), io)).toEqual({
      source: 'file',
      path: FIXTURE_PLAN_PATH,
      markdown: '# Fresh disk content\n',
    })
  })

  it('prefers the most recent plan reference', () => {
    const transcript = [
      toolUseLine('Write', `${HOME}/.claude/plans/older.md`),
      toolUseLine('Write', `${HOME}/.claude/plans/newer.md`),
    ].join('\n')
    const io = makeIO({
      [TRANSCRIPT_PATH]: transcript,
      [`${HOME}/.claude/plans/older.md`]: '# older',
      [`${HOME}/.claude/plans/newer.md`]: '# newer',
    })
    expect(resolvePlan(makePayload(), io)).toEqual({
      source: 'file',
      path: `${HOME}/.claude/plans/newer.md`,
      markdown: '# newer',
    })
  })

  it('falls back to an earlier entry when the newest plan file is unreadable', () => {
    const transcript = [
      toolUseLine('Write', `${HOME}/.claude/plans/older.md`),
      toolUseLine('Write', `${HOME}/.claude/plans/gone.md`),
    ].join('\n')
    const io = makeIO({
      [TRANSCRIPT_PATH]: transcript,
      [`${HOME}/.claude/plans/older.md`]: '# older',
    })
    expect(resolvePlan(makePayload(), io)).toEqual({
      source: 'file',
      path: `${HOME}/.claude/plans/older.md`,
      markdown: '# older',
    })
  })

  it('expands a leading ~ against the injected homedir', () => {
    const io = makeIO({
      [TRANSCRIPT_PATH]: toolUseLine('Edit', '~/.claude/plans/tilde.md'),
      [`${HOME}/.claude/plans/tilde.md`]: '# via tilde',
    })
    expect(resolvePlan(makePayload(), io)).toEqual({
      source: 'file',
      path: `${HOME}/.claude/plans/tilde.md`,
      markdown: '# via tilde',
    })
  })

  it('rejects paths that resolve outside ~/.claude/plans', () => {
    const io = makeIO({
      [TRANSCRIPT_PATH]: toolUseLine(
        'Write',
        `${HOME}/.claude/plans/../../escape.md`,
      ),
      [`${HOME}/escape.md`]: '# escaped',
    })
    expect(resolvePlan(makePayload(), io)).toEqual({ source: 'none' })
  })

  it('ignores writes outside the plans dir and falls back to inline plan', () => {
    const io = makeIO({
      [TRANSCRIPT_PATH]: fixture('transcript-no-plan.jsonl'),
    })
    const payload = makePayload({ tool_input: { plan: '# Inline plan' } })
    expect(resolvePlan(payload, io)).toEqual({
      source: 'inline',
      markdown: '# Inline plan',
    })
  })

  it('uses the inline plan when the transcript is unreadable', () => {
    const payload = makePayload({ tool_input: { plan: '# Inline plan' } })
    expect(resolvePlan(payload, makeIO({}))).toEqual({
      source: 'inline',
      markdown: '# Inline plan',
    })
  })

  it('returns none when there is no plan entry and no inline plan', () => {
    const io = makeIO({
      [TRANSCRIPT_PATH]: fixture('transcript-no-plan.jsonl'),
    })
    expect(resolvePlan(makePayload(), io)).toEqual({ source: 'none' })
  })

  it('treats an empty inline plan as none', () => {
    const payload = makePayload({ tool_input: { plan: '   ' } })
    expect(resolvePlan(payload, makeIO({}))).toEqual({ source: 'none' })
  })
})
