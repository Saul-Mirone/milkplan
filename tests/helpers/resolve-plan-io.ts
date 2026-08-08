import { readFileSync } from 'node:fs'

import type { ResolveIO } from '../../src/cli/resolve-plan'
import type { HookPayload } from '../../src/shared/protocol'
import type { DeepReadonly } from '../../src/shared/readonly'

export const HOME = '/Users/test'
export const TRANSCRIPT_PATH = `${HOME}/.claude/projects/session.jsonl`
export const FIXTURE_PLAN_PATH = `${HOME}/.claude/plans/sunny-rolling-otter.md`

export function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/${name}`, import.meta.url),
    'utf8',
  )
}

export function makeIO(files: DeepReadonly<Record<string, string>>): ResolveIO {
  return {
    readFile: (path) => files[path] ?? null,
    homedir: () => HOME,
  }
}

export function makePayload(
  overrides: DeepReadonly<Partial<HookPayload>> = {},
): HookPayload {
  return {
    session_id: 'test-session',
    transcript_path: TRANSCRIPT_PATH,
    cwd: `${HOME}/project`,
    ...overrides,
  }
}

/**
 * Narrows the on-disk fixture without an assertion: if the fixture ever stops
 * being a usable hook payload, this throws with the reason rather than letting
 * a silently-wrong object flow into resolvePlan.
 */
export function parseHookPayload(json: string): HookPayload {
  const value: unknown = JSON.parse(json)
  if (typeof value !== 'object' || value === null)
    throw new Error('hook payload fixture is not an object')
  const record: Record<string, unknown> = { ...value }
  const { session_id: sessionId, transcript_path: transcriptPath, cwd } = record
  if (
    typeof sessionId !== 'string' ||
    typeof transcriptPath !== 'string' ||
    typeof cwd !== 'string'
  )
    throw new Error('hook payload fixture is missing a required string field')
  return {
    ...record,
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
  }
}

export function toolUseLine(name: 'Write' | 'Edit', filePath: string): string {
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
