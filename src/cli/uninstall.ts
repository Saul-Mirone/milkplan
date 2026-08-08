import { join } from 'node:path'

import {
  loadSettings,
  resolveHookCommand,
  LOCAL_FILE,
  SHARED_FILE,
} from './init'
import { realInitIO, type InitIO } from './init-io'
import { removeMilkplanHooks } from './settings-hooks'
import type { DeepReadonly } from '../shared/readonly'

function reportOutcome(
  total: number,
  unreadable: boolean,
  candidates: readonly string[],
  io: DeepReadonly<InitIO>,
): void {
  if (total > 0) {
    io.log(
      'the npm package itself is untouched — remove it with: npm uninstall -g milkplan',
    )
    return
  }
  if (unreadable) {
    io.log(
      'no milkplan hooks removed — a settings file could not be parsed (see above)',
    )
    return
  }
  io.log(`no milkplan hooks found in:\n  ${candidates.join('\n  ')}`)
  io.log(
    'project files are looked up from the current directory — run uninstall from the project root if yours lives elsewhere',
  )
}

/**
 * `milkplan uninstall` — remove milkplan hooks from the user settings and the
 * current project's settings (both the shared and the local file). The npm
 * package itself is left alone.
 */
export function runUninstall(
  args: readonly string[],
  io: DeepReadonly<InitIO> = realInitIO,
): void {
  if (args.length > 0) {
    io.log(
      `unknown option for uninstall: ${args[0]} (uninstall takes no options)`,
    )
    io.fail()
    return
  }

  const candidates = [
    ...new Set([
      join(io.homedir(), '.claude', SHARED_FILE),
      join(io.cwd(), '.claude', SHARED_FILE),
      join(io.cwd(), '.claude', LOCAL_FILE),
    ]),
  ]
  // Catches a checkout install whose path lacks the substring "milkplan".
  const ownCommands = [resolveHookCommand(io)]

  let total = 0
  let unreadable = false
  for (const settingsPath of candidates) {
    if (!io.exists(settingsPath)) continue
    const settings = loadSettings(settingsPath, io)
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
    io.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`)
    io.log(
      `removed ${removed} milkplan hook${removed === 1 ? '' : 's'} from ${settingsPath}`,
    )
    total += removed
  }
  reportOutcome(total, unreadable, candidates, io)
}
