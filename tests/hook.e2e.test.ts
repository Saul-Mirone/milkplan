import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { DeepReadonly } from '../src/shared/readonly'
import {
  getFrom,
  makeSandbox,
  postTo,
  requireBuiltCli,
  runCli,
  type Sandbox,
} from './helpers/cli-process'
import { at } from './helpers/json'

const PLAN = '# Original plan\n\nStep one.\n'
const URL_LINE = /review UI at (\S+)/u

let sandbox: Sandbox | null = null

beforeAll(requireBuiltCli)

afterEach(async () => {
  await sandbox?.cleanup()
  sandbox = null
})

/** Fires the hook again inside an existing sandbox — a later review round. */
async function reviewOn(box: DeepReadonly<Sandbox>): Promise<{
  run: ReturnType<typeof runCli>
  url: string
}> {
  const run = runCli([], box.home, JSON.stringify(box.payload))
  const match = await run.waitForStderr(URL_LINE)
  const url = match[1]
  if (url === undefined) throw new Error('no review URL on stderr')
  return { run, url }
}

async function startReview(): Promise<{
  run: ReturnType<typeof runCli>
  url: string
  box: Sandbox
}> {
  const box = await makeSandbox(PLAN)
  sandbox = box
  return { ...(await reviewOn(box)), box }
}

/** The non-blank lines of the session's history file in `home`. */
async function historyLines(home: string): Promise<string[]> {
  const file = join(home, '.claude', 'milkplan', 'history', 'e2e-session.jsonl')
  const raw = await readFile(file, 'utf8')
  return raw.split('\n').filter((line) => line !== '')
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('milkplan hook — end to end through the built CLI', () => {
  it('writes the edits to disk and answers with exactly one line of hook JSON', async () => {
    // The only test that exercises the real pipe: process.stdout.write plus
    // its flush callback, across a real process boundary. Everything below
    // the CLI is unit-tested, but nothing else proves the bytes arrive whole
    // and the process then exits.
    const { run, url, box } = await startReview()

    expect(
      await postTo(url, '/api/decision', {
        action: 'approve',
        annotations: [],
        overallFeedback: '',
        editedMarkdown: '# Revised plan\n\nStep one, reworked.\n',
      }),
    ).toBe(200)

    expect(await run.done).toBe(0)

    const lines = run.stdout().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe('')
    const output: unknown = JSON.parse(String(lines[0]))
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    })

    expect(await readFile(box.planPath, 'utf8')).toBe(
      '# Revised plan\n\nStep one, reworked.\n',
    )
  }, 15_000)

  it('carries annotations into a deny message and leaves the plan file untouched', async () => {
    const { run, url, box } = await startReview()

    expect(
      await postTo(url, '/api/decision', {
        action: 'request-changes',
        annotations: [
          {
            excerpt: 'Step one',
            comment: 'split this in two',
            orphaned: false,
          },
        ],
        overallFeedback: 'needs more detail',
      }),
    ).toBe(200)

    expect(await run.done).toBe(0)
    const output: unknown = JSON.parse(run.stdout().trim())
    expect(output).toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: 'deny' },
      },
    })
    expect(run.stdout()).toContain('split this in two')
    expect(run.stdout()).toContain('needs more detail')

    // A rejection must not rewrite what the user is still working on.
    expect(await readFile(box.planPath, 'utf8')).toBe(PLAN)
  }, 15_000)

  it('exits silently on skip so Claude Code falls back to its own prompt', async () => {
    const { run, url } = await startReview()

    expect(await postTo(url, '/api/skip', {})).toBe(200)

    expect(await run.done).toBe(0)
    expect(run.stdout()).toBe('')
  }, 15_000)

  it('passes through byte-silently on a malformed payload', async () => {
    // Also the only coverage of the bare-argv dispatch path: no subcommand,
    // payload straight from stdin.
    const box = await makeSandbox(PLAN)
    sandbox = box
    const run = runCli([], box.home, 'not json at all')

    expect(await run.done).toBe(0)
    expect(run.stdout()).toBe('')
    expect(run.stderr()).toContain('malformed hook payload')
  }, 15_000)

  it('passes through when the payload names no reachable plan', async () => {
    const box = await makeSandbox(PLAN)
    sandbox = box
    const run = runCli(
      [],
      box.home,
      JSON.stringify({ ...box.payload, tool_input: {} }),
    )

    expect(await run.done).toBe(0)
    expect(run.stdout()).toBe('')
    expect(run.stderr()).toContain('no plan found')
  }, 15_000)
})

