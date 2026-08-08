import { dirname, join, resolve, sep } from 'node:path'

import { realInitIO, type InitIO } from './init-io'
import {
  addMilkplanHook,
  isJsonObject,
  isMachineSpecific,
  removeMilkplanHooks,
  settingsRunMilkplan,
  type Settings,
} from './settings-hooks'
import { VERSION } from './version'
import type { DeepReadonly } from '../shared/readonly'

export const LOCAL_FILE = 'settings.local.json'
export const SHARED_FILE = 'settings.json'

function isNpmInstall(selfPath: string): boolean {
  return selfPath.split(sep).includes('node_modules')
}

/**
 * The hook command this install should register, as a pure function of where
 * milkplan lives and which node is running it.
 *
 * An npm install gets the portable `npx` form. Everything else pins absolute
 * paths, because hooks run with Claude Code's environment where a
 * version-manager node (fnm/nvm) may not be on PATH. Both paths are quoted:
 * the command goes through a shell, and fnm's node lives under "Application
 * Support" — a space — on macOS. Losing either pair of quotes makes every plan
 * approval fail silently.
 */
export function hookCommandFor(selfPath: string, nodePath: string): string {
  if (isNpmInstall(selfPath)) return 'npx -y milkplan'
  const parts = selfPath.split(sep)
  if (parts[parts.length - 2] === 'dist') return `"${nodePath}" "${selfPath}"`
  // Running from sources (src/cli/*): point at the build output.
  return `"${nodePath}" "${resolve(dirname(selfPath), '..', '..', 'dist', 'cli.mjs')}"`
}

export function resolveHookCommand(
  io: DeepReadonly<InitIO> = realInitIO,
): string {
  return hookCommandFor(io.selfPath(), io.nodePath())
}

function resolveSharedCommand(io: DeepReadonly<InitIO>): string | null {
  if (!isNpmInstall(io.selfPath())) {
    io.log(
      "a shared hook runs on every teammate's machine, but this milkplan runs from a source checkout — its command would embed paths that only exist here.",
    )
    io.log(
      'install from npm first (npm install -g milkplan), or drop --shared for a machine-local hook in settings.local.json.',
    )
    io.fail()
    return null
  }
  // Pin the version: a committed hook must not drift under teammates.
  return `npx -y milkplan@${VERSION}`
}

export function loadSettings(
  settingsPath: string,
  io: DeepReadonly<InitIO> = realInitIO,
): Settings | null {
  if (!io.exists(settingsPath)) return {}
  const raw = io.readFile(settingsPath)
  let parsed: unknown
  try {
    if (raw === null) throw new Error('unreadable')
    parsed = JSON.parse(raw)
  } catch {
    io.log(`could not parse ${settingsPath}; refusing to overwrite it`)
    io.fail()
    return null
  }
  if (!isJsonObject(parsed)) {
    io.log(`${settingsPath} is not a JSON object; refusing to overwrite it`)
    io.fail()
    return null
  }
  return parsed
}

/** loadSettings without the error reporting, for advisory sibling checks. */
function peekSettings(
  settingsPath: string,
  io: DeepReadonly<InitIO>,
): Settings | null {
  const raw = io.readFile(settingsPath)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * JSON with every object's keys sorted, for comparing two settings objects by
 * content rather than by key order.
 *
 * Needed because the remove-then-add refresh below moves `hooks` to the end
 * whenever removal empties it — which is the normal case for a file whose only
 * milkplan entry is being refreshed. Comparing raw JSON.stringify output would
 * therefore never report "unchanged", so every `init` would rewrite the file,
 * claim it "refreshed" a hook it did not, and reorder the user's keys (a
 * spurious git diff on every run under --shared).
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isJsonObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    return `{${entries.join(',')}}`
  }
  // Values reachable here come from JSON.parse, so `undefined` — the one input
  // JSON.stringify answers with undefined — cannot occur.
  return JSON.stringify(value)
}

/**
 * settings.local.json holds machine-specific paths and must never reach the
 * repo. Tracked already → warn. Untracked and unignored → ignore it via
 * .git/info/exclude (repo-local, nothing of the user's gets edited).
 */
function ensureLocalIgnored(
  settingsPath: string,
  io: DeepReadonly<InitIO>,
): void {
  const projectDir = dirname(dirname(settingsPath))
  try {
    const tracked = io.git(
      ['ls-files', '--error-unmatch', settingsPath],
      projectDir,
    )
    // git unavailable → nothing to manage.
    if (tracked.status === null) return
    if (tracked.status === 0) {
      io.log(
        `warning: ${settingsPath} is tracked by git — it is a machine-local file and should not be committed. Run: git rm --cached ${settingsPath}`,
      )
      return
    }
    // Already ignored (e.g. by a previous init or the user's own .gitignore).
    if (io.git(['check-ignore', '-q', settingsPath], projectDir).status === 0)
      return
    const gitPath = io.git(
      ['rev-parse', '--git-path', 'info/exclude'],
      projectDir,
    )
    // Not a git repository at all.
    if (gitPath.status !== 0) return
    const excludePath = resolve(projectDir, gitPath.stdout.trim())
    io.mkdir(dirname(excludePath))
    // "**/" so the pattern holds even when init ran below the repo root.
    io.appendFile(excludePath, `**/.claude/${LOCAL_FILE}\n`)
    io.log(
      `ignored .claude/${LOCAL_FILE} via ${excludePath} (machine-local file)`,
    )
  } catch {
    // Ignore management must never break init itself.
  }
}

