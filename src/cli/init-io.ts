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
import { fileURLToPath } from 'node:url'

/** Outcome of one `git` invocation, flattened to what init actually reads. */
export interface GitResult {
  /** null when git itself could not be started — nothing to manage. */
  status: number | null
  stdout: string
}

/**
 * Every effect `init` and `uninstall` have on the world, in one record.
 *
 * Injected so the settings-file logic can be exercised without touching a real
 * home directory or a real repository. That is not a convenience: this very
 * checkout has a live milkplan hook in its own .claude/settings.local.json, so
 * a test that reached the real filesystem with a defaulted cwd would delete
 * the developer's working install. No test may call runInit or runUninstall
 * without passing an io.
 */
export interface InitIO {
  exists(path: string): boolean
  /** Returns null on any read error. */
  readFile(path: string): string | null
  writeFile(path: string, content: string): void
  /** Recursive, like `mkdir -p`. */
  mkdir(path: string): void
  appendFile(path: string, content: string): void
  homedir(): string
  cwd(): string
  /** Absolute path of the running milkplan module. */
  selfPath(): string
  /** Absolute, symlink-resolved path of the node binary running init. */
  nodePath(): string
  git(args: readonly string[], cwd: string): GitResult
  log(message: string): void
  /** Marks the run as failed. Separate from log so tests never touch exitCode. */
  fail(): void
}

export const realInitIO: InitIO = {
  exists: existsSync,
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  writeFile(path, content) {
    writeFileSync(path, content)
  },
  mkdir(path) {
    mkdirSync(path, { recursive: true })
  },
  appendFile(path, content) {
    appendFileSync(path, content)
  },
  homedir,
  cwd: () => process.cwd(),
  selfPath: () => fileURLToPath(import.meta.url),
  // realpath matters: fnm's multishell symlink dies with the shell session.
  nodePath: () => realpathSync(process.execPath),
  git(args, cwd) {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
    if (result.error !== undefined) return { status: null, stdout: '' }
    return { status: result.status, stdout: result.stdout }
  },
  log(message) {
    process.stderr.write(`[milkplan] ${message}\n`)
  },
  fail() {
    process.exitCode = 1
  },
}
