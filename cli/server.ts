import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import type { WatchEvent } from './types.js'
import { ConflictError, NotFoundError, PathError, type Workspace } from './workspace.js'

export interface ServerOptions {
  workspace: Workspace
  /** Absolute path to the built app bundle. */
  distDir: string
  /** 0 (default) lets the OS assign an ephemeral port. */
  port?: number
  host?: string
  /**
   * Operator log sink. Injected so tests can assert what was logged and keep
   * their own output pristine; defaults to stderr. Never receives the token.
   */
  log?: (message: string) => void
}

export interface ServerHandle {
  /** Origin plus the token query param — hand this to the browser. */
  url: string
  origin: string
  port: number
  token: string
  notify(event: WatchEvent): void
  close(): Promise<void>
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** True when `candidate` is outside `dir`. Segment-wise, so '..foo.js' is fine. */
function escapesDir(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, candidate)
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
}

/** Client errors that a handler raises and the top-level mapper turns into 4xx. */
export class BadRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readBody(req: http.IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    // 413, not 500 — an oversize body is the client's mistake, not a server fault.
    if (total > limitBytes) throw new BadRequestError('request body too large', 413)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { workspace, distDir } = options
  const host = options.host ?? '127.0.0.1'
  const log = options.log ?? ((message: string) => process.stderr.write(`better-md: ${message}\n`))
  const token = crypto.randomBytes(32).toString('hex')
  const realDist = await fsp.realpath(distDir)
  const clients = new Set<http.ServerResponse>()

  let origin = ''

  /** Same-origin requests may omit Origin; anything cross-site always sends it. */
  function originAllowed(req: http.IncomingMessage): boolean {
    const value = req.headers.origin
    if (value === undefined) return true
    return value === origin
  }

  function tokenAllowed(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    // RFC 7235 makes the scheme token case-insensitive.
    const match = /^Bearer[ ]+(.+)$/i.exec(header)
    if (match === null) return false
    return timingSafeEqualStr(match[1], token)
  }

  async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
    let relative: string
    if (urlPath === '/') {
      relative = 'index.html'
    } else {
      try {
        relative = decodeURIComponent(urlPath.slice(1))
      } catch {
        // A malformed escape like /%zz is a bad request, not a server fault.
        // This route has no auth gate, so letting it reach the 500 handler would
        // let any page flood the terminal the CLI is drawing in, one line per
        // request. Answer 400 and log nothing.
        sendJson(res, 400, { error: 'malformed asset path' })
        return
      }
    }

    const abs = path.resolve(realDist, relative)
    // Segment-wise, so a legitimate '..foo.js' is not caught by a bare prefix test.
    if (escapesDir(realDist, abs)) {
      sendJson(res, 400, { error: 'invalid asset path' })
      return
    }

    // Lexical confinement is not enough: readFile follows symlinks, so a link
    // inside dist/ would serve a file from anywhere. Workspace.confineReal
    // resolves symlinks for documents; the asset layer must agree rather than
    // being the weaker of the two.
    let real: string
    try {
      real = await fsp.realpath(abs)
    } catch {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (escapesDir(realDist, real)) {
      sendJson(res, 400, { error: 'invalid asset path' })
      return
    }

    try {
      const body = await fsp.readFile(real)
      res.writeHead(200, {
        'content-type':
          CONTENT_TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        // The bundle is ours, but these cost nothing and keep a stray asset from
        // being sniffed into something executable.
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(body)
    } catch {
      sendJson(res, 404, { error: 'not found' })
    }
  }

  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    if (!originAllowed(req)) {
      sendJson(res, 403, { error: 'origin not allowed' })
      return
    }
    if (!tokenAllowed(req)) {
      sendJson(res, 401, { error: 'missing or invalid token' })
      return
    }

    if (url.pathname === '/api/workspace' && req.method === 'GET') {
      sendJson(res, 200, { files: workspace.list(), active: workspace.active })
      return
    }

    if (url.pathname === '/api/doc' && req.method === 'GET') {
      const relPath = url.searchParams.get('path')
      if (relPath === null) {
        sendJson(res, 400, { error: 'missing path parameter' })
        return
      }
      sendJson(res, 200, await workspace.read(relPath))
      return
    }

    if (url.pathname === '/api/doc' && req.method === 'PUT') {
      const raw = await readBody(req)
      let parsed: { relPath?: unknown; content?: unknown; baseMtimeMs?: unknown }
      try {
        parsed = JSON.parse(raw) as typeof parsed
      } catch {
        sendJson(res, 400, { error: 'body must be JSON' })
        return
      }
      if (typeof parsed.relPath !== 'string' || typeof parsed.content !== 'string') {
        sendJson(res, 400, { error: 'relPath and content are required strings' })
        return
      }
      // Validate rather than coerce. `Number(x)` turns a non-numeric body field
      // into NaN, and NaN compares false against every conflict check — which
      // would let a request overwrite a document without knowing its mtime.
      // Workspace.write also guards this; rejecting here keeps the 400 honest.
      let base: number | null
      if (parsed.baseMtimeMs === null || parsed.baseMtimeMs === undefined) {
        base = null
      } else if (typeof parsed.baseMtimeMs === 'number' && Number.isFinite(parsed.baseMtimeMs)) {
        base = parsed.baseMtimeMs
      } else {
        sendJson(res, 400, { error: 'baseMtimeMs must be null or a finite number' })
        return
      }
      try {
        sendJson(res, 200, await workspace.write(parsed.relPath, parsed.content, base))
      } catch (err) {
        if (err instanceof ConflictError) {
          // Re-read to hand the client their version. If it vanished entirely,
          // there is no "theirs" to send — report the conflict without content.
          try {
            const theirs = await workspace.read(parsed.relPath)
            sendJson(res, 409, {
              error: err.message,
              theirContent: theirs.content,
              theirMtimeMs: theirs.mtimeMs,
            })
          } catch {
            sendJson(res, 409, { error: err.message, theirContent: null, theirMtimeMs: null })
          }
          return
        }
        throw err
      }
      return
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    sendJson(res, 404, { error: 'unknown endpoint' })
  }

  const server = http.createServer((req, res) => {
    // Parse defensively. This runs synchronously inside the listener, so a throw
    // here is NOT caught by done.catch below — it becomes an uncaughtException and
    // kills the CLI mid-session. A request target the WHATWG parser rejects (e.g.
    // `GET //[::1`, reachable over a raw socket) did exactly that.
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${host}`)
    } catch {
      sendJson(res, 400, { error: 'malformed request target' })
      return
    }

    const done = url.pathname.startsWith('/api/')
      ? handleApi(req, res, url)
      : serveStatic(res, url.pathname)

    done.catch((err: unknown) => {
      // Classify first so the operator still learns about an unexpected failure
      // even when the response is already partly on the wire and only res.end()
      // is possible below.
      const isExpected =
        err instanceof BadRequestError || err instanceof PathError || err instanceof NotFoundError
      if (!isExpected) {
        log(`unhandled request error: ${err instanceof Error ? err.message : String(err)}`)
      }

      // Never write headers twice, whatever the failure was.
      if (res.headersSent) {
        res.end()
        return
      }
      if (err instanceof BadRequestError) {
        sendJson(res, err.status, { error: err.message })
        return
      }
      if (err instanceof PathError) {
        sendJson(res, 400, { error: err.message })
        return
      }
      // A missing document is a routine 404, not a server fault. Without this the
      // workspace's NotFoundError would surface as a 500.
      if (err instanceof NotFoundError) {
        sendJson(res, 404, { error: err.message })
        return
      }
      // Already logged above. Never return the detail: raw errno messages embed
      // absolute paths (Workspace.write lets EACCES through from fs.writeFile),
      // which would disclose where the workspace lives.
      sendJson(res, 500, { error: 'internal server error' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, resolve)
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port')
  }
  const port = address.port
  origin = `http://${host}:${port}`

  return {
    origin,
    port,
    token,
    url: `${origin}/?t=${token}`,
    notify(event: WatchEvent): void {
      const frame = `data: ${JSON.stringify(event)}\n\n`
      for (const client of clients) client.write(frame)
    },
    async close(): Promise<void> {
      for (const client of clients) client.end()
      clients.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
