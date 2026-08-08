import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HookPayload } from '../../src/shared/protocol'
import type { DeepReadonly } from '../../src/shared/readonly'

export const CLI = new URL('../../dist/cli.mjs', import.meta.url).pathname

/**
 * Fails with the fix rather than an ENOENT stack when the bundle is missing.
 * CI builds before testing; locally, `pnpm run build` is the missing step.
 */
export async function requireBuiltCli(): Promise<void> {
  try {
    await access(CLI, constants.R_OK)
  } catch {
    throw new Error(
      `dist/cli.mjs is missing — run \`pnpm run build\` first (CI does this before \`pnpm run test\`).`,
    )
  }
}

export interface CliRun {
  child: ChildProcessWithoutNullStreams
  /** Resolves with the exit code once the process is gone. */
  done: Promise<number>
  stdout: () => string
  stderr: () => string
  /** Resolves once `pattern` shows up on stderr, rejecting on early exit. */
  waitForStderr: (pattern: DeepReadonly<RegExp>) => Promise<RegExpExecArray>
}

/**
 * Runs the built CLI with a sandboxed HOME, so nothing here can reach the
 * developer's real ~/.claude. MILKPLAN_NO_BROWSER keeps the review served but
 * unopened — the documented escape hatch, and what makes this drivable
 * headlessly.
 */
export function runCli(
  args: readonly string[],
  home: string,
  stdin?: string,
): CliRun {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MILKPLAN_NO_BROWSER: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const out = collect(child.stdout)
  const err = collect(child.stderr)
  const done = new Promise<number>((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      resolvePromise(code ?? -1)
    })
  })

  if (stdin !== undefined) child.stdin.end(stdin)

  return {
    child,
    done,
    stdout: out,
    stderr: err,
    waitForStderr: (pattern) =>
      watchStderr({
        pattern,
        // Read through getters: `err` keeps growing after this call returns.
        read: err,
        subscribe: (listener) => {
          child.stderr.on('data', listener)
          return () => {
            child.stderr.off('data', listener)
          }
        },
        done,
        dump: () => `--- stderr ---\n${err()}\n--- stdout ---\n${out()}`,
      }),
  }
}

/** Accumulates a stream as utf8, exposing the text so far through a getter. */
function collect(stream: DeepReadonly<Readable>): () => string {
  let text = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    text += chunk
  })
  return () => text
}

interface StderrWatch {
  pattern: DeepReadonly<RegExp>
  read: () => string
  subscribe: (listener: () => void) => () => void
  done: Promise<number>
  dump: () => string
}

/** Resolves on the first match, or rejects if the process exits without one. */
function watchStderr(
  watch: DeepReadonly<StderrWatch>,
): Promise<RegExpExecArray> {
  return new Promise((resolvePromise, reject) => {
    let unsubscribe = () => {}
    const check = () => {
      const match = watch.pattern.exec(watch.read())
      if (match === null) return false
      unsubscribe()
      resolvePromise(match)
      return true
    }
    unsubscribe = watch.subscribe(() => {
      check()
    })
    void watch.done.then((code) => {
      if (!check())
        reject(
          new Error(
            `process exited with ${code} before stderr matched ${watch.pattern.source}\n${watch.dump()}`,
          ),
        )
    })
    check()
  })
}

export interface Sandbox {
  home: string
  planPath: string
  payload: HookPayload
  cleanup: () => Promise<void>
}

/**
 * A fake HOME containing a plan file where resolvePlan will accept it: only
 * paths under <home>/.claude/plans/ are trusted, since the resolved path is
 * later written back to.
 */
export async function makeSandbox(planMarkdown: string): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), 'milkplan-e2e-'))
  const plansDir = join(home, '.claude', 'plans')
  await mkdir(plansDir, { recursive: true })
  const planPath = join(plansDir, 'sunny-rolling-otter.md')
  await writeFile(planPath, planMarkdown)

  return {
    home,
    planPath,
    payload: {
      session_id: 'e2e-session',
      transcript_path: join(home, '.claude', 'missing-transcript.jsonl'),
      cwd: home,
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { planFilePath: planPath },
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  }
}

/** POSTs a decision to a running review, using the token from its URL. */
export async function postTo(
  url: string,
  path: string,
  body: DeepReadonly<Record<string, unknown>>,
): Promise<number> {
  const parsed = new URL(url)
  const token = /token=([^&]+)/u.exec(parsed.hash)?.[1] ?? ''
  const response = await fetch(`${parsed.origin}${path}`, {
    method: 'POST',
    headers: {
      'x-milkplan-token': token,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return response.status
}