// oxlint-disable-next-line eslint/max-lines-per-function -- the scenario is one causal chain of three runs; splitting it would re-run earlier rounds as setup.
describe('milkplan hook — plan history across rounds', () => {
  // oxlint-disable-next-line eslint/max-lines-per-function -- see the describe: one causal chain of three runs.
  it('persists each submitted round, serves the prior ones, and dedupes a resubmission', async () => {
    const REVISED = '# Revised plan\n\nStep one, tightened.\n'

    // Round 1: reviewed and sent back for changes.
    const { run, url, box } = await startReview()
    expect(
      await postTo(url, '/api/decision', {
        action: 'request-changes',
        annotations: [],
        overallFeedback: 'tighten step one',
      }),
    ).toBe(200)
    expect(await run.done).toBe(0)

    // Claude revises the plan between rounds.
    await writeFile(box.planPath, REVISED)

    // Round 2, same HOME and session_id: history holds exactly round 1.
    const second = await reviewOn(box)
    const review2 = await getFrom(second.url, '/api/review')
    expect(review2.status).toBe(200)
    const payload2: unknown = JSON.parse(review2.body)
    expect(payload2).toMatchObject({
      plan: REVISED,
      history: [{ planPath: box.planPath, markdown: PLAN, round: 1 }],
    })
    expect(typeof at(payload2, 'history', 0, 'ts')).toBe('number')
    expect(await postTo(second.url, '/api/skip', {})).toBe(200)
    expect(await second.run.done).toBe(0)

    // Both rounds are on disk in the sandboxed HOME (which started without
    // the history directory — this is also the mkdir proof), one parseable
    // JSON line each.
    const lines = await historyLines(box.home)
    expect(lines).toHaveLength(2)
    for (const line of lines)
      expect(() => {
        JSON.parse(line)
      }).not.toThrow()

    // Round 3, plan unchanged: the real binary dedupes — history and file
    // both stay as they were.
    const third = await reviewOn(box)
    const review3 = await getFrom(third.url, '/api/review')
    expect(review3.status).toBe(200)
    const payload3: unknown = JSON.parse(review3.body)
    expect(payload3).toMatchObject({
      plan: REVISED,
      history: [{ planPath: box.planPath, markdown: PLAN, round: 1 }],
    })
    expect(await postTo(third.url, '/api/skip', {})).toBe(200)
    expect(await third.run.done).toBe(0)
    expect(await historyLines(box.home)).toHaveLength(2)
  }, 30_000)
})

describe('milkplan test-fire', () => {
  it('reports a missing --payload file instead of crashing with a stack trace', async () => {
    // main() is invoked as `void main()`, so an unguarded readFileSync here
    // surfaced as an unhandled rejection rather than the one-line error
    // every other failure path produces.
    const box = await makeSandbox(PLAN)
    sandbox = box
    const run = runCli(
      ['test-fire', '--payload', '/nope/missing.json'],
      box.home,
    )

    expect(await run.done).toBe(1)
    expect(run.stderr()).toContain('could not read /nope/missing.json')
    expect(run.stderr()).not.toContain('at ')
    expect(run.stdout()).toBe('')
  }, 15_000)

  it('rejects --payload with no path at all', async () => {
    const box = await makeSandbox(PLAN)
    sandbox = box
    const run = runCli(['test-fire', '--payload'], box.home)

    expect(await run.done).toBe(1)
    expect(run.stderr()).toContain('--payload requires a file path')
  }, 15_000)
})

describe('milkplan argv dispatch', () => {
  it('prints help and the version without touching stdin', async () => {
    const box = await makeSandbox(PLAN)
    sandbox = box

    const help = runCli(['--help'], box.home)
    expect(await help.done).toBe(0)
    expect(help.stdout()).toContain('milkplan init')

    const version = runCli(['--version'], box.home)
    expect(await version.done).toBe(0)
    expect(version.stdout().trim()).toMatch(/^\d+\.\d+\.\d+$/u)
  }, 15_000)

  it('fails with the usage text on an unknown command', async () => {
    const box = await makeSandbox(PLAN)
    sandbox = box
    const run = runCli(['frobnicate'], box.home)

    expect(await run.done).toBe(1)
    expect(run.stderr()).toContain('unknown command: frobnicate')
    expect(run.stderr()).toContain('Usage:')
    // Usage on stderr, never stdout: stdout carries only the hook envelope.
    expect(run.stdout()).toBe('')
  }, 15_000)
})
