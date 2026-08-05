/**
 * Serve `dist/` the way Vercel serves it in production, including the rewrites
 * from `vercel.json`.
 *
 * `vite preview` serves the raw directory, so the landing page is only reachable
 * at `/site/` — a URL production never uses. That gap hid a real bug: the hero
 * image was referenced relatively, which resolves correctly from `/site/` and
 * 404s from `/`, where the rewrite actually puts the page. It shipped broken and
 * the e2e suite stayed green.
 *
 * So this mirrors the routing instead:
 *
 *   /            -> dist/site/index.html   (the landing page, as on better-md.dev)
 *   /app/        -> dist/app/index.html    (the editor, as on playground.better-md.dev)
 *   anything else -> the file on disk, or 404
 *
 * Usage: node scripts/preview-routed.mjs [--port 4173]
 */
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

const DIST = path.resolve(import.meta.dirname, '..', 'dist')

const portFlag = process.argv.indexOf('--port')
const port = portFlag === -1 ? 4173 : Number(process.argv[portFlag + 1])
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`--port must be an integer 0-65535, got ${process.argv[portFlag + 1]}`)
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.sh': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** Same shape as vercel.json's rewrites, minus the host matching. */
function rewrite(pathname) {
  if (pathname === '/') return '/site/index.html'
  if (pathname === '/app' || pathname === '/app/') return '/app/index.html'
  if (pathname === '/site' || pathname === '/site/') return '/site/index.html'
  return pathname
}

const server = http.createServer(async (req, res) => {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  } catch {
    res.writeHead(400).end('bad request')
    return
  }

  const target = rewrite(pathname)
  const file = path.join(DIST, target)

  // Confine to dist/: this is a dev tool, but it still should not serve the repo.
  if (!file.startsWith(DIST + path.sep)) {
    res.writeHead(403).end('forbidden')
    return
  }

  try {
    const body = await fs.readFile(file)
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`dist/ served with production routing on http://127.0.0.1:${port}/\n`)
  process.stdout.write(`  /      landing page\n  /app/  editor\n`)
})
