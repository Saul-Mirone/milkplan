import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  LOCAL_FILE,
  SHARED_FILE,
  loadSettings,
  resolveHookCommand,
} from './init'
import { removeMilkplanHooks } from './settings-hooks'

function log(message: string): void {
  process.stderr.write(`[milkplan] ${message}\n`)
}

function reportOutcome(
  total: number,
  unreadable: boolean,
  candidates: readonly string[],
): void {
  if (total > 0) {
    log(
      'the npm package itself is untouched — remove it with: npm uninstall -g milkplan',
    )
    return
  }
  if (unreadable) {
    log(
      'no milkplan hooks removed — a settings file could not be parsed (see above)',
    )
    return
  }
  log(`no milkplan hooks found in:\n  ${candidates.join('\n  ')}`)
  log(
    'project files are looked up from the current directory — run uninstall from the project root if yours lives elsewhere',
  )
}

/**
 * `milkplan uninstall` — remove milkplan hooks from the user settings and the
 * current project's settings (both the shared and the local file). The npm
 * package itself is left alone.
 */
export function runUninstall(args: readonly string[]): void {
  if (args.length > 0) {
    log(`unknown option for uninstall: ${args[0]} (uninstall takes no options)`)
    process.exitCode = 1
    return
  }

  const candidates = [
    ...new Set([
      join(homedir(), '.claude', SHARED_FILE),
      join(process.cwd(), '.claude', SHARED_FILE),
      join(process.cwd(), '.claude', LOCAL_FILE),
    ]),
  ]
  // Catches a checkout install whose path lacks the substring "milkplan".
  const ownCommands = [resolveHookCommand()]

  let total = 0
  let unreadable = false
  for (const settingsPath of candidates) {
    if (!existsSync(settingsPath)) continue
    const settings = loadSettings(settingsPath)
    if (settings === null) {
      // Already logged by loadSettings; keep cleaning the other files.
      unreadable = true
      continue
    }
    const { settings: next, removed } = removeMilkplanHooks(
      settings,
      ownCommands,
    )
    if (removed === 0) continue
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`)
    log(
      `removed ${removed} milkplan hook${removed === 1 ? '' : 's'} from ${settingsPath}`,
    )
    total += removed
  }
  reportOutcome(total, unreadable, candidates)
}
