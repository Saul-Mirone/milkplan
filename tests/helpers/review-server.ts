import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  startReviewServer,
  type ReviewSession,
  type RunningServer,
} from '../../src/cli/server'
import {
  TOKEN_HEADER,
  type DecisionRequest,
  type ReviewPayload,
} from '../../src/shared/protocol'
import type { DeepReadonly } from '../../src/shared/readonly'

export const TOKEN = 'test-token-0123456789abcdef'

export const reviewPayload: ReviewPayload = {
  plan: '# Plan under review',
  // Two earlier rounds, the last differing from `plan`, so a round-trip
  // assertion proves history survives the wire rather than echoing the plan.
  history: [
    {
      ts: 1_700_000_000_000,
      round: 1,
      planPath: '/Users/test/.claude/plans/sunny-rolling-otter.md',
      markdown: '# Plan under review (round 1)',
    },
    {
      ts: 1_700_000_060_000,
      round: 2,
      planPath: '/Users/test/.claude/plans/sunny-rolling-otter.md',
      markdown: '# Plan under review (round 2)',
    },
  ],
  meta: {
    planPath: '/Users/test/.claude/plans/sunny-rolling-otter.md',
    cwd: '/Users/test/project',
    sessionId: 'test-session',
  },
}

export const JSON_HEADERS: Readonly<Record<string, string>> = {
  [TOKEN_HEADER]: TOKEN,
  'content-type': 'application/json',
}

export interface Booted {
  base: string
  server: RunningServer
  uiDir: string
}

export interface Booter {
  boot: (overrides?: DeepReadonly<Partial<ReviewSession>>) => Promise<Booted>
  cleanupAll: () => Promise<void>
}

/**
 * Each test file owns its own booter and registers `cleanupAll` in an
 * afterEach, so servers and temp dirs never leak between files.
 */
export function createBooter(): Booter {
  const cleanups: Array<() => Promise<void> | void> = []

  return {
    async boot(overrides = {}) {
      const uiDir = await mkdtemp(join(tmpdir(), 'milkplan-ui-'))
      cleanups.push(() => rm(uiDir, { recursive: true, force: true }))
      await writeFile(
        join(uiDir, 'index.html'),
        '<!doctype html><h1>milkplan test ui</h1>',
      )
      const session: ReviewSession = {
        payload: reviewPayload,
        token: TOKEN,
        onDecision: () => {},
        onSkip: () => {},
        ...overrides,
      }
      const server = await startReviewServer(session, uiDir)
      cleanups.push(() => {
        server.close()
      })
      return { base: new URL(server.url).origin, server, uiDir }
    },
    async cleanupAll() {
      // Teardown steps are independent (closing servers, removing temp dirs),
      // so run them together instead of awaiting each sequentially in a loop.
      const pending = cleanups
        .splice(0)
        .reverse()
        .map((cleanup) => Promise.resolve(cleanup()))
      await Promise.all(pending)
    },
  }
}

export interface RawResponse {
  readonly status: number
  readonly body: string
}

export interface RawOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

/**
 * `fetch` silently drops a caller-supplied `Host` header — it always sends the
 * authority it dialled — so the server's loopback guard is unreachable through
 * it. Only a raw node:http request can put an arbitrary Host on the wire.
 */
export function raw(
  base: string,
  path: string,
  options: DeepReadonly<RawOptions> = {},
): Promise<RawResponse> {
  const url = new URL(path, base)
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? 'GET',
        headers: { ...options.headers },
      },
      (res: DeepReadonly<IncomingMessage>) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          data += chunk
        })
        res.on('end', () => {
          resolvePromise({ status: res.statusCode ?? 0, body: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** A well-formed decision body, with individual fields overridable. */
export function decisionBody(
  overrides: DeepReadonly<Partial<DecisionRequest>> = {},
): string {
  return JSON.stringify({
    action: 'approve',
    annotations: [],
    overallFeedback: '',
    ...overrides,
  })
}

/**
 * A decision body carrying values the DecisionRequest type forbids — the whole
 * point of the validator is that such bodies arrive over HTTP anyway.
 */
export function untypedDecisionBody(
  extra: DeepReadonly<Record<string, unknown>>,
): string {
  return JSON.stringify({
    action: 'approve',
    annotations: [],
    overallFeedback: '',
    ...extra,
  })
}
