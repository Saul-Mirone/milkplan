import type { BrowserSupport } from './browser-support'
import { canonicalizeMarkdown } from './canonical'
import { realHookIO, type HookIO } from './hook-io'
import { buildSession, type FoundPlan } from './hook-session'
import type { RunningServer } from './server'
import type { HookPayload } from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'

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

/**
 * Locates the plan, passing through when there is nothing to review.
 *
 * The markdown is canonicalized on the way in, which makes this the single
 * entry point for everything downstream: what the editor shows, what is stored
 * as this round, and what the next round is diffed against. Claude's markdown
 * style drifts from round to round, and unless both sides share one canon that
 * drift reads as changes in sections nobody touched. The plan file itself is
 * left alone here — this path only reads.
 */
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
  return { ...plan, markdown: canonicalizeMarkdown(plan.markdown) }
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
      `no way to open a browser (${support.reason}); passing through — set MILKPLAN_OPEN=manual (or MILKPLAN_NO_BROWSER=1) to serve the review anyway, then run \`milkplan open --print\``,
    )
    io.exit(0)
  }
  if (support.kind === 'suppressed')
    io.log(
      `not opening a browser (${support.reason}); run \`milkplan open\` — or \`npx -y @enorim/milkplan open\` on a plugin install — when you are ready`,
    )
  return support
}

/**
 * Everything after the server is listening: put the review on the record, then
 * try to open it.
 *
 * Split out of runHook only because runHook was sitting on the
 * max-lines-per-function cap; the ordering here is the part that matters. The
 * URL is logged first, because that line is the user's last-resort way back to
 * a review and must survive a registry that cannot be written. Registration
 * comes before the launch and after every passthrough exit above, so a review
 * nobody can reach is never registered.
 */
function registerAndLaunch(
  running: DeepReadonly<RunningServer>,
  support: DeepReadonly<BrowserSupport>,
  payload: DeepReadonly<HookPayload>,
  plan: DeepReadonly<FoundPlan>,
  isSettled: () => boolean,
  io: DeepReadonly<HookIO>,
): void {
  io.log(`review UI at ${running.url} (open manually if no browser appeared)`)
  io.registerPending({
    url: running.url,
    sessionId: payload.session_id,
    cwd: payload.cwd,
    planPath: plan.source === 'file' ? plan.path : null,
  })
  io.launch(
    running.url,
    support,
    passThroughOnLaunchFailure(running, isSettled, io),
  )
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

  // Only after every passthrough exit: a round nobody reviews is not recorded.
  // No try/catch — recordHistory is total, same as io.resolve.
  const versions = io.recordHistory({
    sessionId: payload.session_id,
    planPath: plan.source === 'file' ? plan.path : null,
    markdown: plan.markdown,
  })
  // Drop the current round (always last: append, dedupe and degraded paths
  // alike); the payload carries it as `plan`.
  const history = versions.slice(0, -1)

  let running: RunningServer | null = null
  let settled = false
  const session = buildSession({
    plan,
    payload,
    history,
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

  registerAndLaunch(running, support, payload, plan, () => settled, io)
  // No further code: the listening server keeps the process alive until a
  // decision, a skip, a signal, or the Claude Code hook timeout.
}
