import {
  DEV_TOKEN,
  TOKEN_HEADER,
  type DecisionRequest,
  type ReviewPayload,
} from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'

/**
 * Reads the review token out of a location hash.
 *
 * The token rides in the fragment so it never reaches a server log or the
 * browser's history sync. Falling back to DEV_TOKEN is what lets `vite dev`
 * work without a fragment; in production a miss means every API call 403s, so
 * the extraction has to match exactly what open-browser puts in the URL.
 */
export function tokenFromHash(hash: string): string {
  const match = /[#&]token=([^&]+)/u.exec(hash)
  return match?.[1] ?? DEV_TOKEN
}

async function api<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    [TOKEN_HEADER]: tokenFromHash(window.location.hash),
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok)
    throw new Error(`${method} ${path} failed with status ${response.status}`)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic JSON boundary: T is a caller-supplied type parameter, so no runtime type guard is possible here.
  return (await response.json()) as T
}

export function fetchReview(): Promise<ReviewPayload> {
  return api<ReviewPayload>('/api/review', 'GET')
}

export async function postDecision(
  decision: DeepReadonly<DecisionRequest>,
): Promise<void> {
  await api<{ ok: boolean }>('/api/decision', 'POST', decision)
}

export async function postSkip(): Promise<void> {
  await api<{ ok: boolean }>('/api/skip', 'POST')
}
