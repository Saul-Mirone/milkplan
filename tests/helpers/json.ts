/**
 * Walks a parsed-JSON value by key/index without a type assertion, so tests can
 * reach into settings files and manifests while staying honest about their
 * `unknown` type.
 */
export function at(
  value: unknown,
  ...path: readonly (string | number)[]
): unknown {
  let cursor: unknown = value
  for (const step of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    const record: Record<string, unknown> = { ...cursor }
    cursor = record[String(step)]
  }
  return cursor
}
