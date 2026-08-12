import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APPROVAL_PERMISSION_MODES,
  TOKEN_HEADER,
  type DecisionRequest,
  type ReviewPayload,
} from '../shared/protocol'
import type { DeepReadonly } from '../shared/readonly'

export interface ReviewSession {
  payload: ReviewPayload
  /** Single-use token; every /api request must send it in TOKEN_HEADER. */
  token: string
  /** Called after the HTTP response has been flushed. May exit the process. */
  onDecision(decision: DeepReadonly<DecisionRequest>): void
  /** Called after the HTTP response has been flushed. May exit the process. */
  onSkip(): void
}

export interface RunningServer {
  url: string
  close(): void
}

const MAX_BODY_BYTES = 10 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function sendJson(
  res: DeepReadonly<ServerResponse>,
  status: number,
  body: unknown,
  onFlushed?: () => void,
): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(data, () => onFlushed?.())
}

function readBody(req: DeepReadonly<IncomingMessage>): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: DeepReadonly<Buffer>[] = []
    let size = 0
    req.on('data', (chunk: DeepReadonly<Buffer>) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function isLoopbackHost(req: DeepReadonly<IncomingMessage>): boolean {
  // Exact hostname match after stripping the port: a prefix check would let
  // e.g. "localhost.evil.com" through (DNS-rebinding style Host headers).
  try {
    const { hostname } = new URL(`http://${req.headers.host ?? ''}`)
    return hostname === '127.0.0.1' || hostname === 'localhost'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAnnotationOut(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value['excerpt'] === 'string' &&
    typeof value['comment'] === 'string' &&
    typeof value['orphaned'] === 'boolean'
  )
}

function isDecisionRequest(value: unknown): value is DecisionRequest {
  if (!isRecord(value)) return false
  if (value['action'] !== 'approve' && value['action'] !== 'request-changes')
    return false
  // Item shapes must be validated here: a malformed annotation would throw
  // inside buildDecisionOutput after the 200 response, killing fail-open.
  const annotations = value['annotations']
  if (!Array.isArray(annotations)) return false
  if (!annotations.every(isAnnotationOut)) return false
  if (typeof value['overallFeedback'] !== 'string') return false
  if (
    value['editedMarkdown'] !== undefined &&
    typeof value['editedMarkdown'] !== 'string'
  )
    return false
  const permissionMode = value['permissionMode']
  if (
    permissionMode !== undefined &&
    !APPROVAL_PERMISSION_MODES.some((mode) => mode === permissionMode)
  )
    return false
  return true
}

function parseDecision(raw: string): DecisionRequest | null {
  try {
    const value: unknown = JSON.parse(raw)
    return isDecisionRequest(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Rejects non-loopback hosts and requests missing the session token. Returns
 * true (and sends the 403) when the request must not be handled further.
 */
function rejectUnauthorized(
  req: DeepReadonly<IncomingMessage>,
  res: DeepReadonly<ServerResponse>,
  token: string,
): boolean {
  if (!isLoopbackHost(req)) {
    sendJson(res, 403, { error: 'forbidden host' })
    return true
  }
  if (req.headers[TOKEN_HEADER] !== token) {
    sendJson(res, 403, { error: 'missing or invalid token' })
    return true
  }
  return false
}

/**
 * Handles /api/* routes. Returns true when the request was handled. This exact
 * function is mounted both by the production server and by the Vite dev
 * middleware, so it must stay free of server-lifecycle concerns.
 */
export async function handleApiRequest(
  session: DeepReadonly<ReviewSession>,
  req: DeepReadonly<IncomingMessage>,
  res: DeepReadonly<ServerResponse>,
): Promise<boolean> {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (!pathname.startsWith('/api/')) return false

  if (rejectUnauthorized(req, res, session.token)) return true

  if (req.method === 'GET' && pathname === '/api/review') {
    sendJson(res, 200, session.payload satisfies ReviewPayload)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/decision') {
    let raw: string
    try {
      raw = await readBody(req)
    } catch {
      sendJson(res, 413, { error: 'body too large' })
      return true
    }
    const decision = parseDecision(raw)
    if (!decision) {
      sendJson(res, 400, { error: 'invalid decision payload' })
      return true
    }
    // Flush the response before invoking the callback: it may exit the process.
    sendJson(res, 200, { ok: true }, () => {
      session.onDecision(decision)
    })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/skip') {
    sendJson(res, 200, { ok: true }, () => {
      session.onSkip()
    })
    return true
  }

  sendJson(res, 404, { error: 'not found' })
  return true
}

async function serveStatic(
  uiDir: string,
  req: DeepReadonly<IncomingMessage>,
  res: DeepReadonly<ServerResponse>,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405).end()
    return
  }
  const pathname = decodeURIComponent(
    new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
  )
  const root = resolve(uiDir)
  let filePath = resolve(root, `.${pathname}`)
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    res.writeHead(403).end()
    return
  }
  const exists = await stat(filePath)
    .then((s: DeepReadonly<Stats>) => s.isFile())
    .catch(() => false)
  // SPA fallback
  if (!exists) filePath = resolve(root, 'index.html')
  try {
    const content = await readFile(filePath)
    res.writeHead(200, {
      'content-type':
        CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    })
    res.end(content)
  } catch {
    res.writeHead(404).end()
  }
}

/** The built UI, which tsdown/vite place next to dist/cli.mjs. */
export function bundledUiDir(): string {
  return fileURLToPath(new URL('./ui', import.meta.url))
}

export function startReviewServer(
  session: DeepReadonly<ReviewSession>,
  uiDir: string = bundledUiDir(),
): Promise<RunningServer> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(
      (
        req: DeepReadonly<IncomingMessage>,
        res: DeepReadonly<ServerResponse>,
      ) => {
        handleApiRequest(session, req, res)
          .then((handled) => {
            if (!handled) return serveStatic(uiDir, req, res)
            return undefined
          })
          .catch(() => {
            if (!res.headersSent) res.writeHead(500)
            res.end()
          })
      },
    )
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        throw new Error('server.address() did not return an AddressInfo')
      }
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}/#token=${session.token}`,
        close: () => {
          server.close()
        },
      })
    })
  })
}
