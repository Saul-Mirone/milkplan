import { spawn } from 'node:child_process'

/**
 * Fire-and-forget browser launch. Best effort: never throws, never blocks the
 * hook process (detached + unref), and swallows async spawn errors — the hook
 * prints the URL to stderr as the manual fallback.
 */
export function openBrowser(url: string): void {
  // Escape hatch for tests and automation (the URL still lands on stderr).
  const noBrowser = process.env['MILKPLAN_NO_BROWSER']
  if (noBrowser !== undefined && noBrowser !== '') return
  try {
    let command: string
    let args: string[]
    if (process.platform === 'darwin') {
      command = 'open'
      args = [url]
    } else if (process.platform === 'win32') {
      command = 'cmd'
      args = ['/c', 'start', '', url]
    } else {
      command = 'xdg-open'
      args = [url]
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Never throw: a failed launch must not kill the review server.
  }
}
