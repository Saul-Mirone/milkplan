import type { PlanVersion } from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'

/**
 * Label for one earlier round in the diff overlay's version picker, e.g.
 * "Round 2 · 14:32". The number is the version's own recorded round — array
 * indexes drift once the round cap slices old entries off the served history.
 * The time renders in the viewer's locale, so tests assert only the structure,
 * never a concrete clock value.
 */
export function versionLabel(version: DeepReadonly<PlanVersion>): string {
  const time = new Date(version.ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  return `Round ${version.round} · ${time}`
}
