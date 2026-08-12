import { TOKEN_HEADER } from '../shared/protocol'
import type { PendingEntry } from './pending'
import type { DeepReadonly } from '../shared/readonly'

/**
 * - 'live'          — this URL is still serving THIS review
 * - 'dead'          — nothing is there, or something else is; drop the entry
 * - 'indeterminate' — no answer in time; keep the entry, just do not offer it
 */
export type PendingLiveness = 'live' | 'dead' | 'indeterminate'

/** How long a loopback review has to answer before it is nobody's business. */
const PROBE_TIMEOUT_MS = 500

/**
 * The slice of `fetch` the probe needs, in primitives only. Narrower than the
 * DOM signature on purpose: a test double is then a two-line function, and the
 * header name and timeout stay facts of the real implementation rather than
 * things every double has to re-state.
 */
export type ProbeFetch = (
  url: string,
  token: string,
  timeoutMs: number,
) => Promise<Response>

export const realProbeFetch: ProbeFetch = (url, token, timeoutMs) =>
  fetch(url, {
    headers: { [TOKEN_HEADER]: token },
    signal: AbortSignal.timeout(timeoutMs),
  })

/**
 * Asks the URL whether it is still this review.
 *
 * Status 200 alone is not enough. When a hook dies uncleanly its file survives,
 * and its ephemeral port can be re-bound by an unrelated local server — any
 * server with an SPA catch-all answers 200 to /api/review, which would send the
 * user's browser to a stranger's page. Matching meta.sessionId is free (the
 * real server already serves it) and settles the question the entry actually
 * poses.
 *
 * The token rides in a header, not the URL: it lives in the `#token=` fragment,
 * which is never transmitted, so fetching the stored URL as-is would hit the
 * static handler tokenless and get a 200 back from index.html.
 */
export async function probeReview(
  entry: DeepReadonly<PendingEntry>,
  fetchFn: ProbeFetch,
): Promise<PendingLiveness> {
  let target: URL
  let token: string
  try {
    target = new URL(entry.url)
    token = /[#&]token=([^&]+)/u.exec(target.hash)?.[1] ?? ''
  } catch {
    return 'dead'
  }

  let response: Response
  try {
    response = await fetchFn(
      `${target.origin}/api/review`,
      token,
      PROBE_TIMEOUT_MS,
    )
  } catch (error) {
    // Connection refused is proof: nothing holds that port. A timeout is not —
    // a suspended (Ctrl-Z'd) session accepts the connection in the kernel
    // backlog and answers as soon as it is resumed, so deleting its entry would
    // destroy a review the user can still reach.
    return isConnectionRefused(error) ? 'dead' : 'indeterminate'
  }

  if (response.status !== 200) return 'dead'
  try {
    const body: unknown = await response.json()
    return sessionIdOf(body) === entry.sessionId ? 'live' : 'dead'
  } catch {
    return 'dead'
  }
}

function sessionIdOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('meta' in body))
    return null
  const { meta } = body
  if (typeof meta !== 'object' || meta === null || !('sessionId' in meta))
    return null
  return typeof meta.sessionId === 'string' ? meta.sessionId : null
}

/** undici reports the errno on the cause, not the error itself. */
function isConnectionRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const cause = 'cause' in error ? error.cause : undefined
  if (typeof cause !== 'object' || cause === null || !('code' in cause))
    return false
  return cause.code === 'ECONNREFUSED'
}
