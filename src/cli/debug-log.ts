import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEBUG_LOG = join(homedir(), '.claude', 'milkplan.log')

/** Past this the log is truncated rather than grown. */
const MAX_LOG_BYTES = 256 * 1024

/**
 * The hook's only channel to a human after the fact.
 *
 * Lives in its own module so every side-effecting module can reach it without
 * importing hook-io.ts, which imports them.
 */
export function debugLog(message: string): void {
  const line = `[milkplan] ${message}\n`
  process.stderr.write(line)
  // Hooks run with stderr invisible to the user in interactive sessions;
  // keep a small on-disk trail so "nothing popped up" is diagnosable after
  // the fact.
  try {
    if (existsSync(DEBUG_LOG) && statSync(DEBUG_LOG).size > MAX_LOG_BYTES)
      writeFileSync(DEBUG_LOG, '')
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}`)
  } catch {
    // Logging must never break the hook.
  }
}
