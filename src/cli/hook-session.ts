import { randomBytes } from 'node:crypto'

import { buildDecisionOutput, editedMarkdownOf } from './feedback'
import type { HookIO } from './hook-io'
import type { ReviewSession, RunningServer } from './server'
import type {
  HookPayload,
  PlanVersion,
  ResolvedPlan,
  ReviewPayload,
} from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'

/** A plan that actually exists — the only kind a review can be built around. */
export type FoundPlan = Exclude<ResolvedPlan, { source: 'none' }>

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
    // editedMarkdownOf hands back trimmed canonical markdown; the file gets the
    // final newline every other tool writing this path would leave behind.
    io.writePlanFile(planPath, `${edited}\n`)
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
  /** This session's earlier rounds — never includes the current one. */
  history: readonly PlanVersion[]
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
      history: deps.history,
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
