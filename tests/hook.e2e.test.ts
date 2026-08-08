import { readFile } from 'node:fs/promises'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  makeSandbox,
  postTo,
  requireBuiltCli,
  runCli,
  type Sandbox,
} from './helpers/cli-process'

const PLAN = '# Original plan\n\nStep one.\n'
const URL_LINE = /review UI at (\S+)/u

let sandbox: Sandbox | null = null

beforeAll(requireBuiltCli)

afterEach(async () => {
  await sandbox?.cleanup()
  sandbox = null
})

async function startReview(): Promise<{
  run: ReturnType<typeof runCli>
  url: string
  box: Sandbox
}> {
  const box = await makeSandbox(PLAN)
  sandbox = box
  const run = runCli([], box.home, JSON.stringify(box.payload))
  const match = await run.waitForStderr(URL_LINE)
  const url = match[1]
  if (url === undefined) throw new Error('no review URL on stderr')
  return { run, url, box }
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
