import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  addMilkplanHook,
  isJsonObject,
  isMachineSpecific,
  removeMilkplanHooks,
  settingsRunMilkplan,
  type Settings,
} from './settings-hooks'
import { VERSION } from './version'

export const LOCAL_FILE = 'settings.local.json'
export const SHARED_FILE = 'settings.json'

function log(message: string): void {
  process.stderr.write(`[milkplan] ${message}\n`)
}

function selfPath(): string {
  return fileURLToPath(import.meta.url)
}

function isNpmInstall(): boolean {
  return selfPath().split(sep).includes('node_modules')
}

export function resolveHookCommand(): string {
  const self = selfPath()
  if (isNpmInstall()) return 'npx -y milkplan'
  // Hooks run with Claude Code's environment, where a version-manager node
  // (fnm/nvm) may not be on PATH — pin the interpreter that ran init.
  // realpath matters: fnm's multishell symlink dies with the shell session.
  // Quote both paths: the hook command runs through a shell, and e.g. fnm's
  // node lives under "Application Support" (a space) on macOS.
  const node = realpathSync(process.execPath)
  const parts = self.split(sep)
  if (parts[parts.length - 2] === 'dist') return `"${node}" "${self}"`
  // Running from sources (src/cli/*): point at the build output.
  return `"${node}" "${resolve(dirname(self), '..', '..', 'dist', 'cli.mjs')}"`
}

function resolveSharedCommand(): string | null {
  if (!isNpmInstall()) {
    log(
      "a shared hook runs on every teammate's machine, but this milkplan runs from a source checkout — its command would embed paths that only exist here.",
    )
    log(
      'install from npm first (npm install -g milkplan), or drop --shared for a machine-local hook in settings.local.json.',
    )
    process.exitCode = 1
    return null
  }
  // Pin the version: a committed hook must not drift under teammates.
  return `npx -y milkplan@${VERSION}`
}

export function loadSettings(settingsPath: string): Settings | null {
  if (!existsSync(settingsPath)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    log(`could not parse ${settingsPath}; refusing to overwrite it`)
    process.exitCode = 1
    return null
  }
  if (!isJsonObject(parsed)) {
    log(`${settingsPath} is not a JSON object; refusing to overwrite it`)
    process.exitCode = 1
    return null
  }
  return parsed
}

/** loadSettings without the error reporting, for advisory sibling checks. */
function peekSettings(settingsPath: string): Settings | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'))
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * settings.local.json holds machine-specific paths and must never reach the
 * repo. Tracked already → warn. Untracked and unignored → ignore it via
 * .git/info/exclude (repo-local, nothing of the user's gets edited).
 */
function ensureLocalIgnored(settingsPath: string): void {
  const projectDir = dirname(dirname(settingsPath))
  try {
    const tracked = spawnSync(
      'git',
      ['ls-files', '--error-unmatch', settingsPath],
      { cwd: projectDir, stdio: 'ignore' },
    )
    // git unavailable → nothing to manage.
    if (tracked.error !== undefined) return
    if (tracked.status === 0) {
      log(
        `warning: ${settingsPath} is tracked by git — it is a machine-local file and should not be committed. Run: git rm --cached ${settingsPath}`,
      )
      return
    }
    const ignored = spawnSync('git', ['check-ignore', '-q', settingsPath], {
      cwd: projectDir,
      stdio: 'ignore',
    })
    // Already ignored (e.g. by a previous init or the user's own .gitignore).
    if (ignored.status === 0) return
    const gitPath = spawnSync(
      'git',
      ['rev-parse', '--git-path', 'info/exclude'],
      { cwd: projectDir, encoding: 'utf8' },
    )
    // Not a git repository at all.
    if (gitPath.status !== 0) return
    const excludePath = resolve(projectDir, gitPath.stdout.trim())
    mkdirSync(dirname(excludePath), { recursive: true })
    // "**/" so the pattern holds even when init ran below the repo root.
    appendFileSync(excludePath, `**/.claude/${LOCAL_FILE}\n`)
    log(`ignored .claude/${LOCAL_FILE} via ${excludePath} (machine-local file)`)
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
): void {
  for (const otherPath of otherPaths) {
    if (otherPath === targetPath || !existsSync(otherPath)) continue
    const settings = peekSettings(otherPath)
    if (settings === null || !settingsRunMilkplan(settings, ownCommands))
      continue
    log(
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

function resolveInitTarget(args: readonly string[]): InitTarget | null {
  const unknown = args.find((arg) => arg !== '--project' && arg !== '--shared')
  if (unknown !== undefined) {
    log(`unknown option for init: ${unknown} (expected --project, --shared)`)
    process.exitCode = 1
    return null
  }
  const project = args.includes('--project')
  const shared = args.includes('--shared')
  if (shared && !project) {
    log('--shared only applies to project installs; use --project --shared')
    process.exitCode = 1
    return null
  }
  const settingsDir = join(project ? process.cwd() : homedir(), '.claude')
  const settingsPath = join(
    settingsDir,
    project && !shared ? LOCAL_FILE : SHARED_FILE,
  )
  const command = shared ? resolveSharedCommand() : resolveHookCommand()
  if (command === null) return null
  // Backstop independent of the branching above: the shareable project file
  // never receives a machine-specific command, whatever future edits do.
  if (project && shared && isMachineSpecific(command)) {
    log(`refusing to write a machine-specific command into ${settingsPath}`)
    process.exitCode = 1
    return null
  }
  return { project, shared, settingsDir, settingsPath, command }
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
export function runInit(args: readonly string[]): void {
  const target = resolveInitTarget(args)
  if (target === null) return
  const { project, shared, settingsDir, settingsPath, command } = target

  const settings = loadSettings(settingsPath)
  if (settings === null) return

  // Remove-then-add: a re-run refreshes stale entries (old node paths after a
  // version-manager upgrade, an outdated shared version pin) instead of
  // leaving them in place behind an "already installed" message.
  const before = JSON.stringify(settings)
  const cleaned = removeMilkplanHooks(settings, [command])
  const next = addMilkplanHook(cleaned.settings, command).settings

  if (JSON.stringify(next) === before) {
    log(
      `${settingsPath} already runs milkplan with this command; nothing to do`,
    )
  } else {
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`)
    log(
      cleaned.removed > 0
        ? `refreshed hook in ${settingsPath}: ${command}`
        : `registered hook in ${settingsPath}: ${command}`,
    )
  }

  if (project && !shared) ensureLocalIgnored(settingsPath)
  if (project)
    warnAboutStackedHooks(
      settingsPath,
      [
        join(settingsDir, shared ? LOCAL_FILE : SHARED_FILE),
        join(homedir(), '.claude', SHARED_FILE),
      ],
      [command],
    )
}
