import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
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

/** Starts a hook review inside a fresh sandbox and returns its URL. */
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

async function pendingFiles(home: string): Promise<string[]> {
  try {
    return await readdir(join(home, '.claude', 'milkplan', 'pending'))
  } catch {
    return []
  }
}

/**
 * Waits for the registry to reach `count` entries.
 *
 * The hook logs its URL and registers on the next statement, but those are two
 * processes: stderr arriving here does not mean the write has landed. Polling
 * is the honest way to observe another process's filesystem effect.
 */
function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms)
  })
}

async function waitForPendingCount(
  home: string,
  count: number,
  attemptsLeft = 100,
): Promise<string[]> {
  const files = await pendingFiles(home)
  if (files.length === count || attemptsLeft === 0) return files
  await delay(20)
  return waitForPendingCount(home, count, attemptsLeft - 1)
}

// oxlint-disable-next-line eslint/max-lines-per-function -- suite groups many independent `it` cases; splitting the describe would only fragment coverage.
describe('milkplan open — end to end through the built CLI', () => {
  // Only ever `--print` here. The command deliberately overrides
  // MILKPLAN_OPEN, so the sandbox's MILKPLAN_NO_BROWSER is the single thing
  // standing between a bare `open` and a real browser window on the machine
  // running `pnpm test`.
  it('reports nothing waiting, and fails, against an empty registry', async () => {
    const box = await makeSandbox(PLAN)
    sandbox = box

    const run = runCli(['open', '--print'], box.home)
    const code = await run.done

    expect(code).toBe(1)
    expect(run.stdout()).toBe('')
    expect(run.stderr()).toContain('no plan review is waiting')
  })

  it('finds a live review registered by the hook and prints its URL', async () => {
    const { run, url, box } = await startReview()

    // The hook registers the review once the server is listening.
    expect(await waitForPendingCount(box.home, 1)).toHaveLength(1)

    const open = runCli(['open', '--print'], box.home)
    expect(await open.done).toBe(0)
    expect(open.stdout().trim()).toBe(url)

    await postTo(url, '/api/skip', {})
    await run.done
  }, 15_000)

  // SIGHUP is what a closing terminal sends, and Node's default for an
  // unhandled one terminates without running 'exit' handlers — so nothing but a
  // real process can prove this: fakeHookIO installs no signal handlers, and
  // every other e2e ends its review over HTTP.
  it.skipIf(process.platform === 'win32')(
    'cleans up its entry when the terminal closes (SIGHUP)',
    async () => {
      const { run, box } = await startReview()
      expect(await waitForPendingCount(box.home, 1)).toHaveLength(1)

      run.child.kill('SIGHUP')

      expect(await run.done).toBe(0)
      expect(await waitForPendingCount(box.home, 0)).toEqual([])
    },
    15_000,
  )

  it('prunes the entry once the review is gone', async () => {
    // The probe is what covers the exits an 'exit' handler cannot: here the
    // hook exits cleanly, so this also proves the handler ran.
    const { run, url, box } = await startReview()
    await postTo(url, '/api/skip', {})
    await run.done

    expect(await waitForPendingCount(box.home, 0)).toEqual([])

    const open = runCli(['open', '--print'], box.home)
    expect(await open.done).toBe(1)
    expect(open.stderr()).toContain('no plan review is waiting')
  }, 15_000)
})
