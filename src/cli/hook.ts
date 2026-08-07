import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  HookPayload,
  ResolvedPlan,
  ReviewPayload,
} from '../shared/protocol'
import { buildDecisionOutput } from './feedback'
import { openBrowser } from './open-browser'
import { resolvePlan, type ResolveIO } from './resolve-plan'
import {
  startReviewServer,
  type ReviewSession,
  type RunningServer,
} from './server'

const realIO: ResolveIO = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  homedir,
}

const DEBUG_LOG = join(homedir(), '.claude', 'milkplan.log')

function log(message: string): void {
  const line = `[milkplan] ${message}\n`
  process.stderr.write(line)
  // Hooks run with stderr invisible to the user in interactive sessions; keep a
  // small on-disk trail so "nothing popped up" is diagnosable after the fact.
  try {
    if (existsSync(DEBUG_LOG) && statSync(DEBUG_LOG).size > 256 * 1024)
      writeFileSync(DEBUG_LOG, '')
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}`)
  } catch {
    // Logging must never break the hook.
  }
}

function isHookPayload(value: unknown): value is HookPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'session_id' in value &&
    typeof value.session_id === 'string' &&
    'transcript_path' in value &&
    typeof value.transcript_path === 'string' &&
    'cwd' in value &&
    typeof value.cwd === 'string'
  )
}

function parsePayload(stdinJson: string): HookPayload | null {
  let value: unknown
  try {
    value = JSON.parse(stdinJson)
  } catch {
    return null
  }
  return isHookPayload(value) ? value : null
}

/**
 * Builds the review session. onDecision/onSkip run after the HTTP response is
 * flushed and may terminate the process; `getRunning` defers reading the server
 * handle until then (it is assigned only once the server is listening).
 */
function buildSession(
  // plan and payload are forwarded to buildDecisionOutput and writeFileSync
  // (feedback.ts), whose contracts take the mutable domain types; a readonly
  // parameter here would not be assignable to them.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  plan: Exclude<ResolvedPlan, { source: 'none' }>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  payload: HookPayload,
  getRunning: () => RunningServer | null,
): ReviewSession {
  return {
    payload: {
      plan: plan.markdown,
      meta: {
        planPath: plan.source === 'file' ? plan.path : null,
        cwd: payload.cwd,
        sessionId: payload.session_id,
      },
    } satisfies ReviewPayload,
    token: randomBytes(16).toString('hex'),
    onDecision(decision) {
      if (decision.editedMarkdown !== undefined && plan.source === 'file') {
        try {
          writeFileSync(plan.path, decision.editedMarkdown)
        } catch {
          log(
            `could not write edited plan to ${plan.path}; delivering edits via context only`,
          )
        }
      }
      const output = buildDecisionOutput(
        decision,
        plan,
        payload.tool_input ?? {},
      )
      getRunning()?.close()
      if (output === null) process.exit(0)
      process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0))
    },
    onSkip() {
      getRunning()?.close()
      process.exit(0)
    },
  }
}

/**
 * The hook entry point. Fail-open everywhere: any failure means "print
 * nothing to stdout and exit 0" so Claude Code falls back to its own prompt.
 * Only the final decision JSON ever touches stdout.
 */
export async function runHook(stdinJson: string): Promise<void> {
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  const payload = parsePayload(stdinJson)
  if (payload === null) {
    log('malformed hook payload; passing through')
    process.exit(0)
  }

  log(
    `invoked: event=${payload.hook_event_name ?? '?'} session=${payload.session_id}`,
  )

  const plan = resolvePlan(payload, realIO)
  if (plan.source === 'none') {
    log('no plan found in transcript or tool input; passing through')
    process.exit(0)
  }
  log(
    plan.source === 'file'
      ? `plan resolved from ${plan.path}`
      : 'plan from tool_input',
  )

  let running: RunningServer | null = null
  const session = buildSession(plan, payload, () => running)

  // dist/cli.mjs sits next to dist/ui after build.
  const uiDir = fileURLToPath(new URL('./ui', import.meta.url))
  try {
    running = await startReviewServer(session, uiDir)
  } catch {
    log('review server failed to start; passing through')
    process.exit(0)
  }

  log(`review UI at ${running.url} (open manually if no browser appeared)`)
  openBrowser(running.url)
  // No further code: the listening server keeps the process alive until a
  // decision, a skip, a signal, or the Claude Code hook timeout.
}
