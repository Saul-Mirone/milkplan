import { describe, expect, it } from 'vitest'

import { runInit } from '../src/cli/init'
import type { GitResult } from '../src/cli/init-io'
import { fakeInitIO, logged, PROJECT } from './helpers/fake-init-io'

const PROJECT_LOCAL = `${PROJECT}/.claude/settings.local.json`
const EXCLUDE = `${PROJECT}/.git/info/exclude`

/** A git that behaves like a normal repo: file untracked and not ignored. */
function cleanRepo(args: readonly string[]): GitResult {
  const [command] = args
  // `ls-files --error-unmatch` on an untracked path exits 1.
  if (command === 'ls-files') return { status: 1, stdout: '' }
  // `check-ignore -q` exits 1 when the path is not ignored.
  if (command === 'check-ignore') return { status: 1, stdout: '' }
  if (command === 'rev-parse')
    return { status: 0, stdout: '.git/info/exclude\n' }
  throw new Error(`unexpected git command: ${args.join(' ')}`)
}

/** A repo where the machine-local file is already ignored. */
function alreadyIgnored(args: readonly string[]): GitResult {
  return args[0] === 'check-ignore'
    ? { status: 0, stdout: '' }
    : cleanRepo(args)
}

/** A repo where the machine-local file is already tracked. */
function alreadyTracked(args: readonly string[]): GitResult {
  return args[0] === 'ls-files' ? { status: 0, stdout: '' } : cleanRepo(args)
}

/** A directory that is not a git repository at all. */
function notARepo(args: readonly string[]): GitResult {
  return args[0] === 'rev-parse' ? { status: 128, stdout: '' } : cleanRepo(args)
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('runInit --project ignore management', () => {
  it('excludes settings.local.json with a **/ pattern that holds below the repo root', () => {
    // Without the **/ prefix the pattern is anchored at the exclude file's
    // directory, so running init from a subdirectory would leave the file
    // tracked — and it embeds absolute paths from this machine.
    const fake = fakeInitIO({ git: cleanRepo })
    runInit(['--project'], fake.io)

    expect(fake.state.appends).toEqual([
      { path: EXCLUDE, content: '**/.claude/settings.local.json\n' },
    ])
    expect(fake.state.mkdirs).toContain(`${PROJECT}/.git/info`)
    expect(logged(fake.state, 'machine-local file')).toBe(true)
  })

  it('does not append a second time once the file is already ignored', () => {
    const fake = fakeInitIO({
      git: alreadyIgnored,
    })
    runInit(['--project'], fake.io)

    expect(fake.state.appends).toEqual([])
  })

  it('warns instead of editing anything when the machine-local file is already tracked', () => {
    // Appending to .git/info/exclude would not untrack it, so the only useful
    // move is to tell the user the command that will.
    const fake = fakeInitIO({
      git: alreadyTracked,
    })
    runInit(['--project'], fake.io)

    expect(fake.state.appends).toEqual([])
    expect(logged(fake.state, 'is tracked by git')).toBe(true)
    expect(logged(fake.state, 'git rm --cached')).toBe(true)
  })

  it('still registers the hook when the directory is not a git repository', () => {
    const fake = fakeInitIO({
      git: notARepo,
    })
    runInit(['--project'], fake.io)

    expect(fake.state.appends).toEqual([])
    expect(fake.onlyWrite().path).toBe(PROJECT_LOCAL)
    expect(fake.state.failed).toBe(false)
  })

  it('leaves ignores alone when git itself cannot be run', () => {
    // The fake's default git reports a spawn failure.
    const fake = fakeInitIO()
    runInit(['--project'], fake.io)

    expect(fake.state.appends).toEqual([])
    expect(fake.onlyWrite().path).toBe(PROJECT_LOCAL)
    expect(fake.state.failed).toBe(false)
  })
})
