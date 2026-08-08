/**
 * Shared markdown helpers — used by the CLI (history dedupe) and the UI (diff
 * pre-check). Keep this file dependency-free, like protocol.ts.
 */

/**
 * The minimal normalization for round-equality checks: strip \r, trimEnd().
 * Never per-line trim — that would destroy markdown hard-break semantics.
 */
export function normalizeMarkdown(markdown: string): string {
  return markdown.replaceAll('\r', '').trimEnd()
}
