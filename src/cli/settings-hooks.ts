import { homedir } from 'node:os'

import type { DeepReadonly } from '../shared/readonly'

/** A parsed Claude Code settings.json object. */
export type Settings = Record<string, unknown>

export function isJsonObject(value: unknown): value is Settings {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A command written to a project's shareable settings.json runs on every
 * teammate's machine — anything that encodes THIS machine must never land
 * there: absolute paths, home-relative paths, env expansions, UNC shares.
 */
export function isMachineSpecific(command: string): boolean {
  if (command.includes(homedir())) return true
  // POSIX absolute or ~ path at a token start.
  if (/(^|[\s"'=])[/~]/u.test(command)) return true
  // Env expansion resolves per-machine.
  if (command.includes('$')) return true
  // Windows drive path at a token start (never "s://" inside a URL).
  if (/(^|[\s"'=])[A-Za-z]:[\\/]/u.test(command)) return true
  // UNC path.
  if (command.includes('\\\\')) return true
  return false
}

/**
 * A hook entry is ours when its command mentions milkplan, or when it exactly
 * matches a command this install would generate — a source checkout in a
 * directory not named "milkplan" produces the latter.
 */
function hookIsMilkplan(
  hook: unknown,
  ownCommands: readonly string[],
): boolean {
  if (!isJsonObject(hook)) return false
  const command = hook['command']
  if (typeof command !== 'string') return false
  return command.includes('milkplan') || ownCommands.includes(command)
}

/** True when any PermissionRequest hook in the settings runs milkplan. */
export function settingsRunMilkplan(
  settings: DeepReadonly<Settings>,
  ownCommands: readonly string[] = [],
): boolean {
  const hooks = settings['hooks']
  if (!isJsonObject(hooks)) return false
  const matchers = hooks['PermissionRequest']
  if (!Array.isArray(matchers)) return false
  return matchers.some((matcher: unknown) => {
    if (!isJsonObject(matcher)) return false
    const entries = matcher['hooks']
    if (!Array.isArray(entries)) return false
    return entries.some((hook: unknown) => hookIsMilkplan(hook, ownCommands))
  })
}

export interface AddHookResult {
  settings: Settings
  added: boolean
}

/**
 * Returns a copy of the settings with the milkplan matcher added, unless a
 * milkplan hook is already present (then `added` is false and the settings
 * come back unchanged). Pure — the input is never mutated.
 */
export function addMilkplanHook(
  settings: DeepReadonly<Settings>,
  command: string,
): AddHookResult {
  if (settingsRunMilkplan(settings, [command]))
    return { settings: { ...settings }, added: false }

  const hooks = settings['hooks']
  const hooksObject = isJsonObject(hooks) ? hooks : {}
  const existing = hooksObject['PermissionRequest']
  const matchers: readonly unknown[] = Array.isArray(existing) ? existing : []
  const entry = {
    matcher: 'ExitPlanMode',
    hooks: [{ type: 'command', command, timeout: 86400 }],
  }
  return {
    settings: {
      ...settings,
      hooks: { ...hooksObject, PermissionRequest: [...matchers, entry] },
    },
    added: true,
  }
}

export interface RemoveHooksResult {
  settings: Settings
  removed: number
}

/**
 * Returns a copy of the settings with every milkplan hook stripped, leaving
 * everything else (other events, other hooks sharing a matcher) intact and
 * pruning structures the removal emptied. Pure — the input is never mutated.
 */
export function removeMilkplanHooks(
  settings: DeepReadonly<Settings>,
  ownCommands: readonly string[] = [],
): RemoveHooksResult {
  const hooks = settings['hooks']
  if (!isJsonObject(hooks)) return { settings: { ...settings }, removed: 0 }
  const matchers = hooks['PermissionRequest']
  if (!Array.isArray(matchers)) return { settings: { ...settings }, removed: 0 }

  let removed = 0
  const keptMatchers: unknown[] = []
  const matcherList: readonly unknown[] = matchers
  for (const matcher of matcherList) {
    if (!isJsonObject(matcher) || !Array.isArray(matcher['hooks'])) {
      keptMatchers.push(matcher)
      continue
    }
    const entries: readonly unknown[] = matcher['hooks']
    const keptHooks = entries.filter(
      (hook) => !hookIsMilkplan(hook, ownCommands),
    )
    removed += entries.length - keptHooks.length
    if (keptHooks.length === entries.length) keptMatchers.push(matcher)
    else if (keptHooks.length > 0)
      keptMatchers.push({ ...matcher, hooks: keptHooks })
  }

  const nextHooks: Settings = { ...hooks }
  if (keptMatchers.length > 0) nextHooks['PermissionRequest'] = keptMatchers
  else delete nextHooks['PermissionRequest']
  const next: Settings = { ...settings, hooks: nextHooks }
  if (Object.keys(nextHooks).length === 0) delete next['hooks']
  return { settings: next, removed }
}
