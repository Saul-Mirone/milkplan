import { realBrowserSupport, type BrowserSupport } from './browser-support'
import { openBrowser, realLaunchIO } from './open-browser'
import { noBrowserRequested } from './open-mode'
import {
  listPending,
  realPendingIO,
  removePending,
  type PendingEntry,
} from './pending'
import {
  probeReview,
  realProbeFetch,
  type PendingLiveness,
} from './probe-review'
import type { DeepReadonly } from '../shared/readonly'

/** Every effect `milkplan open` has on the world, mirroring InitIO. */
export interface OpenIO {
  /** Parsed, pattern-valid entries, newest first. Not probed. */
  listPending(): PendingEntry[]
  probe(entry: DeepReadonly<PendingEntry>): Promise<PendingLiveness>
  removePending(pid: number): void
  browserSupport(): BrowserSupport
  launch(
    url: string,
    support: DeepReadonly<BrowserSupport>,
    onExhausted: () => void,
  ): void
  /** Where the URLs go: stdout, so `milkplan open --print | head -1` works. */
  writeStdout(line: string): void
  log(message: string): void
  /** Marks the run as failed. Separate from log so tests never touch exitCode. */
  fail(): void
}

export const realOpenIO: OpenIO = {
  listPending: () => listPending(realPendingIO),
  probe: (entry) => probeReview(entry, realProbeFetch),
  removePending: (pid) => {
    removePending(pid, realPendingIO)
  },
  // MILKPLAN_OPEN is overridden to 'auto': it configures the HOOK not to open a
  // browser, and this command is the thing manual mode expects you to run
  // instead — honouring it here would make `milkplan open` refuse to open.
  // MILKPLAN_NO_BROWSER is not overridden. Its contract is "never launch
  // anything", which is what automation and the e2e sandbox rely on; obeying it
  // makes a stray `milkplan open` in CI structurally unable to open a browser
  // rather than merely discouraged.
  browserSupport: () =>
    realBrowserSupport(
      logToStderr,
      noBrowserRequested(process.env) ? 'manual' : 'auto',
    ),
  launch(url, support, onExhausted) {
    openBrowser(url, support, realLaunchIO, onExhausted)
  },
  writeStdout(line) {
    process.stdout.write(line)
  },
  log: logToStderr,
  fail() {
    process.exitCode = 1
  },
}

function logToStderr(message: string): void {
  process.stderr.write(`[milkplan] ${message}\n`)
}

/** How long ago a review was registered, for the multi-review listing. */
function ageOf(entry: DeepReadonly<PendingEntry>, now: number): string {
  const minutes = Math.max(0, Math.round((now - entry.startedAt) / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

/**
 * Probes every registered review, dropping the ones that answered definitively
 * that they are gone.
 *
 * An indeterminate answer keeps its file but is left out of the result: a
 * suspended session cannot reply within the probe timeout yet still serves the
 * review once it is resumed, so its entry must survive even though there is
 * nothing to open right now.
 */
async function liveEntries(io: DeepReadonly<OpenIO>): Promise<PendingEntry[]> {
  const entries = io.listPending()
  const verdicts = await Promise.all(
    entries.map((entry: DeepReadonly<PendingEntry>) => io.probe(entry)),
  )
  const live: PendingEntry[] = []
  for (const [index, entry] of entries.entries()) {
    const verdict = verdicts[index]
    if (verdict === 'live') live.push(entry)
    else if (verdict === 'dead') io.removePending(entry.pid)
  }
  return live
}

function describe(entry: DeepReadonly<PendingEntry>, now: number): string {
  return `${entry.cwd} (waiting ${ageOf(entry, now)})`
}

/**
 * Opens one review, reporting the URL rather than failing silently when every
 * launcher turns out to be missing (WSL with interop disabled, a stale
 * $BROWSER). That callback runs after this function has returned — spawn
 * ENOENT arrives on a later tick — but the cascade drains before the process
 * exits, so the late `fail()` still sets the exit code.
 */
function launchOne(
  entry: DeepReadonly<PendingEntry>,
  support: DeepReadonly<BrowserSupport>,
  io: DeepReadonly<OpenIO>,
): void {
  io.launch(entry.url, support, () => {
    io.log(
      `every browser launcher failed to start — open it yourself: ${entry.url}`,
    )
    io.fail()
  })
}

export async function runOpen(
  args: readonly string[],
  io: DeepReadonly<OpenIO> = realOpenIO,
): Promise<void> {
  const print = args.includes('--print')
  const all = args.includes('--all')
  const unknown = args.find((arg) => arg !== '--print' && arg !== '--all')
  if (unknown !== undefined) {
    io.log(`unknown option for \`open\`: ${unknown}`)
    io.fail()
    return
  }

  const live = await liveEntries(io)
  if (live.length === 0) {
    io.log('no plan review is waiting')
    io.fail()
    return
  }

  const support = io.browserSupport()
  // Printing is the right answer, not a failure, whenever nothing can or
  // should be launched: an ssh user with no display wants the URL to forward,
  // and MILKPLAN_NO_BROWSER means "never launch anything".
  if (support.kind !== 'available') {
    for (const entry of live) io.writeStdout(`${entry.url}\n`)
    io.log(`not launching a browser (${support.reason}); the URL is above`)
    return
  }
  if (print) {
    for (const entry of live) io.writeStdout(`${entry.url}\n`)
    return
  }

  const now = Date.now()
  const targets = all ? live : live.slice(0, 1)
  for (const entry of targets) {
    io.log(`opening review for ${describe(entry, now)}`)
    launchOne(entry, support, io)
  }
  // Naming the rest matters: without it, a second session's review is
  // invisible and looks like it was never registered.
  for (const entry of live.slice(targets.length))
    io.log(`also waiting: ${describe(entry, now)} — ${entry.url}`)
}
