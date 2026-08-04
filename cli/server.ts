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
    if (total > limitBytes) throw new Error('request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { workspace, distDir } = options
  const host = options.host ?? '127.0.0.1'
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
    const match = /^Bearer (.+)$/.exec(header)
    if (match === null) return false
    return timingSafeEqualStr(match[1], token)
  }

  async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
    const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1))
    const abs = path.resolve(realDist, relative)
    const rel = path.relative(realDist, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      sendJson(res, 400, { error: 'invalid asset path' })
      return
    }
    try {
      const body = await fsp.readFile(abs)
      res.writeHead(200, {
        'content-type':
          CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
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
    const url = new URL(req.url ?? '/', `http://${host}`)
    const done = url.pathname.startsWith('/api/')
      ? handleApi(req, res, url)
      : serveStatic(res, url.pathname)

    done.catch((err: unknown) => {
      // This handler is the last line of defence for the request: nothing
      // downstream awaits or catches its own errors, so if sendJson itself
      // threw (e.g. the client already disconnected and the socket can no
      // longer be written to) it would become an unhandled rejection capable
      // of taking the whole server down. Swallow that rather than propagate it
      // — there is no one left to answer.
      try {
        if (err instanceof PathError) {
          sendJson(res, 400, { error: err.message })
          return
        }
        // A missing document is a routine 404, not a server fault. Without this
        // the workspace's NotFoundError would surface as a 500.
        if (err instanceof NotFoundError) {
          sendJson(res, 404, { error: err.message })
          return
        }
        // Anything else is unexpected — most concretely a raw errno that
        // Workspace.write() lets escape (e.g. EACCES writing a mode-444
        // document). Node's fs error messages embed the absolute on-disk path,
        // so forwarding `err.message` to the client would disclose where the
        // workspace lives. Log the detail for the operator (never the token —
        // this branch only ever sees fs/parsing failures, not request headers)
        // and answer the client with a message that reveals nothing about the
        // filesystem.
        const detail = err instanceof Error ? err.message : String(err)
        process.stderr.write(`better-md: unhandled request error: ${detail}\n`)
        if (res.headersSent) return
        sendJson(res, 500, { error: 'internal server error' })
      } catch {
        // The response can no longer be written to; nothing more to do.
      }
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
