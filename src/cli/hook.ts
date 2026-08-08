import { randomBytes } from 'node:crypto'

import { buildDecisionOutput, editedMarkdownOf } from './feedback'
import { realHookIO, type HookIO } from './hook-io'
import type { ReviewSession, RunningServer } from './server'
import type {
  HookPayload,
  ResolvedPlan,
  ReviewPayload,
} from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'

/** A plan that actually exists — the only kind a review can be built around. */
export type FoundPlan = Exclude<ResolvedPlan, { source: 'none' }>

export function isHookPayload(value: unknown): value is HookPayload {
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

export function parsePayload(stdinJson: string): HookPayload | null {
  let value: unknown
  try {
    value = JSON.parse(stdinJson)
  } catch {
    return null
  }
  return isHookPayload(value) ? value : null
}

/**
 * Persists the user's edits back to the plan file, if there are any.
 *
 * Goes through editedMarkdownOf rather than reading decision.editedMarkdown
 * directly: a blank edit must never truncate the plan file. The UI guards this
 * too, but the server accepts a decision from anything holding the token and
 * this write is irreversible.
 */
function writeEditedPlan(
  planPath: string | null,
  edited: string | undefined,
  io: DeepReadonly<HookIO>,
): void {
  if (edited === undefined || planPath === null) return
  try {
    io.writePlanFile(planPath, edited)
  } catch {
    io.log(
      `could not write edited plan to ${planPath}; delivering edits via context only`,
    )
  }
}

/**
 * Returns a guard that admits the first caller and turns every later one away.
 *
 * handleApiRequest is stateless and server.close() only stops NEW connections —
 * an established keep-alive socket keeps being served — so a duplicated tab
 * (both carry the same #token= fragment) can land a second decision in the
 * window between the first stdout write and the exit inside its flush
 * callback. That would write the plan file twice and put two JSON lines on
 * stdout, which is an unparseable hook response: Claude Code discards the
 * whole review. Ignoring the straggler is the fail-safe answer, and the
 * process is on its way out either way.
 */
function oneAnswer(onSettle: () => void): () => boolean {
  let answered = false
  return () => {
    if (answered) return false
    answered = true
    onSettle()
    return true
  }
}

export interface SessionDeps {
  plan: FoundPlan
  payload: HookPayload
  /** Deferred: the handle exists only once the server is listening. */
  getRunning: () => RunningServer | null
  onSettle: () => void
  io: DeepReadonly<HookIO>
}

/**
 * Builds the review session. onDecision/onSkip run after the HTTP response is
 * flushed and may terminate the process.
 */
export function buildSession(
  // plan and payload are forwarded to buildDecisionOutput (feedback.ts), whose
  // contract takes the mutable domain types; a readonly parameter here would
  // not be assignable to them.
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  deps: SessionDeps,
): ReviewSession {
  const { plan, payload, getRunning, onSettle, io } = deps
  const claim = oneAnswer(onSettle)
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
      if (!claim()) return
      writeEditedPlan(
        plan.source === 'file' ? plan.path : null,
        editedMarkdownOf(decision),
        io,
      )
      const output = buildDecisionOutput(
        decision,
        plan,
        payload.tool_input ?? {},
      )
      getRunning()?.close()
      // Exit only from inside the flush callback: a >64 KiB additionalContext
      // does not fit one pipe write, and exiting early truncates the JSON.
      io.writeStdout(`${JSON.stringify(output)}\n`, () => io.exit(0))
    },
    onSkip() {
      if (!claim()) return
      getRunning()?.close()
      io.exit(0)
    },
  }
}

/**
 * Last resort for the case detection cannot see: every launcher was missing, so
 * nothing opened and nobody is coming. WSL with interop disabled is the classic
 * one. `isSettled` guards the (vanishingly small) window where a decision is
 * already in flight.
 */
export function passThroughOnLaunchFailure(
  running: DeepReadonly<{ close: () => void }>,
  isSettled: () => boolean,
  io: DeepReadonly<HookIO>,
): () => void {
  return () => {
    if (isSettled()) return
    io.log('every browser launcher failed to start; passing through')
    try {
      running.close()
    } catch {
      // Runs inside a spawn error handler, where a throw would be an uncaught
      // exception rather than a passthrough. Exiting matters more than closing.
    }
    io.exit(0)
  }
}

/** Parses the hook payload, passing through when it is not one. */
function parsePayloadOrPassThrough(
  stdinJson: string,
  io: DeepReadonly<HookIO>,
): HookPayload {
  const payload = parsePayload(stdinJson)
  if (payload === null) {
    io.log('malformed hook payload; passing through')
    io.exit(0)
  }
  io.log(
    `invoked: event=${payload.hook_event_name ?? '?'} session=${payload.session_id}`,
  )
  return payload
}

/** Locates the plan, passing through when there is nothing to review. */
function resolvePlanOrPassThrough(
  payload: DeepReadonly<HookPayload>,
  io: DeepReadonly<HookIO>,
): FoundPlan {
  const plan = io.resolve(payload)
  if (plan.source === 'none') {
    io.log('no plan found in transcript or tool input; passing through')
    io.exit(0)
  }
  io.log(
    plan.source === 'file'
      ? `plan resolved from ${plan.path}`
      : 'plan from tool_input',
  )
  return plan
}

/**
 * Resolves how a browser can be opened here, passing through when none can be.
 * Called before the server binds: with no reachable UI there is no point
 * holding a port, and exiting here is what keeps a headless box from parking
 * Claude Code on a listening socket until the hook timeout.
 */
function browserSupportOrPassThrough(io: DeepReadonly<HookIO>) {
  const support = io.browserSupport()
  if (support.kind === 'unavailable') {
    // The port does not exist yet, so this log line is the user's only pointer
    // back to a review: name the escape hatch rather than just the verdict.
    io.log(
      `no way to open a browser (${support.reason}); passing through — set MILKPLAN_NO_BROWSER=1 to serve the review anyway and open it yourself`,
    )
    io.exit(0)
  }
  return support
}

/**
 * The hook entry point. Fail-open everywhere: any failure means "print
 * nothing to stdout and exit 0" so Claude Code falls back to its own prompt.
 * Only the final decision JSON ever touches stdout.
 */
export async function runHook(
  stdinJson: string,
  io: DeepReadonly<HookIO> = realHookIO,
): Promise<void> {
  io.onSignal(() => io.exit(0))

  const payload = parsePayloadOrPassThrough(stdinJson, io)
  const plan = resolvePlanOrPassThrough(payload, io)
  const support = browserSupportOrPassThrough(io)

  let running: RunningServer | null = null
  let settled = false
  const session = buildSession({
    plan,
    payload,
    getRunning: () => running,
    onSettle: () => {
      settled = true
    },
    io,
  })

  try {
    running = await io.startServer(session)
  } catch {
    io.log('review server failed to start; passing through')
    io.exit(0)
  }

  io.log(`review UI at ${running.url} (open manually if no browser appeared)`)
  io.launch(
    running.url,
    support,
    passThroughOnLaunchFailure(running, () => settled, io),
  )
  // No further code: the listening server keeps the process alive until a
  // decision, a skip, a signal, or the Claude Code hook timeout.
}
