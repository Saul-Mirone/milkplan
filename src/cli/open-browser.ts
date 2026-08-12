import { spawn } from 'node:child_process'

import type { BrowserSupport, LauncherId } from './browser-support'
import type { DeepReadonly } from '../shared/readonly'

export interface Candidate {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * Every launcher but 'browser-env', which alone needs a command from the
 * environment. Keyed by id so adding a `LauncherId` fails to compile until it
 * has argv here.
 */
const FIXED_CANDIDATES: Record<
  Exclude<LauncherId, 'browser-env'>,
  (url: string) => Candidate
> = {
  'macos-open': (url) => ({ command: 'open', args: [url] }),
  // -g leaves the browser where it is instead of raising it (flags precede the
  // operand; `open` treats an http URL as a URL, not a path). Not -j, which
  // hides the browser outright, and not -n, which would start a second
  // instance. Best-effort by nature: a browser starting from cold may still
  // activate itself despite the flag.
  'macos-open-bg': (url) => ({ command: 'open', args: ['-g', url] }),
  // The empty argument is `start`'s title parameter; without it `start` would
  // consume the URL as the window title.
  'windows-start': (url) => ({
    command: 'cmd.exe',
    args: ['/c', 'start', '', url],
  }),
  wslview: (url) => ({ command: 'wslview', args: [url] }),
  // The URL must stay single-quoted: PowerShell begins a comment at a `#`
  // preceded by whitespace, and the review URL always carries a `#token=`
  // fragment. We generate the URL ourselves, so it holds no quote to escape.
  powershell: (url) => ({
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process '${url}'`,
    ],
  }),
  'xdg-open': (url) => ({ command: 'xdg-open', args: [url] }),
}

function candidateFor(
  id: LauncherId,
  url: string,
  browserCommand: string | undefined,
): Candidate | null {
  // $BROWSER is taken as a bare command: no colon-list splitting (it would cut
  // a Windows path in half) and no %s expansion. Returning null when it is
  // absent keeps the pairing honest without a non-null assertion.
  if (id === 'browser-env')
    return browserCommand === undefined
      ? null
      : { command: browserCommand, args: [url] }
  return FIXED_CANDIDATES[id](url)
}

/**
 * Expands a support verdict into concrete argv. Every candidate must carry the
 * URL's `#token=` fragment verbatim: the UI falls back to the dev token when the
 * fragment is missing, so dropping it yields a page that loads and then 403s on
 * every API call — a silently broken review rather than a visible failure.
 */
export function buildCandidates(
  support: DeepReadonly<BrowserSupport>,
  url: string,
): readonly Candidate[] {
  if (support.kind !== 'available') return []
  const { browserCommand } = support
  return support.launchers
    .map((id) => candidateFor(id, url, browserCommand))
    .filter((candidate): candidate is Candidate => candidate !== null)
}

export interface LaunchIO {
  /**
   * Starts a launcher without waiting for it. `onError` fires when the process
   * could not be started at all — the one signal the chain advances on.
   */
  spawn(command: string, args: readonly string[], onError: () => void): void
}

export const realLaunchIO: LaunchIO = {
  spawn(command, args, onError) {
    try {
      // detached + unref so a launcher never keeps the hook process alive; the
      // handle is held only long enough to hear a spawn failure.
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      child.on('error', onError)
      child.unref()
    } catch {
      // spawn can still throw synchronously; treat it as "did not start".
      onError()
    }
  },
}

/**
 * Walks the candidate chain, advancing only when a launcher fails to start at
 * all (ENOENT/EACCES). Exit codes are deliberately ignored: they disagree across
 * launchers (`start` returns the moment it hands off, explorer.exe returns 1 even
 * on success), and the "installed but no display" case is already settled by
 * `detectBrowserSupport` before the server binds.
 *
 * `onExhausted` means every launcher was missing — nothing opened, so the caller
 * can pass through. A suppressed verdict returns early instead: manual mode
 * (MILKPLAN_OPEN=manual, or its older spelling MILKPLAN_NO_BROWSER) means
 * "serve and wait for a manual visit", never "pass through".
 */
export function openBrowser(
  url: string,
  support: DeepReadonly<BrowserSupport>,
  io: DeepReadonly<LaunchIO>,
  onExhausted?: () => void,
): void {
  if (support.kind !== 'available') return
  const candidates = buildCandidates(support, url)
  let index = 0
  const advance = (): void => {
    const next = candidates[index]
    index += 1
    if (next === undefined) {
      onExhausted?.()
      return
    }
    let advanced = false
    io.spawn(next.command, next.args, () => {
      // 'error' should fire once, but a second event must not skip a candidate.
      if (advanced) return
      advanced = true
      advance()
    })
  }
  advance()
}