/**
 * Claude Code merges hooks across settings files, so a milkplan entry in a
 * sibling file means every plan approval fires two reviews. Advisory only.
 */
function warnAboutStackedHooks(
  targetPath: string,
  otherPaths: readonly string[],
  ownCommands: readonly string[],
  io: DeepReadonly<InitIO>,
): void {
  for (const otherPath of otherPaths) {
    if (otherPath === targetPath || !io.exists(otherPath)) continue
    const settings = peekSettings(otherPath, io)
    if (settings === null || !settingsRunMilkplan(settings, ownCommands))
      continue
    io.log(
      `note: ${otherPath} also runs milkplan. Hooks stack across settings files, so plan approvals would open two reviews — remove the extra entry (milkplan uninstall cleans user and project settings).`,
    )
  }
}

interface InitTarget {
  project: boolean
  shared: boolean
  settingsDir: string
  settingsPath: string
  command: string
}

function resolveInitTarget(
  args: readonly string[],
  io: DeepReadonly<InitIO>,
): InitTarget | null {
  const unknown = args.find((arg) => arg !== '--project' && arg !== '--shared')
  if (unknown !== undefined) {
    io.log(`unknown option for init: ${unknown} (expected --project, --shared)`)
    io.fail()
    return null
  }
  const project = args.includes('--project')
  const shared = args.includes('--shared')
  if (shared && !project) {
    io.log('--shared only applies to project installs; use --project --shared')
    io.fail()
    return null
  }
  const settingsDir = join(project ? io.cwd() : io.homedir(), '.claude')
  const settingsPath = join(
    settingsDir,
    project && !shared ? LOCAL_FILE : SHARED_FILE,
  )
  const command = shared ? resolveSharedCommand(io) : resolveHookCommand(io)
  if (command === null) return null
  // Backstop independent of the branching above: the shareable project file
  // never receives a machine-specific command, whatever future edits do.
  if (project && shared && isMachineSpecific(command)) {
    io.log(`refusing to write a machine-specific command into ${settingsPath}`)
    io.fail()
    return null
  }
  return { project, shared, settingsDir, settingsPath, command }
}

/** Merges the hook into the target file, writing only when something changed. */
function mergeAndWrite(
  target: DeepReadonly<InitTarget>,
  settings: DeepReadonly<Settings>,
  io: DeepReadonly<InitIO>,
): void {
  const { settingsDir, settingsPath, command } = target
  // Remove-then-add: a re-run refreshes stale entries (old node paths after a
  // version-manager upgrade, an outdated shared version pin) instead of
  // leaving them in place behind an "already installed" message.
  const before = stableJson(settings)
  const cleaned = removeMilkplanHooks(settings, [command])
  const next = addMilkplanHook(cleaned.settings, command).settings

  if (stableJson(next) === before) {
    io.log(
      `${settingsPath} already runs milkplan with this command; nothing to do`,
    )
    return
  }
  io.mkdir(settingsDir)
  io.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`)
  io.log(
    cleaned.removed > 0
      ? `refreshed hook in ${settingsPath}: ${command}`
      : `registered hook in ${settingsPath}: ${command}`,
  )
}

/**
 * `milkplan init [--project [--shared]]` — idempotent settings merge that
 * also refreshes a stale milkplan entry in the target file.
 *
 * Hook commands embed this machine (absolute node/cli paths), so project
 * installs default to settings.local.json, Claude Code's machine-local file.
 * Only `--shared` touches the committed settings.json, and then only with a
 * portable, version-pinned command.
 */
export function runInit(
  args: readonly string[],
  io: DeepReadonly<InitIO> = realInitIO,
): void {
  const target = resolveInitTarget(args, io)
  if (target === null) return

  const settings = loadSettings(target.settingsPath, io)
  if (settings === null) return
  mergeAndWrite(target, settings, io)

  const { project, shared, settingsDir, settingsPath, command } = target
  if (project && !shared) ensureLocalIgnored(settingsPath, io)
  if (project)
    warnAboutStackedHooks(
      settingsPath,
      [
        join(settingsDir, shared ? LOCAL_FILE : SHARED_FILE),
        join(io.homedir(), '.claude', SHARED_FILE),
      ],
      [command],
      io,
    )
}
