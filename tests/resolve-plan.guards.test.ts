import { describe, expect, it } from 'vitest'

import { resolvePlan } from '../src/cli/resolve-plan'
import {
  fixture,
  makeIO,
  makePayload,
  parseHookPayload,
  toolUseLine,
  FIXTURE_PLAN_PATH,
  HOME,
  TRANSCRIPT_PATH,
} from './helpers/resolve-plan-io'

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('resolvePlan — trust boundary and empty files', () => {
  it('rejects a planFilePath in a directory that merely starts with "plans"', () => {
    // The guard is `expanded.startsWith(plansDir + sep)`. Drop the separator
    // and ~/.claude/plans-backup/ or a file literally named plans.md becomes a
    // legal target — and the resolved path is later written back to on
    // approve-with-edits, so a hook input would pick the write destination.
    for (const escape of [
      `${HOME}/.claude/plans-backup/evil.md`,
      `${HOME}/.claude/plansX/evil.md`,
      `${HOME}/.claude/plans.md`,
      `${HOME}/.claude/plans/../../evil.md`,
    ]) {
      const io = makeIO({ [escape]: '# evil' })
      const payload = makePayload({ tool_input: { planFilePath: escape } })
      expect({ escape, plan: resolvePlan(payload, io) }).toEqual({
        escape,
        plan: { source: 'none' },
      })
    }
  })

  it('rejects a plan path inside the plans dir that is not markdown', () => {
    const target = `${HOME}/.claude/plans/notes.txt`
    const io = makeIO({ [target]: 'not a plan' })
    const payload = makePayload({ tool_input: { planFilePath: target } })
    expect(resolvePlan(payload, io)).toEqual({ source: 'none' })
  })

  it('resolves the shipped hook-payload fixture against the shipped transcript fixture', () => {
    // fixtures/hook-payload.json is what `milkplan test-fire --payload` feeds
    // in and what the e2e suite pipes to the built CLI; pinning it here means
    // a drift in either fixture fails fast in a unit test instead of in a
    // spawned process.
    const payload = parseHookPayload(fixture('hook-payload.json'))
    const io = makeIO({
      [payload.transcript_path]: fixture('transcript.jsonl'),
      [FIXTURE_PLAN_PATH]: '# Plan on disk',
    })
    expect(resolvePlan(payload, io)).toEqual({
      source: 'file',
      path: FIXTURE_PLAN_PATH,
      markdown: '# Plan on disk',
    })
  })

  it('treats an empty plan file as unreadable rather than opening a blank review', () => {
    // '' is not null, so before this guard a truncated or half-written plan
    // file beat a perfectly good tool_input.plan and the review opened empty —
    // with the user's only recourse being to skip.
    const io = makeIO({
      [`${HOME}/.claude/plans/empty.md`]: '   \n',
    })
    const payload = makePayload({
      tool_input: {
        planFilePath: `${HOME}/.claude/plans/empty.md`,
        plan: '# Inline plan',
      },
    })
    expect(resolvePlan(payload, io)).toEqual({
      source: 'inline',
      markdown: '# Inline plan',
    })
  })

  it('keeps scanning past an empty plan file to an earlier, non-empty one', () => {
    const transcript = [
      toolUseLine('Write', `${HOME}/.claude/plans/older.md`),
      toolUseLine('Write', `${HOME}/.claude/plans/blank.md`),
    ].join('\n')
    const io = makeIO({
      [TRANSCRIPT_PATH]: transcript,
      [`${HOME}/.claude/plans/older.md`]: '# older',
      [`${HOME}/.claude/plans/blank.md`]: '',
    })
    expect(resolvePlan(makePayload(), io)).toEqual({
      source: 'file',
      path: `${HOME}/.claude/plans/older.md`,
      markdown: '# older',
    })
  })
})
